import {
  type ClientToServerEvents,
  type CmdAck,
  type EnterAck,
  PROTOCOL_VERSION,
  type ServerToClientEvents,
  type Snapshot,
  type WireCommandInput,
} from "@pp/protocol";
import { ensureIdentity, retryDelay, UNAUTHENTICATED } from "../identity/identity.ts";
import { useRoomStore } from "../stores/room-store.ts";
import {
  connectWhenIdentified,
  createSocket,
  RETRIED_REFUSALS,
  type TypedSocket,
  trackConnection,
} from "./socket.ts";

// One room page, one socket (architecture section 5). `openRoom` connects once this browser
// has a session (`connectWhenIdentified`, with #10's backoff), sends `enter` on every
// connect, so a reconnect always starts from a fresh snapshot, and feeds every snapshot to
// the room store, which drops stale versions. Socket.IO reconnects a dropped connection on
// its own; nothing here adds a second reconnect loop: only a refused `enter` that passes
// on its own (`internal`, `rate_limited`, `busy`) is sent again after a backoff.
//
// Messages are checked by shape (`isSnapshot`, `isEnterAck`, `isCmdAck`), not with the
// protocol's zod schemas: zod would add about 27 kB gzipped to the room route (200 kB
// budget), and the only peer is our own server, built from the same commit, whose
// `protocol_mismatch` answer already catches an old tab after a redeploy.

export type RoomSocket = TypedSocket<ServerToClientEvents, ClientToServerEvents>;

/** How long an `enter` or a command waits for its ack before it counts as lost. */
export const ACK_TIMEOUT_MS = 10_000;
/** How long `sendCommand` waits for the room to be live before giving up (`offline`). */
export const LIVE_WAIT_MS = 15_000;
/** Sends of one command (same id) at most: after a lost ack, and after `busy`. */
export const MAX_SENDS = 4;

/** `enter` refusals that pass on their own: sent again after a backoff. */
const RETRIED_ENTER: ReadonlySet<string> = new Set([...RETRIED_REFUSALS, "busy"]);

export interface OpenRoomOptions {
  /** A socket to use instead of a new one (tests). */
  socket?: RoomSocket;
  /** Connects the socket; `connectWhenIdentified` by default. Returns its cleanup. */
  connect?: (socket: RoomSocket) => () => void;
  /** The identity bootstrap, run once more when `enter` says `unauthenticated`. */
  ensure?: (options?: { force?: boolean; retry?: boolean }) => Promise<unknown>;
  /** Milliseconds before `enter` attempt `attempt` is sent again. */
  delay?: (attempt: number) => number;
}

interface ActiveRoom {
  code: string;
  socket: RoomSocket;
  close: () => void;
}

let active: ActiveRoom | null = null;

/**
 * Follows the room `code` until the returned function is called: one socket, its
 * snapshots in the room store, and the store's `status`. Opening another room closes the
 * previous one.
 */
export function openRoom(code: string, options: OpenRoomOptions = {}): () => void {
  active?.close();
  const store = useRoomStore.getState;
  store().open(code);
  const socket = options.socket ?? createSocket<ServerToClientEvents, ClientToServerEvents>();
  const { ensure = ensureIdentity, delay = retryDelay } = options;
  let stopped = false;
  let attempt = 0;
  let reauthenticated = false;
  let retry: ReturnType<typeof setTimeout> | undefined;

  const fail = (error: string) => {
    if (stopped) return;
    store().fail(error);
  };
  /** A final answer: the socket has nothing more to do. */
  const stop = (error: string) => {
    fail(error);
    socket.disconnect();
  };

  const onEnter = (ack: EnterAck) => {
    if (stopped) return;
    if (ack.ok) {
      attempt = 0;
      reauthenticated = false;
      store().receive(ack.snapshot);
      store().setStatus("live");
      return;
    }
    if (RETRIED_ENTER.has(ack.code)) {
      store().setStatus("reconnecting");
      clearTimeout(retry);
      retry = setTimeout(enter, delay(attempt++));
      return;
    }
    if (ack.code === UNAUTHENTICATED && !reauthenticated) {
      // The session ended while the socket stayed open: one fresh bootstrap, then a new
      // handshake with the new cookie, which enters again on connect.
      reauthenticated = true;
      socket.disconnect();
      store().setStatus("reconnecting");
      ensure({ force: true, retry: true }).then(
        () => {
          if (!stopped) socket.connect();
        },
        () => fail(UNAUTHENTICATED),
      );
      return;
    }
    stop(ack.code);
  };

  function enter() {
    if (stopped || !socket.connected) return;
    socket
      .timeout(ACK_TIMEOUT_MS)
      .emitWithAck("enter", { code, protocol: PROTOCOL_VERSION })
      .then(
        (raw: unknown) => {
          onEnter(isEnterAck(raw) ? raw : { ok: false, code: "bad_payload" });
        },
        // No answer in time, or the connection dropped: the next connect enters again;
        // a slow server still connected gets the same backoff as `internal`.
        () => {
          if (socket.connected) onEnter({ ok: false, code: "internal" });
        },
      );
  }

  const onConnect = () => {
    clearTimeout(retry);
    enter();
  };
  const onSnapshot = (raw: unknown) => {
    if (stopped) return;
    if (isSnapshot(raw)) store().receive(raw);
  };
  const onKicked = () => stop("kicked");

  socket.on("connect", onConnect);
  socket.on("snapshot", onSnapshot);
  socket.on("kicked", onKicked);
  const stopTracking = trackConnection(socket, (connection) => {
    if (stopped) return;
    store().setConnection(connection);
    const { status } = store();
    if (status === "error") return;
    if (connection === "reconnecting") store().setStatus("reconnecting");
    else if (connection === "offline") fail("offline");
  });
  const stopConnecting = (options.connect ?? connectWhenIdentified)(socket);

  const close = () => {
    if (stopped) return;
    stopped = true;
    clearTimeout(retry);
    stopConnecting();
    stopTracking();
    socket.off("connect", onConnect);
    socket.off("snapshot", onSnapshot);
    socket.off("kicked", onKicked);
    socket.disconnect();
    if (active === room) {
      active = null;
      store().reset();
    }
  };
  const room: ActiveRoom = { code, socket, close };
  active = room;
  return close;
}

