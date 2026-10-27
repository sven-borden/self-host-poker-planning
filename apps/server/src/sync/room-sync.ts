/**
 * The realtime path of a room (architecture section 5): `enter` subscribes a socket to a
 * room and answers its first snapshot; `cmd` runs one domain command through the runner
 * (queue → load → `apply` → compare-and-set) and sends every socket of the room its own
 * snapshot; a timeout per room reveals at the deadline when nobody acts.
 *
 * Secrecy: every snapshot is `toSnapshot(state, viewer, …)` for the socket's own user,
 * and no log line here holds a command's payload (a card): only the room code, the
 * command type, the version and the answer's code.
 */
import { apply, type Command, type RoomState } from "@pp/domain";
import {
  type CmdAck,
  type EnterAck,
  type EnterPayload,
  type Snapshot,
  toSnapshot,
} from "@pp/protocol";
import { DatabaseError } from "../db/errors.ts";
import type { RoomStore } from "../db/rooms.ts";
import type { CommandRunner, RunOutcome } from "../db/runner.ts";
import type { Logger } from "../logger.ts";
import type { RealtimeHandlers, RealtimeServer, RealtimeSocket } from "../realtime.ts";
import { createDeadlineTimers, type DeadlineTimers } from "./deadlines.ts";
import { ackKey, createRecentAcks, RECENT_ACKS_SIZE } from "./recent-acks.ts";

/** The actor of the server's own `timeUp`: `apply` lets anyone send it. */
export const SERVER_ACTOR = ":server";
const TIME_UP: Command = { type: "timeUp" };

export interface RoomSyncOptions {
  runner: CommandRunner;
  store: Pick<RoomStore, "loadRoom">;
  logger: Logger;
  /**
   * Whether the socket's session still exists (`sessionChecker` in `auth.ts`). Asked on
   * every `enter`; left out, the handshake's session is trusted (tests without identity).
   */
  sessionAlive?: (sessionId: string) => Promise<boolean>;
  /** Epoch milliseconds, for `apply` and the snapshots; `Date.now` by default. */
  now?: () => number;
  recentAcks?: number;
}

export interface RoomSync extends RealtimeHandlers {
  attach(io: RealtimeServer): void;
  disconnect(socket: RealtimeSocket): void;
  /** Clears every deadline timeout; the server is shutting down. */
  close(): void;
  /** For tests: the deadline armed for a room on this instance. */
  deadlines: Pick<DeadlineTimers, "armed">;
}

/** The Socket.IO room of a room code. */
export const channelOf = (code: string) => `room:${code}`;

type ApplyRun = RunOutcome<ReturnType<typeof apply>>;

const refuse = <C extends Extract<CmdAck, { ok: false }>["code"]>(code: C) =>
  ({ ok: false, code }) as const;

