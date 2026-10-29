/**
 * The realtime path of a room (architecture section 5): `enter` subscribes a socket to a
 * room and answers its first snapshot; `cmd` runs one domain command through the runner
 * (queue → load → `apply` → compare-and-set) and sends every socket of the room its own
 * snapshot; a timeout per room reveals at the deadline when nobody acts.
 *
 * Secrecy: every snapshot is `toSnapshot(state, viewer, …)` for the socket's own user,
 * and no log line here holds a command's payload (a card) or a room code (a bearer
 * capability, architecture section 11): only the room's id, the command type, the
 * version and the answer's code. The Socket.IO channel of a room is named by its id too.
 *
 * One room per socket: the `enter`s of a socket run one after the other, a `cmd` waits
 * for the `enter` in progress, and `socket.data.room` is set only once every check of an
 * `enter` passed.
 *
 * Presence (#17, architecture section 9): a person is connected while at least one of
 * their sockets has entered the room on this instance. When the last one goes, a grace
 * timer runs; when it fires, the server's own `presence` command marks them away through
 * the runner. A socket that enters again cancels the grace, and brings back a person the
 * room shows as away. Both decide in the room's queue, from the state stored then; a new
 * state is stored only when presence changes.
 *
 * A room with a password (#31) lets in its participants, its PO and the users holding a
 * grant (`room_access`); anyone else's `enter` is refused with `password_required`, and
 * a socket that has not passed that gate never gets a snapshot of it. When the PO sets or
 * changes the password (`changePassword`, from the HTTP API), the sockets of everyone else
 * hear `locked` and leave the room; a kick drops the removed person's grant.
 *
 * History (#33): `history` answers one page of the entered room's finished rounds to
 * someone in it (a voter, an observer or the PO), checked on a fresh load at every
 * request; the round on the table is left out.
 *
 * Several instances (#39, `shared`): every instance sends its own sockets their own
 * snapshots, as with one. A change tells the other instances `roomChanged` (the room's id,
 * the version, the causes, whether a new password locked visitors out); an instance with
 * sockets in that room loads it from Postgres and broadcasts it, so no state and no card
 * ever crosses Redis. A grace that runs out first asks the other instances whether the
 * person is still there, a state that shows someone away who is here is mended, and a
 * sweep starts the grace of people no instance holds (their instance stopped). Command
 * ids are claimed in Redis (`shared-acks.ts`), so a resend to another instance never runs
 * twice. Deadlines need nothing more: each instance arms its own, and the compare-and-set
 * reveals once; a server run that changed nothing broadcasts nothing, since the instance
 * that changed it tells everyone, with the causes.
 */
import { type ApplyResult, apply, type Cause, type Command, type RoomState } from "@pp/domain";
import {
  type CmdAck,
  type EnterAck,
  type EnterPayload,
  HISTORY_PAGE,
  type HistoryAck,
  type HistoryRequest,
  type Snapshot,
  toSnapshot,
} from "@pp/protocol";
import { DatabaseError } from "../db/errors.ts";
import { historyView } from "../db/history.ts";
import type { AccessStore, AccessWrite, HistoryStore, RoomStore } from "../db/rooms.ts";
import type { CommandRunner, RunOutcome } from "../db/runner.ts";
import type { Logger } from "../logger.ts";
import type { RealtimeHandlers, RealtimeServer, RealtimeSocket } from "../realtime.ts";
import { CLUSTER_REQUEST_TIMEOUT_MS } from "../scale-out.ts";
import { createDeadlineTimers, type DeadlineTimers } from "./deadlines.ts";
import {
  createGraceTimers,
  type GraceTimers,
  PRESENCE_GRACE_MS,
  PRESENCE_RESTART_GRACE_MS,
} from "./presence.ts";
import { ackKey, createRecentAcks, type RecentAcksOptions } from "./recent-acks.ts";
import { type Claim, type SharedAcks, sharedAckKey, within } from "./shared-acks.ts";

/** The actor of the server's own `timeUp` and `presence`: `apply` lets anyone send them. */
export const SERVER_ACTOR = ":server";
const TIME_UP: Command = { type: "timeUp" };

/**
 * How many times an away run that failed (a database error, or every attempt lost the
 * compare-and-set) starts the grace again before the person is left shown connected.
 */
export const MAX_AWAY_RETRIES = 3;

/** A command re-checks the socket's session once its last check is older than this. */
export const SESSION_RECHECK_MS = 60_000;

/**
 * With several instances: how often each looks for people its rooms show connected whom
 * no instance holds (their instance stopped without them coming back), to start their
 * grace. A disconnect on a running instance starts it at once, as with one instance.
 */
export const PRESENCE_SWEEP_MS = 30_000;

/**
 * With several instances: how long a version waits, at most, for the signals of the
 * versions before it that another instance wrote, so their causes go out with it. Past
 * it, it goes out with the causes it has, and the password gate checks every visitor's
 * grant before they get it. Only a version that skips a signal waits; one instance never.
 */
export const GAP_WAIT_MS = 100;
/** The same for a newer state a server run found unchanged (nobody waits on its answer). */
export const UNSIGNALLED_WAIT_MS = 500;
/** How often a room is loaded again for a change Postgres does not show yet, at most. */
const MAX_RELOADS = 5;
const RELOAD_BACKOFF_MS = 100;
/** How long a command's answer waits, at most, for its snapshot to go out first. */
const DELIVERY_WAIT_MAX_MS = 1_000;
const DONE: Promise<void> = Promise.resolve();

/** What an instance tells the others when it changed a room (#39). */
export interface RoomSignal {
  /** The room's id, never its code. */
  room: string;
  version: number;
  causes: readonly Cause[];
  /** A new password: the visitors without a grant leave, as on the instance that set it. */
  lockout?: true;
}

/** Several instances behind one address (#39, `scale-out.ts`). */
export interface SharedOptions {
  acks: SharedAcks;
  /** How long a question to the other instances may take; `CLUSTER_REQUEST_TIMEOUT_MS`. */
  requestTimeoutMs?: number;
  /** For tests only: `PRESENCE_SWEEP_MS` otherwise. */
  sweepMs?: number;
}

export interface RoomSyncOptions {
  runner: CommandRunner;
  store: Pick<RoomStore, "loadRoom">;
  /**
   * The grants of rooms with a password (#31). Left out, nobody holds one (tests without
   * a database): only participants and the PO enter such a room.
   */
  access?: Pick<AccessStore, "hasAccess">;
  /**
   * The room's finished rounds (#33). Left out (tests without a database), every room's
   * history is empty.
   */
  history?: Pick<HistoryStore, "loadHistory">;
  logger: Logger;
  /**
   * Whether the socket's session still exists (`sessionChecker` in `auth.ts`). Asked on
   * every `enter`, and by a command once the last check is `SESSION_RECHECK_MS` old; left
   * out, the handshake's session is trusted (tests without identity).
   */
  sessionAlive?: (sessionId: string) => Promise<boolean>;
  /**
   * Records a visit to a room (by id) for the retention purge (#35): an `enter` that
   * succeeded calls it without waiting, and a failure only logs. Left out, nothing is kept.
   */
  touchRoom?: (roomId: string) => Promise<void>;
  /** Epoch milliseconds, for `apply` and the snapshots; `Date.now` by default. */
  now?: () => number;
  recentAcks?: Omit<RecentAcksOptions, "forget">;
  /**
   * For tests only: how long a person may be gone before they show as away.
   * `PRESENCE_GRACE_MS` (15 s, architecture section 9) otherwise.
   */
  presenceGraceMs?: number;
  /**
   * For tests only: the grace of the people a room shows as connected when its first
   * socket reaches this instance (after a restart). `PRESENCE_RESTART_GRACE_MS` (60 s).
   */
  presenceRestartGraceMs?: number;
  /**
   * For tests only: false arms no deadline timeout, so only a command or a client's
   * `timeUp` ping resolves a deadline (architecture section 9). True by default.
   */
  deadlineTimeouts?: boolean;
  /**
   * Several instances (#39): the command ids shared through Redis. Set, the room sync
   * also talks to the other instances through the Socket.IO adapter (`roomChanged`,
   * `present`, `occupied`). Left out (one instance), it never does.
   */
  shared?: SharedOptions;
}