/** A command as `sendCommand` takes it: the wire command without its id. */
export type CommandInput = WireCommandInput extends infer C
  ? C extends { id: string }
    ? Omit<C, "id">
    : never
  : never;

/** The ack, or `offline` when the room was not live in time or no room is open. */
export type CommandResult = CmdAck | { ok: false; code: "offline" };

/** A fresh command id (`COMMAND_ID_PATTERN`). */
export function newCommandId(): string {
  const random = globalThis.crypto?.randomUUID?.();
  return random ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

/**
 * Sends one command to the open room and resolves with its ack: `{ ok: true, version }`,
 * whose snapshot the store already holds (the server broadcasts before it acks), or
 * `{ ok: false, code }` to translate with `errorMessage`. It waits for the room to be
 * live. A lost ack (the connection dropped) and `busy` (nothing was stored) send the same
 * command again with the same id, which the server answers once.
 */
export async function sendCommand(command: CommandInput): Promise<CommandResult> {
  const id = newCommandId();
  for (let send = 0; send < MAX_SENDS; send++) {
    const room = await whenLive();
    if (!room) break;
    let raw: unknown;
    try {
      raw = await room.socket
        .timeout(ACK_TIMEOUT_MS)
        .emitWithAck("cmd", { ...command, id } as WireCommandInput);
    } catch {
      continue;
    }
    const ack: CmdAck = isCmdAck(raw) ? raw : { ok: false, code: "bad_payload" };
    if (!ack.ok && ack.code === "busy" && send < MAX_SENDS - 1) {
      await sleep(50 * 2 ** send + Math.random() * 50);
      continue;
    }
    return ack;
  }
  return { ok: false, code: "offline" };
}

/** The open room once its status is `live`; null on `error`, when closed, or after the wait. */
function whenLive(timeoutMs = LIVE_WAIT_MS): Promise<ActiveRoom | null> {
  return new Promise((resolve) => {
    const check = (): boolean => {
      const { status } = useRoomStore.getState();
      if (!active || status === "error" || status === "idle") return finish(null);
      if (status === "live" && active.socket.connected) return finish(active);
      return false;
    };
    let unsubscribe = () => {};
    const timer = setTimeout(() => finish(null), timeoutMs);
    function finish(room: ActiveRoom | null): true {
      clearTimeout(timer);
      unsubscribe();
      resolve(room);
      return true;
    }
    if (!check()) unsubscribe = useRoomStore.subscribe(() => void check());
  });
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

/** A snapshot of this protocol version: a number version and a room with its code. */
export function isSnapshot(value: unknown): value is Snapshot {
  return (
    isObject(value) &&
    value.protocol === PROTOCOL_VERSION &&
    Number.isInteger(value.version) &&
    isObject(value.room) &&
    typeof value.room.code === "string" &&
    Array.isArray(value.room.participants) &&
    Array.isArray(value.causes)
  );
}

const isRefusal = (value: Record<string, unknown>) =>
  value.ok === false && typeof value.code === "string";

export function isEnterAck(value: unknown): value is EnterAck {
  return isObject(value) && ((value.ok === true && isSnapshot(value.snapshot)) || isRefusal(value));
}

export function isCmdAck(value: unknown): value is CmdAck {
  return (
    isObject(value) && ((value.ok === true && Number.isInteger(value.version)) || isRefusal(value))
  );
}