export function createRoomSync(options: RoomSyncOptions): RoomSync {
  const { runner, store, logger, sessionAlive, now = Date.now } = options;
  const log = logger.child({ part: "rooms" });
  // A `busy` answer stored nothing: the same command id may run again.
  const acks = createRecentAcks(
    options.recentAcks ?? RECENT_ACKS_SIZE,
    (ack) => !ack.ok && ack.code === "busy",
  );
  /** The newest version this instance has sent to a room's sockets. */
  const sent = new Map<string, number>();
  const deadlines = createDeadlineTimers((code) => void timeUp(code), { now });
  let io: RealtimeServer | undefined;

  /** The sockets of a room on this instance. */
  function socketsOf(code: string): RealtimeSocket[] {
    const ids = io?.sockets.adapter.rooms.get(channelOf(code));
    if (!io || !ids) return [];
    const sockets: RealtimeSocket[] = [];
    for (const id of ids) {
      const socket = io.sockets.sockets.get(id);
      if (socket) sockets.push(socket);
    }
    return sockets;
  }

  /**
   * Sends every socket of the room its own snapshot of `state`, unless this instance
   * already sent this version or a newer one (an older answer arriving late, or nothing
   * new). Then arms or clears the room's deadline from `state`.
   */
  function broadcast(code: string, version: number, state: RoomState, causes: Snapshot["causes"]) {
    const sockets = socketsOf(code);
    if (sockets.length === 0) return;
    if (version <= (sent.get(code) ?? 0)) return;
    sent.set(code, version);
    const meta = { code, version, now: now(), causes };
    // Two tabs of one person get the same snapshot: build it once per viewer.
    const views = new Map<string, Snapshot>();
    for (const socket of sockets) {
      const viewer = socket.data.user?.id;
      if (viewer === undefined) continue;
      let view = views.get(viewer);
      if (!view) {
        view = toSnapshot(state, viewer, meta);
        views.set(viewer, view);
      }
      socket.emit("snapshot", view);
    }
    armDeadline(code, state);
  }

  function armDeadline(code: string, state: RoomState) {
    const round = state.round;
    deadlines.set(code, round?.phase === "voting" ? round.deadlineAt : undefined);
  }

  /** After a run: broadcast what is new, and remove the people it kicked. */
  function publish(code: string, outcome: Extract<ApplyRun, { ok: true }>) {
    const { result } = outcome;
    // Unchanged, the loaded state may still be newer than what this instance sent: another
    // instance wrote it. Its causes are unknown here, so it goes out without any.
    broadcast(code, outcome.version, result.state, outcome.changed ? result.causes : []);
    if (!outcome.changed) return;
    for (const cause of result.causes) {
      if (cause.type === "kicked") removeKicked(code, cause.who);
    }
  }

  /** A kicked person's sockets hear `kicked` and are closed (they keep no snapshot feed). */
  function removeKicked(code: string, who: string) {
    for (const socket of socketsOf(code)) {
      if (socket.data.user?.id !== who) continue;
      socket.emit("kicked");
      socket.disconnect(true);
    }
  }

  /**
   * A `DatabaseError` may hide a commit that landed (the reply was lost). Load the room
   * again and send it, so nobody keeps a stale view; never run the command again.
   */
  async function resync(code: string) {
    try {
      const loaded = await store.loadRoom(code);
      if (loaded) broadcast(code, loaded.version, loaded.state, []);
    } catch (error) {
      log.warn({ room: code, err: errorCodeOf(error) }, "room reload failed");
    }
  }

  async function timeUp(code: string) {
    if (socketsOf(code).length === 0) return;
    try {
      const outcome = await runner.run(code, (state) =>
        apply(state, TIME_UP, { actor: SERVER_ACTOR, now: now() }),
      );
      if (outcome.ok) publish(code, outcome);
      else if (outcome.error === "conflict") {
        // Another instance kept writing; its own timeout or the next command reveals.
        log.warn({ room: code }, "deadline: every attempt lost the compare-and-set");
        await resync(code);
      }
    } catch (error) {
      log.warn({ room: code, err: errorCodeOf(error) }, "deadline: timeUp failed");
      await resync(code);
    }
  }

  async function execute(code: string, actor: string, command: Command): Promise<CmdAck> {
    try {
      const outcome = await runner.run(code, (state) =>
        apply(state, command, { actor, now: now() }),
      );
      if (!outcome.ok) {
        log.debug({ room: code, cmd: command.type, code: outcome.error }, "command not run");
        return refuse(outcome.error === "conflict" ? "busy" : "room_not_found");
      }
      publish(code, outcome);
      const { result } = outcome;
      return result.ok ? { ok: true, version: outcome.version } : refuse(result.error);
    } catch (error) {
      if (!(error instanceof DatabaseError)) throw error;
      log.warn(
        { room: code, cmd: command.type, err: error.code },
        "command failed in the database",
      );
      await resync(code);
      return refuse("internal");
    }
  }

  function leaveRoom(socket: RealtimeSocket) {
    const code = socket.data.room;
    if (code === undefined) return;
    socket.data.room = undefined;
    void socket.leave(channelOf(code));
    forgetIfEmpty(code);
  }

  function forgetIfEmpty(code: string) {
    if (socketsOf(code).length > 0) return;
    deadlines.clear(code);
    sent.delete(code);
  }

  return {
    attach(server) {
      io = server;
    },

    async enter(socket, { code }: EnterPayload): Promise<EnterAck> {
      const user = socket.data.user;
      if (!user) return refuse("unauthenticated");
      const sessionId = socket.data.sessionId;
      if (sessionAlive && (sessionId === undefined || !(await sessionAlive(sessionId)))) {
        leaveRoom(socket);
        return refuse("unauthenticated");
      }
      if (socket.data.room !== code) leaveRoom(socket);
      // Join before loading: a change committed after the load is broadcast to this socket
      // too, so it never misses one. A snapshot older than what it holds is dropped.
      await socket.join(channelOf(code));
      socket.data.room = code;
      let loaded: Awaited<ReturnType<typeof store.loadRoom>>;
      try {
        loaded = await store.loadRoom(code);
      } catch (error) {
        leaveRoom(socket);
        throw error;
      }
      if (!loaded) {
        leaveRoom(socket);
        return refuse("room_not_found");
      }
      armDeadline(code, loaded.state);
      log.debug({ room: code, version: loaded.version }, "socket entered");
      return {
        ok: true,
        snapshot: toSnapshot(loaded.state, user.id, {
          code,
          version: loaded.version,
          now: now(),
        }),
      };
    },

    cmd(socket, id, command) {
      const user = socket.data.user;
      if (!user) return refuse("unauthenticated");
      const code = socket.data.room;
      if (code === undefined) return refuse("room_not_found");
      return acks.remember(ackKey(user.id, code, id), () => execute(code, user.id, command));
    },

    disconnect(socket) {
      const code = socket.data.room;
      if (code !== undefined) forgetIfEmpty(code);
    },

    close() {
      deadlines.clearAll();
    },

    deadlines,
  };
}

function errorCodeOf(error: unknown): string {
  return error instanceof DatabaseError ? error.code : "unknown";
}