export interface RoomSync extends RealtimeHandlers {
  history(socket: RealtimeSocket, request: HistoryRequest): Promise<HistoryAck>;
  attach(io: RealtimeServer): void;
  disconnect(socket: RealtimeSocket): void;
  /** Clears every deadline timeout; the server is shutting down. */
  close(): void;
  /**
   * The rooms (by id) with a socket on this instance, and on every other one when shared:
   * the retention purge keeps them. Rejects when another instance does not answer.
   */
  occupiedRooms(): Promise<string[]>;
  /** For tests: the deadline armed for a room (by id) on this instance. */
  deadlines: Pick<DeadlineTimers, "armed">;
  /** For tests: whether a person's presence grace runs in a room (by id) on this instance. */
  presence: Pick<GraceTimers, "pending">;
  /**
   * The PO (`actor`) sets or changes the room's password to `hash`, or removes it (null),
   * through the room's queue like any command (#31): the flag, the hash and the grants
   * land in one transaction, everyone in the room then is granted, and the sockets of
   * anyone else, on every instance, hear `locked` and leave. `not_owner` for anyone else.
   */
  changePassword(code: string, actor: string, hash: string | null): Promise<CmdAck>;
}

/** The Socket.IO room of a room, by its id (never its code). */
const CHANNEL_PREFIX = "room:";
export const channelOf = (roomId: string) => `${CHANNEL_PREFIX}${roomId}`;

/** A room as this instance knows it: the id for channels and logs, the code for loads. */
interface RoomRef {
  id: string;
  code: string;
}

/** Shared: a state to send once the signals of the versions before it are in, or at `deadline`. */
interface Candidate {
  version: number;
  state: RoomState;
  /** `performance.now()` past which it goes out with the causes it has. */
  deadline: number;
}

type ApplyRun = RunOutcome<ReturnType<typeof apply>>;

/** How a run of the server's own command ended: `failed` stored nothing it knows of. */
type ServerRun = "changed" | "unchanged" | "failed";

/** A `roomChanged` from another instance, checked: Redis is a network service. */
export function parseSignal(raw: unknown): RoomSignal | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const { room, version, causes, lockout } = raw as Record<string, unknown>;
  if (typeof room !== "string" || room === "" || room.length > 64) return undefined;
  if (typeof version !== "number" || !Number.isSafeInteger(version) || version < 1) {
    return undefined;
  }
  if (!Array.isArray(causes) || causes.length > 64) return undefined;
  const typed = causes.every(
    (cause: unknown) =>
      typeof cause === "object" &&
      cause !== null &&
      typeof (cause as { type?: unknown }).type === "string",
  );
  if (!typed) return undefined;
  return { room, version, causes: causes as Cause[], ...(lockout === true && { lockout }) };
}

/** The other instances' answers to `present` or `occupied`: lists of ids, all of them. */
function idsIn(responses: unknown): string[] {
  if (!Array.isArray(responses)) throw new Error("bad answer");
  const ids: string[] = [];
  for (const response of responses) {
    if (!Array.isArray(response)) throw new Error("bad answer");
    for (const id of response) if (typeof id === "string") ids.push(id);
  }
  return ids;
}

const refuse = <C extends Extract<CmdAck, { ok: false }>["code"]>(code: C) =>
  ({ ok: false, code }) as const;

/** In the room, or its PO: lets in whatever the password (#31). */
const isMember = (state: RoomState, who: string) =>
  who === state.ownerId || Object.hasOwn(state.participants, who);

/**
 * The grants a step's result writes (#31): a kick drops the removed person's grant, so
 * they must type the password again (AC 3). None when nobody was kicked.
 */
function kickRevokes(result: ApplyResult): ApplyResult & { access?: AccessWrite } {
  if (!result.ok) return result;
  const kicked = result.causes.flatMap((cause) => (cause.type === "kicked" ? [cause.who] : []));
  return kicked.length === 0 ? result : { ...result, access: { revoke: kicked } };
}

/**
 * A join by someone the password gate must let in (#31: neither in the room nor its PO,
 * while it has a password) commits only with their grant: the check runs in the commit's
 * transaction, after any kick or new password that dropped it, on every instance.
 */
function joinNeedsGrant(
  state: RoomState,
  actor: string,
  command: Command,
  result: ApplyResult & { access?: AccessWrite },
): ApplyResult & { access?: AccessWrite } {
  if (command.type !== "join" || !result.ok || result.state === state) return result;
  if (!state.hasPassword || isMember(state, actor)) return result;
  return { ...result, access: { ...result.access, requireGrant: actor } };
}

/** The answer to a socket that disconnected mid-`enter`: it never reaches anyone. */
const GONE = refuse("internal");

export function createRoomSync(options: RoomSyncOptions): RoomSync {
  const { runner, store, logger, sessionAlive, touchRoom, now = Date.now, shared } = options;
  const requestTimeoutMs = shared?.requestTimeoutMs ?? CLUSTER_REQUEST_TIMEOUT_MS;
  const hasAccess = options.access?.hasAccess ?? (async () => false);
  const loadHistory =
    options.history?.loadHistory ?? (async () => ({ rounds: [], more: false }) as const);
  const log = logger.child({ part: "rooms" });
  // A `busy` answer stored nothing: the same command id may run again.
  const acks = createRecentAcks({
    ...options.recentAcks,
    forget: (ack) => !ack.ok && ack.code === "busy",
  });
  /** The id behind each code, and back, for the rooms with a socket on this instance. */
  const idOf = new Map<string, string>();
  const codeOf = new Map<string, string>();
  /** The newest version this instance has seen of each room (by id) it has sockets in. */
  const newest = new Map<string, number>();
  /** The version each socket holds: it never gets the same or an older one again. */
  const held = new WeakMap<RealtimeSocket, number>();
  /** The `enter` a socket has in progress (settled, never rejected). */
  const entering = new WeakMap<RealtimeSocket, Promise<void>>();
  /** When each socket's session was last found alive, and a check under way. */
  const sessionChecked = new WeakMap<RealtimeSocket, number>();
  const pendingChecks = new WeakMap<RealtimeSocket, Promise<boolean>>();
  /**
   * The room (by id) each socket passed the password gate of (#31). A socket still
   * entering sits in the room's channel before that: a room with a password sends it
   * nothing until it passed, unless it belongs to a participant or the PO.
   */
  const admitted = new WeakMap<RealtimeSocket, string>();
  /**
   * How often each room (by id) locked its sockets out for a new password (#31). An enter
   * that read a grant before a lockout ran read the old password's grant, which the
   * change dropped: it sees the count move, and is refused.
   */
  const lockouts = new Map<string, number>();
  const deadlines = createDeadlineTimers(
    options.deadlineTimeouts === false
      ? () => {}
      : (id) => void runAsServer(id, () => TIME_UP, "deadline", "timeUp"),
    {
      now,
    },
  );
  const graces = createGraceTimers(
    (id, who) => void markAway(id, who),
    options.presenceGraceMs ?? PRESENCE_GRACE_MS,
  );
  const restartGraceMs = options.presenceRestartGraceMs ?? PRESENCE_RESTART_GRACE_MS;
  /** The rooms (by id) whose presence this instance follows: those it has sockets in. */
  const watched = new Set<string>();
  /** The newest state seen of each room (by id) with sockets here. */
  const stateOf = new Map<string, RoomState>();
  /**
   * Shared: per room (by id), the changes (by version) this instance has yet to send its
   * sockets: the other instances' signals, and its own commits waiting for one of them.
   */
  const inbox = new Map<string, Map<number, RoomSignal>>();
  /** Shared: per room, the newest state this instance holds but has not sent yet. */
  const candidates = new Map<string, Candidate>();
  /** Shared: per room, the version last sent to its sockets here, and its password flag. */
  const sent = new Map<string, { version: number; hasPassword: boolean }>();
  /** Shared: the rooms (by id) whose inbox is being sent. */
  const draining = new Set<string>();
  /** Shared: per room, what wakes its delivery loop while it waits (a signal came). */
  const wakers = new Map<string, () => void>();
  /** Shared: per room, the command answers waiting for their version to go out. */
  const waiters = new Map<string, Set<{ version: number; finish: () => void }>>();
  /** Shared: the sockets whose grant is being read again; they get nothing meanwhile. */
  const rechecking = new WeakSet<RealtimeSocket>();
  /** Shared: the people (`room who`) whose stored away is being mended. */
  const mending = new Set<string>();
  let sweeper: ReturnType<typeof setInterval> | undefined;
  let sweeping = false;
  /** Per room (by id): how many away runs of each person failed in a row. */
  const awayFailures = new Map<string, Map<string, number>>();
  /** Shutting down: no new grace starts. */
  let closed = false;
  let io: RealtimeServer | undefined;

  /** The sockets of a room (by id) on this instance. */
  function socketsOf(id: string): RealtimeSocket[] {
    const ids = io?.sockets.adapter.rooms.get(channelOf(id));
    if (!io || !ids) return [];
    const sockets: RealtimeSocket[] = [];
    for (const socketId of ids) {
      const socket = io.sockets.sockets.get(socketId);
      if (socket) sockets.push(socket);
    }
    return sockets;
  }

  /**
   * Records `version` as the room's newest if it is; false when a newer one is known (an
   * answer that arrives late). The deadline follows the newest state only.
   */
  function advance(id: string, version: number, state: RoomState, entering?: string): boolean {
    if (version < (newest.get(id) ?? 0)) return false;
    newest.set(id, version);
    stateOf.set(id, state);
    armDeadline(id, state);
    // The person entering gets their own back step (`presenceOnEnter`).
    if (shared) mendPresence(id, state, entering);
    return true;
  }

  /** Whether the newest state seen of the room (by id) has the person in it. */
  const knows = (id: string, who: string) => {
    const state = stateOf.get(id);
    return state !== undefined && Object.hasOwn(state.participants, who);
  };

  /**
   * Sends every socket of the room its own snapshot of `state`, except those that already
   * hold this version or a newer one. A late, older state goes nowhere. `blind` (shared):
   * versions before this one came without their signal, so a lockout or a kick may have
   * been missed; in a room with a password, every visitor's grant is read again before
   * they get anything (`recheck`).
   */
  function broadcast(
    room: RoomRef,
    version: number,
    state: RoomState,
    causes: readonly Cause[],
    blind = false,
  ) {
    const sockets = socketsOf(room.id);
    if (sockets.length === 0 || !advance(room.id, version, state)) return;
    if (shared) sent.set(room.id, { version, hasPassword: state.hasPassword === true });
    const meta = { code: room.code, version, now: now(), causes };
    // Two tabs of one person get the same snapshot: build it once per viewer.
    const views = new Map<string, Snapshot>();
    for (const socket of sockets) {
      const viewer = socket.data.user?.id;
      if (viewer === undefined || (held.get(socket) ?? 0) >= version) continue;
      if (rechecking.has(socket)) continue;
      if (state.hasPassword && !isMember(state, viewer)) {
        if (admitted.get(socket) !== room.id) continue;
        if (blind) {
          recheck(room.id, socket, viewer);
          continue;
        }
      }
      let view = views.get(viewer);
      if (!view) {
        view = toSnapshot(state, viewer, meta);
        views.set(viewer, view);
      }
      held.set(socket, version);
      socket.emit("snapshot", view);
    }
  }

  function armDeadline(id: string, state: RoomState) {
    const round = state.round;
    deadlines.set(id, round?.phase === "voting" ? round.deadlineAt : undefined);
  }

  /**
   * After a run: broadcast what is new, remove the people it kicked, and tell the other
   * instances (shared). `serverRun`: the server's own run, which nobody waits on.
   * `lockout`: the run set a new password, and `lockOut` already ran here. Resolves once
   * the snapshot went out (at once with one instance), so the answer follows it.
   */
  function publish(
    room: RoomRef,
    outcome: Extract<ApplyRun, { ok: true }>,
    { serverRun = false, lockout = false } = {},
  ): Promise<void> {
    const { result } = outcome;
    if (shared) {
      if (outcome.changed) {
        tellOthers({
          room: room.id,
          version: outcome.version,
          causes: result.causes,
          ...(lockout && { lockout: true as const }),
        });
        if (codeOf.get(room.id) === room.code) {
          addSignal(room.id, { room: room.id, version: outcome.version, causes: result.causes });
        }
      }
      // A newer state found unchanged was written by another instance: its signal brings
      // the causes. A server run waits longer for it, since nobody waits on its answer.
      // Measured against what the sockets here were sent, not what an `enter` loaded: the
      // others may still lack it (a socket that entered meanwhile gets nothing twice, since
      // it holds the version; the client drops a version it holds anyway).
      const wait = serverRun && !outcome.changed ? UNSIGNALLED_WAIT_MS : GAP_WAIT_MS;
      return offerAndDrain(room, outcome.version, result.state, wait);
    }
    if (!outcome.changed) {
      // The loaded state may still be newer than what this instance sent (a lost reply).
      // Its causes are unknown here, so it goes out without any. A version this instance
      // already knows goes nowhere: a socket still entering (in the channel, no version
      // held yet) gets it with its answer, and would get it twice.
      if (outcome.version > (newest.get(room.id) ?? 0)) {
        broadcast(room, outcome.version, result.state, []);
      }
      return DONE;
    }
    broadcast(room, outcome.version, result.state, result.causes);
    for (const cause of result.causes) {
      if (cause.type === "kicked") removeKicked(room.id, cause.who);
    }
    return DONE;
  }

  // ------------------------------------------------------------- several instances (#39)

  /** Tells the other instances that a room changed (shared only). */
  function tellOthers(signal: RoomSignal) {
    if (!shared || closed || !io) return;
    io.serverSideEmit("roomChanged", signal);
  }

  /**
   * Another instance changed a room. One this instance has no socket in is none of its
   * business; a socket still entering counts (its `enter` sends the inbox once it knows
   * the room's code), so a change committed during the enter is not missed.
   */
  function onRoomChanged(raw: unknown) {
    const signal = parseSignal(raw);
    if (!signal) {
      log.warn("cluster: a room change was not understood");
      return;
    }
    const id = signal.room;
    try {
      if (!codeOf.has(id) && socketsOf(id).length === 0) return;
      addSignal(id, signal);
      if (codeOf.has(id)) drain(id);
    } catch (error) {
      log.warn({ room: id, err: errorCodeOf(error) }, "cluster: a room change failed");
    }
  }

  /**
   * Puts a change in the room's inbox. A second one for the same version (a reconnect's
   * resync, or a resend) is merged: a lockout stays, and causes are kept, never emptied.
   */
  function addSignal(id: string, signal: RoomSignal) {
    let box = inbox.get(id);
    if (!box) {
      box = new Map();
      inbox.set(id, box);
    }
    const known = box.get(signal.version);
    const lockout = known?.lockout || signal.lockout;
    box.set(signal.version, {
      room: id,
      version: signal.version,
      causes: known && known.causes.length > 0 ? known.causes : signal.causes,
      ...(lockout && { lockout: true as const }),
    });
    wakers.get(id)?.();
  }

  /** The version last sent to the room's sockets here (shared). */
  const sentVersion = (id: string) => sent.get(id)?.version ?? 0;

  /** Offers a state to send; the newest one wins, and the earliest deadline. */
  function offer(id: string, version: number, state: RoomState, waitMs: number) {
    const current = candidates.get(id);
    const deadline = Math.min(current?.deadline ?? Infinity, performance.now() + waitMs);
    if (current && current.version >= version) {
      current.deadline = deadline;
      return;
    }
    candidates.set(id, { version, state, deadline });
  }

  /** Offers a state of a room with sockets here, and resolves once it went out. */
  function offerAndDrain(room: RoomRef, version: number, state: RoomState, waitMs: number) {
    // This instance holds no socket of the room (a password set over HTTP): nothing to send.
    if (codeOf.get(room.id) !== room.code || version <= sentVersion(room.id)) return DONE;
    offer(room.id, version, state, waitMs);
    drain(room.id);
    return delivered(room.id, version);
  }

  /** Starts the room's delivery loop, or wakes the one that waits. */
  function drain(id: string) {
    if (draining.has(id)) {
      wakers.get(id)?.();
      return;
    }
    void drainInbox(id);
  }

  /** Resolves after `ms`, or as soon as a change of the room comes in. */
  function waitForChange(id: string, ms: number): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        if (wakers.get(id) === done) wakers.delete(id);
        resolve();
      };
      const timer = setTimeout(done, ms);
      wakers.set(id, done);
    });
  }

  /** Resolves once the room's sockets here were sent `version`, its loop ended, or 1 s. */
  function delivered(id: string, version: number): Promise<void> {
    if (sentVersion(id) >= version || !draining.has(id)) return DONE;
    return new Promise((resolve) => {
      const list = waiters.get(id) ?? new Set();
      waiters.set(id, list);
      const entry = {
        version,
        finish: () => {
          clearTimeout(timer);
          list.delete(entry);
          resolve();
        },
      };
      const timer = setTimeout(entry.finish, DELIVERY_WAIT_MAX_MS);
      list.add(entry);
    });
  }

  function settleWaiters(id: string, upTo = Number.POSITIVE_INFINITY) {
    for (const entry of [...(waiters.get(id) ?? [])]) {
      if (entry.version <= upTo) entry.finish();
    }
    if (waiters.get(id)?.size === 0) waiters.delete(id);
  }

  /**
   * Sends the room's sockets here what changed, one state at a time, with the causes of
   * every version since the last one sent. A version whose signal has not arrived (another
   * instance's change, overtaken by a commit here or by a load) waits for it until the
   * candidate's deadline (`GAP_WAIT_MS`); then it goes out with the causes it has, and in
   * a room with a password every visitor's grant is read again first. A signal for a
   * version sent already brings only its effects (`applyStale`). A load that fails, or
   * that Postgres answers with an older version, is tried again with a backoff, at most
   * `MAX_RELOADS` times. One loop per room; a change that comes in wakes it.
   */
  async function drainInbox(id: string) {
    draining.add(id);
    let reloads = 0;
    try {
      for (;;) {
        const code = codeOf.get(id);
        // Gone, or still entering: that `enter` starts the loop again once it knows the code.
        if (closed || code === undefined) return;
        const box = inbox.get(id);
        const base = sentVersion(id);
        if (box) {
          const stale = [...box.values()].filter((signal) => signal.version <= base);
          for (const signal of stale) box.delete(signal.version);
          if (stale.length > 0) applyStale(id, stale);
        }
        let candidate = candidates.get(id);
        if (candidate && candidate.version <= base) {
          candidates.delete(id);
          candidate = undefined;
        }
        const wanted = box && box.size > 0 ? Math.max(...box.keys()) : 0;
        if (!candidate && wanted === 0) {
          inbox.delete(id);
          return;
        }
        if (!candidate || candidate.version < wanted) {
          const loaded = await loadQuietly(id, code);
          if (codeOf.get(id) !== code) continue;
          if (loaded) offer(id, loaded.version, loaded.state, GAP_WAIT_MS);
          candidate = candidates.get(id);
          if (!candidate || candidate.version < wanted) {
            reloads += 1;
            if (reloads > MAX_RELOADS) {
              giveUp(id, candidate?.version ?? sentVersion(id));
              reloads = 0;
              continue;
            }
            await waitForChange(id, RELOAD_BACKOFF_MS * 2 ** (reloads - 1));
            continue;
          }
        }
        const from = sentVersion(id);
        if (candidate.version <= from) continue;
        const top = candidate.version;
        const covered = [...(inbox.get(id)?.values() ?? [])]
          .filter((signal) => signal.version > from && signal.version <= top)
          .sort((a, b) => a.version - b.version);
        const blind = covered.length < top - from;
        const left = candidate.deadline - performance.now();
        if (blind && left > 0) {
          await waitForChange(id, left);
          continue;
        }
        for (const signal of covered) inbox.get(id)?.delete(signal.version);
        if (candidates.get(id) === candidate) candidates.delete(id);
        deliver({ id, code }, candidate, covered, blind);
        reloads = 0;
      }
    } catch (error) {
      log.warn({ room: id, err: errorCodeOf(error) }, "cluster: room delivery failed");
    } finally {
      draining.delete(id);
      settleWaiters(id);
    }
  }

  /** The room, or undefined when the load failed or found another room under the code. */
  async function loadQuietly(id: string, code: string) {
    try {
      const loaded = await store.loadRoom(code);
      return loaded && loaded.id === id ? loaded : undefined;
    } catch (error) {
      log.warn({ room: id, err: errorCodeOf(error) }, "cluster: room reload failed");
      return undefined;
    }
  }

  /**
   * Sends one state with the causes of the versions it covers. A new password locks the
   * visitors out first, as on the instance that set it: by its signal, or because the last
   * state sent had none (the signal may be late). Kicks go after it, so the removed person
   * sees themselves gone first, unless the state shows them back (they joined again).
   */
  function deliver(
    room: RoomRef,
    candidate: Candidate,
    covered: readonly RoomSignal[],
    missing: boolean,
  ) {
    let { version, state } = candidate;
    let blind = missing;
    // An `enter` loaded a newer state meanwhile: send that one (`broadcast` drops an older),
    // without the signals of the versions past the candidate.
    const known = newest.get(room.id) ?? 0;
    const newer = stateOf.get(room.id);
    if (known > version && newer) {
      version = known;
      state = newer;
      blind = true;
    }
    const before = sent.get(room.id);
    const newPassword = covered.some((signal) => signal.lockout) || before?.hasPassword === false;
    // Blind, `broadcast` reads every visitor's grant instead: one may be newer than the lockout.
    if (state.hasPassword && newPassword && !blind) lockOut(room.id, state);
    broadcast(
      room,
      version,
      state,
      covered.flatMap((signal) => signal.causes),
      blind,
    );
    kickAll(room.id, covered, state);
    settleWaiters(room.id, version);
  }

  /**
   * Signals for versions this instance sent already (late: queued while Redis was away,
   * or overtaken). A kick removes nobody the newest state shows in the room (they joined
   * again since); a lockout reads the visitors' grants again, and only while the room
   * still has a password.
   */
  function applyStale(id: string, signals: readonly RoomSignal[]) {
    const state = stateOf.get(id);
    if (state?.hasPassword && signals.some((signal) => signal.lockout)) recheckAll(id, state);
    kickAll(id, signals, state);
  }

  /**
   * The room could not be loaded for these changes: drop them, failing closed. With no
   * newer state to go by, a lockout or a kick in them applies.
   */
  function giveUp(id: string, upTo: number) {
    const box = inbox.get(id);
    if (!box) return;
    const dropped = [...box.values()].filter((signal) => signal.version > upTo);
    for (const signal of dropped) box.delete(signal.version);
    if (dropped.length === 0) return;
    log.warn({ room: id }, "cluster: room reload given up");
    const state = stateOf.get(id);
    if (state && dropped.some((signal) => signal.lockout)) lockOut(id, state);
    kickAll(id, dropped, undefined);
  }

  /** The kicks in `signals`, but not of someone `state` (when known) shows in the room. */
  function kickAll(id: string, signals: readonly RoomSignal[], state: RoomState | undefined) {
    for (const signal of signals) {
      for (const cause of signal.causes) {
        if (cause.type !== "kicked" || typeof cause.who !== "string") continue;
        if (state && Object.hasOwn(state.participants, cause.who)) continue;
        removeKicked(id, cause.who);
      }
    }
  }

  /** Reads the grant of every visitor (not a member) let in or being let in here. */
  function recheckAll(id: string, state: RoomState) {
    for (const socket of socketsOf(id)) {
      const viewer = socket.data.user?.id;
      if (viewer === undefined || isMember(state, viewer) || admitted.get(socket) !== id) continue;
      recheck(id, socket, viewer);
    }
  }

  /**
   * Reads a visitor's grant again; they get no snapshot meanwhile. Without one (or when it
   * cannot be read) they hear `locked` and leave, as after a new password, and an `enter`
   * in progress is refused; with one they get the newest state. Shared only.
   */
  function recheck(id: string, socket: RealtimeSocket, viewer: string) {
    if (rechecking.has(socket)) return;
    rechecking.add(socket);
    void hasAccess(id, viewer)
      .catch(() => false)
      .then((granted) => {
        rechecking.delete(socket);
        if (!socket.connected || admitted.get(socket) !== id) return;
        const state = stateOf.get(id);
        const version = newest.get(id) ?? 0;
        if (!granted && !(state && isMember(state, viewer))) {
          lockouts.set(id, (lockouts.get(id) ?? 0) + 1);
          admitted.delete(socket);
          if (socket.data.room?.id !== id) return;
          leaveRoom(socket);
          socket.emit("locked");
          return;
        }
        const code = codeOf.get(id);
        if (!state || code === undefined || (held.get(socket) ?? 0) >= version) return;
        if (socket.data.room?.id !== id) return;
        held.set(socket, version);
        socket.emit(
          "snapshot",
          toSnapshot(state, viewer, { code, version, now: now(), causes: [] }),
        );
      });
  }

  /** The people with a socket entered in the room (by id) on this instance. */
  function peopleHere(id: string): string[] {
    const people = new Set<string>();
    for (const socket of socketsOf(id)) {
      const who = socket.data.user?.id;
      if (who !== undefined && socket.connected && socket.data.room?.id === id) people.add(who);
    }
    return [...people];
  }

  /** The people with a socket entered in the room on another instance. Rejects on a timeout. */
  async function presentElsewhere(id: string): Promise<ReadonlySet<string>> {
    if (!shared || !io) return new Set();
    const answers = await within(io.serverSideEmitWithAck("present", id), requestTimeoutMs);
    return new Set(idsIn(answers));
  }

  function localOccupied(): string[] {
    const ids: string[] = [];
    for (const [name, sockets] of io?.sockets.adapter.rooms ?? []) {
      if (sockets.size > 0 && name.startsWith(CHANNEL_PREFIX)) {
        ids.push(name.slice(CHANNEL_PREFIX.length));
      }
    }
    return ids;
  }

  /**
   * A state shows someone away (or gone) whom this instance holds a socket of: another
   * instance marked them away after asking who is here, and their socket entered here
   * right after. Bring them back, one run at a time per person.
   */
  function mendPresence(id: string, state: RoomState, skip?: string) {
    for (const [who, person] of Object.entries(state.participants)) {
      if (who === skip || (person.connected && person.awaySince === undefined)) continue;
      const key = `${id} ${who}`;
      if (mending.has(key) || !isHere(id, who)) continue;
      mending.add(key);
      void runAsServer(id, (current) => backStep(current, id, who), "presence", "back").finally(
        () => mending.delete(key),
      );
    }
  }

  /**
   * Starts the grace of the people a room shows connected whom no instance holds: their
   * instance stopped, so nobody started it. One sweep at a time.
   */
  async function sweep() {
    if (sweeping || closed) return;
    sweeping = true;
    try {
      for (const id of [...watched]) {
        const state = stateOf.get(id);
        if (!state) continue;
        const missing = Object.entries(state.participants)
          .filter(
            ([who, person]) =>
              person.connected &&
              person.awaySince === undefined &&
              !graces.pending(id, who) &&
              !isHere(id, who),
          )
          .map(([who]) => who);
        if (missing.length === 0) continue;
        let elsewhere: ReadonlySet<string>;
        try {
          elsewhere = await presentElsewhere(id);
        } catch {
          continue;
        }
        if (closed || !watched.has(id)) continue;
        // Their instance stopped: the restart grace, as after a redeploy (#15), since their
        // clients reconnect elsewhere at their own pace.
        for (const who of missing) {
          if (!elsewhere.has(who) && !isHere(id, who)) graces.start(id, who, restartGraceMs);
        }
      }
    } finally {
      sweeping = false;
    }
  }

  /** A kicked person's sockets hear `kicked` and are closed (they keep no snapshot feed). */
  function removeKicked(id: string, who: string) {
    for (const socket of socketsOf(id)) {
      if (socket.data.user?.id !== who) continue;
      socket.emit("kicked");
      socket.disconnect(true);
    }
  }

  /**
   * A `DatabaseError` may hide a commit that landed (the reply was lost). Load the room
   * again and send it, so nobody keeps a stale view; never run the command again.
   */
  async function resync(room: RoomRef) {
    try {
      const loaded = await store.loadRoom(room.code);
      if (!loaded) return;
      if (!shared) {
        broadcast(room, loaded.version, loaded.state, []);
        return;
      }
      if (loaded.id !== room.id) return;
      // The lost reply may hide a commit the other instances never heard of.
      tellOthers({ room: room.id, version: loaded.version, causes: [] });
      await offerAndDrain(room, loaded.version, loaded.state, GAP_WAIT_MS);
    } catch (error) {
      log.warn({ room: room.id, err: errorCodeOf(error) }, "room reload failed");
    }
  }

  /**
   * Runs one of the server's own commands on a room (by id) that has a socket here:
   * `timeUp` at a deadline, `presence` after a grace or on enter. `step` builds the command
   * from the stored state when the run's turn comes in the room's queue; it may return
   * null to change nothing. `part` and `what` name the run in log lines.
   */
  async function runAsServer(
    id: string,
    step: (state: RoomState) => Command | null,
    part: "deadline" | "presence",
    what: string,
  ): Promise<ServerRun> {
    const code = codeOf.get(id);
    if (code === undefined || socketsOf(id).length === 0) return "unchanged";
    const room = { id, code };
    try {
      const outcome = await runner.run(code, (state): ApplyResult => {
        const command = step(state);
        return command
          ? apply(state, command, { actor: SERVER_ACTOR, now: now() })
          : { ok: true, state, causes: [] };
      });
      if (outcome.ok) {
        void publish(room, outcome, { serverRun: true });
        return outcome.changed ? "changed" : "unchanged";
      }
      if (outcome.error === "conflict") {
        // Another instance kept writing; its own timer or the next command catches up.
        log.warn({ room: id }, `${part}: every attempt lost the compare-and-set`);
        await resync(room);
        return "failed";
      }
      return "unchanged";
    } catch (error) {
      log.warn({ room: id, err: errorCodeOf(error) }, `${part}: ${what} failed`);
      await resync(room);
      return "failed";
    }
  }

  // ----------------------------------------------------------------------------- presence

  /** Whether one of the person's sockets has entered the room (by id) on this instance. */
  function isHere(id: string, who: string): boolean {
    return socketsOf(id).some(
      (socket) => socket.connected && socket.data.room?.id === id && socket.data.user?.id === who,
    );
  }

  const participant = (state: RoomState, who: string) =>
    Object.hasOwn(state.participants, who) ? state.participants[who] : undefined;

  /**
   * The grace ran out: mark the person away, unless a socket of theirs came back, here or
   * (shared) on another instance, which is asked first; no answer counts as a failed run.
   */
  async function markAway(id: string, who: string) {
    if (!knows(id, who)) return;
    if (shared) {
      let elsewhere: ReadonlySet<string>;
      try {
        elsewhere = await presentElsewhere(id);
      } catch {
        log.warn({ room: id }, "presence: the other instances did not answer");
        retryAway(id, who);
        return;
      }
      if (elsewhere.has(who)) {
        awayFailures.get(id)?.delete(who);
        return;
      }
    }
    // Decided when the run's turn comes: a socket that entered meanwhile keeps them here.
    const outcome = await runAsServer(
      id,
      (state) =>
        participant(state, who) === undefined || isHere(id, who)
          ? null
          : { type: "presence", who, connected: false },
      "presence",
      "away",
    );
    // The room's id only: never a name (or the person's id, which the name follows).
    if (outcome === "changed") log.debug({ room: id }, "presence: away");
    if (outcome === "failed") {
      retryAway(id, who);
    } else {
      awayFailures.get(id)?.delete(who);
    }
  }

  /**
   * An away run failed, so the room still shows the person connected: start the grace
   * again, at most `MAX_AWAY_RETRIES` times in a row. A return, or the room's last socket
   * leaving, ends the series.
   */
  function retryAway(id: string, who: string) {
    const failures = awayFailures.get(id) ?? new Map<string, number>();
    const count = (failures.get(who) ?? 0) + 1;
    if (closed || !watched.has(id) || isHere(id, who) || count > MAX_AWAY_RETRIES) {
      failures.delete(who);
      if (count > MAX_AWAY_RETRIES) log.warn({ room: id }, "presence: away given up");
      return;
    }
    failures.set(who, count);
    awayFailures.set(id, failures);
    graces.start(id, who);
  }

  /** `presence true` when the person is here and the stored state shows them away. */
  function backStep(state: RoomState, id: string, who: string): Command | null {
    const person = participant(state, who);
    if (person === undefined || !isHere(id, who)) return null;
    if (person.connected && person.awaySince === undefined) return null;
    return { type: "presence", who, connected: true };
  }

  /**
   * A socket of `who` entered the room: their grace stops, and a person the room shows as
   * away comes back. The back step runs in the room's queue for every participant who
   * enters, since the state this enter loaded may predate an away run that committed
   * since; it stores nothing when they are connected, so a reload stays free. The first
   * socket of a room on this instance also starts a grace (`restartGraceMs`, 60 s) for
   * everyone the room shows as connected who has no socket here: after a restart their
   * timers are gone, and their clients may take a while to reconnect.
   */
  function presenceOnEnter(room: RoomRef, who: string, state: RoomState) {
    graces.cancel(room.id, who);
    awayFailures.get(room.id)?.delete(who);
    if (participant(state, who) !== undefined) {
      const back = (current: RoomState) => backStep(current, room.id, who);
      void runAsServer(room.id, back, "presence", "back").then((outcome) => {
        if (outcome === "changed") log.debug({ room: room.id }, "presence: back");
      });
    }
    if (watched.has(room.id)) return;
    watched.add(room.id);
    for (const [id, other] of Object.entries(state.participants)) {
      if (id === who || !other.connected || other.awaySince !== undefined) continue;
      if (!isHere(room.id, id)) graces.start(room.id, id, restartGraceMs);
    }
  }

  /**
   * A socket of `who` left the room (closed, entered another room, or lost its session):
   * when it was their last one here, their grace starts. When it was the room's last
   * socket here, `forgetIfEmpty` already dropped every timer of the room instead.
   */
  function presenceOnLeave(id: string, who: string | undefined) {
    if (closed || who === undefined || !watched.has(id)) return;
    if (!knows(id, who) || isHere(id, who)) return;
    graces.start(id, who);
  }

  async function execute(room: RoomRef, actor: string, command: Command): Promise<CmdAck> {
    try {
      const outcome = await runner.run(room.code, (state) =>
        joinNeedsGrant(
          state,
          actor,
          command,
          kickRevokes(apply(state, command, { actor, now: now() })),
        ),
      );
      if (!outcome.ok) {
        log.debug({ room: room.id, cmd: command.type, code: outcome.error }, "command not run");
        return refuse(outcome.error === "conflict" ? "busy" : outcome.error);
      }
      // The snapshot goes out before the answer (the client expects the version it acks).
      await publish(room, outcome);
      const { result } = outcome;
      return result.ok ? { ok: true, version: outcome.version } : refuse(result.error);
    } catch (error) {
      if (!(error instanceof DatabaseError)) throw error;
      log.warn(
        { room: room.id, cmd: command.type, err: error.code },
        "command failed in the database",
      );
      await resync(room);
      return refuse("internal");
    }
  }

  /**
   * Runs a command once across instances (shared): the instance that claims its id runs
   * it and stores the answer; a claim while it runs elsewhere answers `busy` (the client
   * sends it again), and a later one gets the stored answer. Without an answer from Redis
   * the command runs here, as with one instance.
   */
  async function runOnce(
    room: RoomRef,
    actor: string,
    commandId: string,
    command: Command,
  ): Promise<CmdAck> {
    const sharedAcks = shared?.acks;
    if (!sharedAcks) return execute(room, actor, command);
    const key = sharedAckKey(actor, room.id, commandId);
    let claim: Claim;
    try {
      claim = await sharedAcks.claim(key);
    } catch {
      log.warn({ room: room.id }, "redis: command id not shared");
      return execute(room, actor, command);
    }
    if (claim.state === "done") return claim.ack;
    if (claim.state === "running") return refuse("busy");
    let ack: CmdAck | null = null;
    try {
      ack = await execute(room, actor, command);
      return ack;
    } finally {
      // A `busy` stored nothing, and a throw neither: let the id go, so a resend runs.
      const keep = ack && !(!ack.ok && ack.code === "busy") ? ack : null;
      await sharedAcks.settle(key, keep).catch(() => {
        log.warn({ room: room.id }, "redis: command answer not shared");
      });
    }
  }

  /** Leaves the socket's room, if any: no more snapshots, and the room forgets it. */
  function leaveRoom(socket: RealtimeSocket) {
    const room = socket.data.room;
    if (room === undefined) return;
    socket.data.room = undefined;
    held.delete(socket);
    admitted.delete(socket);
    leaveChannel(socket, room.id);
    presenceOnLeave(room.id, socket.data.user?.id);
  }

  function leaveChannel(socket: RealtimeSocket, id: string) {
    void socket.leave(channelOf(id));
    forgetIfEmpty(id);
  }

  function forgetIfEmpty(id: string) {
    if (socketsOf(id).length > 0) return;
    deadlines.clear(id);
    graces.clearRoom(id);
    awayFailures.delete(id);
    lockouts.delete(id);
    watched.delete(id);
    stateOf.delete(id);
    inbox.delete(id);
    candidates.delete(id);
    sent.delete(id);
    newest.delete(id);
    settleWaiters(id);
    // A delivery loop that waits finds the room gone and ends.
    wakers.get(id)?.();
    const code = codeOf.get(id);
    codeOf.delete(id);
    if (code !== undefined && idOf.get(code) === id) idOf.delete(code);
  }

  /**
   * Whether the socket's session is still alive: asked again once the last check is
   * `SESSION_RECHECK_MS` old. Concurrent commands of a socket share one check.
   */
  function sessionStillAlive(socket: RealtimeSocket): Promise<boolean> {
    if (!sessionAlive) return Promise.resolve(true);
    const checked = sessionChecked.get(socket);
    if (checked !== undefined && now() - checked < SESSION_RECHECK_MS) {
      return Promise.resolve(true);
    }
    let check = pendingChecks.get(socket);
    if (!check) {
      const sessionId = socket.data.sessionId;
      check = sessionId === undefined ? Promise.resolve(false) : sessionAlive(sessionId);
      pendingChecks.set(socket, check);
      check.then(
        (alive) => {
          if (alive) sessionChecked.set(socket, now());
          pendingChecks.delete(socket);
        },
        () => pendingChecks.delete(socket),
      );
    }
    return check;
  }

  async function enterNow(socket: RealtimeSocket, code: string): Promise<EnterAck> {
    const user = socket.data.user;
    if (!user) return refuse("unauthenticated");
    if (sessionAlive) {
      const sessionId = socket.data.sessionId;
      const alive = sessionId !== undefined && (await sessionAlive(sessionId));
      if (!socket.connected) return GONE;
      if (!alive) {
        leaveRoom(socket);
        return refuse("unauthenticated");
      }
      sessionChecked.set(socket, now());
    }
    if (socket.data.room !== undefined && socket.data.room.code !== code) leaveRoom(socket);
    // The channel this call joined; left again when the enter fails.
    let joined: string | undefined;
    const undo = () => {
      leaveRoom(socket);
      if (joined !== undefined) leaveChannel(socket, joined);
    };
    const gone = () => {
      undo();
      return GONE;
    };
    try {
      // When the room's id is known here, join before loading: a change committed after
      // the load is broadcast to this socket too. A snapshot older than it holds is dropped.
      const known = idOf.get(code);
      if (known !== undefined) {
        joined = known;
        await socket.join(channelOf(known));
        if (!socket.connected) return gone();
      }
      let loaded = await store.loadRoom(code);
      if (!socket.connected) return gone();
      if (loaded && loaded.id !== joined) {
        if (joined !== undefined) leaveChannel(socket, joined);
        joined = loaded.id;
        await socket.join(channelOf(joined));
        if (!socket.connected) return gone();
        // Joined after the load: load again, so a change committed in between is not missed.
        loaded = await store.loadRoom(code);
        if (!socket.connected) return gone();
      }
      if (!loaded || loaded.id !== joined) {
        undo();
        return refuse("room_not_found");
      }
      // The password gate (#31): a member passes on the state; anyone else needs a grant.
      if (loaded.state.hasPassword && !isMember(loaded.state, user.id)) {
        // This socket sits in the room's channel already, so a lockout from here on finds it.
        const lockedBefore = lockouts.get(loaded.id) ?? 0;
        const granted = await hasAccess(loaded.id, user.id);
        if (!socket.connected) return gone();
        if (!granted) {
          undo();
          return refuse("password_required");
        }
        admitted.set(socket, loaded.id);
        // Snapshots skipped this socket until now: load again, so none is missed.
        loaded = await store.loadRoom(code);
        if (!socket.connected) return gone();
        if (!loaded || loaded.id !== joined) {
          undo();
          return refuse("room_not_found");
        }
        // A new password locked the room out while the grant was read (before this socket
        // had a room to be locked out of): the grant was the old password's.
        if ((lockouts.get(loaded.id) ?? 0) !== lockedBefore) {
          undo();
          return refuse("password_required");
        }
      }
      admitted.set(socket, loaded.id);
      const room = { id: loaded.id, code };
      socket.data.room = room;
      idOf.set(code, room.id);
      codeOf.set(room.id, code);
      advance(room.id, loaded.version, loaded.state, user.id);
      held.set(socket, Math.max(held.get(socket) ?? 0, loaded.version));
      if (shared) {
        // The first socket here: what it holds is what the room's sockets were sent.
        if (!sent.has(room.id)) {
          sent.set(room.id, {
            version: loaded.version,
            hasPassword: loaded.state.hasPassword === true,
          });
        }
        // Changes that came in while this socket entered, before the code was known here.
        if ((inbox.get(room.id)?.size ?? 0) > 0) drain(room.id);
      }
      presenceOnEnter(room, user.id, loaded.state);
      log.debug({ room: room.id, version: loaded.version }, "socket entered");
      touchRoom?.(room.id).catch((error: unknown) => {
        log.warn({ room: room.id, err: errorCodeOf(error) }, "visit not recorded");
      });
      return {
        ok: true,
        snapshot: toSnapshot(loaded.state, user.id, { code, version: loaded.version, now: now() }),
      };
    } catch (error) {
      undo();
      throw error;
    }
  }

  async function cmdNow(socket: RealtimeSocket, id: string, command: Command): Promise<CmdAck> {
    const user = socket.data.user;
    if (!user) return refuse("unauthenticated");
    if (socket.data.room === undefined) return refuse("room_not_found");
    if (!(await sessionStillAlive(socket))) {
      // Signed out, or the user was deleted, while the socket stayed open. The connection
      // closes once the answer is out: the client reconnects, and the handshake refuses
      // the old session, so it signs in again.
      leaveRoom(socket);
      setImmediate(() => socket.conn.close());
      return refuse("unauthenticated");
    }
    const room = socket.data.room;
    if (room === undefined) return refuse("room_not_found");
    if (command.type === "join" && !(await mayJoin(room, user.id))) {
      // The room got a password since this socket entered (on another instance, or in
      // between): the person enters it first.
      if (socket.data.room?.id === room.id) leaveRoom(socket);
      return refuse("password_required");
    }
    // Locked out by a new password while the grant was read: the grant was the old one's.
    if (command.type === "join" && socket.data.room !== room) return refuse("password_required");
    const ack = await acks.remember(user.id, ackKey(room.id, id), () =>
      runOnce(room, user.id, id, command),
    );
    // The grant was gone when the join committed (a kick, a new password): the socket
    // leaves the room, and the person enters the password first.
    if (!ack.ok && ack.code === "password_required" && socket.data.room === room) {
      leaveRoom(socket);
    }
    return ack;
  }

  /**
   * One page of the entered room's history (#33), for someone in it: a voter, an observer
   * or the PO, read from a fresh load, so a removed person or someone still on the join
   * form gets `not_participant` (a socket that never got past the password has no room:
   * `room_not_found`). The round on the table is left out, even with a row of its own.
   */
  async function historyNow(socket: RealtimeSocket, request: HistoryRequest): Promise<HistoryAck> {
    const user = socket.data.user;
    if (!user) return refuse("unauthenticated");
    if (socket.data.room === undefined) return refuse("room_not_found");
    if (!(await sessionStillAlive(socket))) {
      leaveRoom(socket);
      setImmediate(() => socket.conn.close());
      return refuse("unauthenticated");
    }
    const room = socket.data.room;
    if (room === undefined) return refuse("room_not_found");
    try {
      const loaded = await store.loadRoom(room.code);
      if (!loaded || loaded.id !== room.id) return refuse("room_not_found");
      if (!isMember(loaded.state, user.id)) return refuse("not_participant");
      const page = await loadHistory(room.id, {
        before: request.before,
        limit: request.limit ?? HISTORY_PAGE.size,
        exclude: loaded.state.round?.number,
      });
      const rounds = page.rounds.map(historyView);
      const last = rounds.at(-1);
      // The room's id and a count: never a subject, a name or a card.
      log.debug({ room: room.id, rounds: rounds.length }, "history read");
      return page.more && last ? { ok: true, rounds, next: last.number } : { ok: true, rounds };
    } catch (error) {
      if (!(error instanceof DatabaseError)) throw error;
      log.warn({ room: room.id, err: error.code }, "history read failed in the database");
      return refuse("internal");
    }
  }

  /** Whether `who` may join the room now: no password, a member, or a grant (#31). */
  async function mayJoin(room: RoomRef, who: string): Promise<boolean> {
    const loaded = await store.loadRoom(room.code);
    if (!loaded?.state.hasPassword || isMember(loaded.state, who)) return true;
    return hasAccess(loaded.id, who);
  }

  /** The sockets of anyone but a member leave a room that just got a new password (#31). */
  function lockOut(id: string, state: RoomState) {
    lockouts.set(id, (lockouts.get(id) ?? 0) + 1);
    for (const socket of socketsOf(id)) {
      const viewer = socket.data.user?.id;
      if (viewer !== undefined && isMember(state, viewer)) continue;
      admitted.delete(socket);
      if (socket.data.room?.id !== id) continue;
      leaveRoom(socket);
      socket.emit("locked");
    }
  }

  async function changePassword(code: string, actor: string, hash: string | null): Promise<CmdAck> {
    const on = hash !== null;
    try {
      const outcome = await runner.run(code, (state) => {
        const result = apply(state, { type: "password", on }, { actor, now: now() });
        if (!result.ok || result.state === state) return result;
        const people = [...Object.keys(result.state.participants), result.state.ownerId];
        const access: AccessWrite = on
          ? { passwordHash: hash, revokeAll: true, grant: [...new Set(people)] }
          : { passwordHash: null, revokeAll: true };
        return { ...result, access };
      });
      if (!outcome.ok) return refuse(outcome.error === "conflict" ? "busy" : "room_not_found");
      const room = { id: outcome.id, code };
      const lockout = outcome.changed && on;
      if (lockout) lockOut(room.id, outcome.result.state);
      await publish(room, outcome, { lockout });
      const { result } = outcome;
      if (!result.ok) return refuse(result.error);
      if (outcome.changed) log.info({ room: room.id, on }, "room password changed");
      return { ok: true, version: outcome.version };
    } catch (error) {
      if (!(error instanceof DatabaseError)) throw error;
      log.warn({ err: error.code }, "password change failed in the database");
      return refuse("internal");
    }
  }

  return {
    attach(server) {
      io = server;
      if (!shared) return;
      server.on("roomChanged", onRoomChanged);
      // The adapter does not await these: a throw would be an unhandled rejection.
      server.on("present", (roomId, answer) => {
        if (typeof answer !== "function") return;
        try {
          answer(typeof roomId === "string" ? peopleHere(roomId) : []);
        } catch (error) {
          log.warn({ err: errorCodeOf(error) }, "cluster: who is here not answered");
        }
      });
      server.on("occupied", (answer) => {
        if (typeof answer !== "function") return;
        try {
          answer(localOccupied());
        } catch (error) {
          log.warn({ err: errorCodeOf(error) }, "cluster: rooms in use not answered");
        }
      });
      sweeper = setInterval(() => void sweep(), shared.sweepMs ?? PRESENCE_SWEEP_MS);
      sweeper.unref();
    },

    enter(socket, { code }: EnterPayload): Promise<EnterAck> {
      const previous = entering.get(socket);
      const run = previous ? previous.then(() => enterNow(socket, code)) : enterNow(socket, code);
      const settled = run.then(
        () => {},
        () => {},
      );
      entering.set(socket, settled);
      void settled.then(() => {
        if (entering.get(socket) === settled) entering.delete(socket);
      });
      return run;
    },

    cmd(socket, id, command) {
      // A command sent while an `enter` runs waits for it, then goes to the room it entered.
      const pending = entering.get(socket);
      return pending
        ? pending.then(() => cmdNow(socket, id, command))
        : cmdNow(socket, id, command);
    },

    history(socket, request) {
      // Like a command: a request sent while an `enter` runs reads the room it entered.
      const pending = entering.get(socket);
      return pending
        ? pending.then(() => historyNow(socket, request))
        : historyNow(socket, request);
    },

    disconnect(socket) {
      const room = socket.data.room;
      if (room === undefined) return;
      forgetIfEmpty(room.id);
      presenceOnLeave(room.id, socket.data.user?.id);
    },

    close() {
      closed = true;
      clearInterval(sweeper);
      sweeper = undefined;
      inbox.clear();
      candidates.clear();
      for (const id of [...waiters.keys()]) settleWaiters(id);
      for (const wake of [...wakers.values()]) wake();
      deadlines.clearAll();
      graces.clearAll();
    },

    async occupiedRooms() {
      const here = localOccupied();
      if (!shared || !io) return here;
      const answers = await within(io.serverSideEmitWithAck("occupied"), requestTimeoutMs);
      return [...new Set([...here, ...idsIn(answers)])];
    },

    deadlines,
    presence: graces,
    changePassword,
  };
}

function errorCodeOf(error: unknown): string {
  return error instanceof DatabaseError ? error.code : "unknown";
}
