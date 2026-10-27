/**
 * Helpers for the room sync tests: an in-memory room store (the unit tests run the real
 * runner on it), a stand-in for the session middleware, and a socket client that keeps
 * every snapshot and every raw frame it receives. Not imported by `main.ts`.
 */
import { performance } from "node:perf_hooks";
import type { RoomState } from "@pp/domain";
import {
  type ClientToServerEvents,
  type CmdAck,
  cmdAckSchema,
  type EnterAck,
  enterAckSchema,
  PROTOCOL_VERSION,
  type ServerToClientEvents,
  type Snapshot,
  snapshotSchema,
} from "@pp/protocol";
import { io as connect, type Socket } from "socket.io-client";
import { DatabaseError } from "../db/errors.ts";
import { FIRST_VERSION, type RoomStore, type StoredRoom } from "../db/rooms.ts";
import type { SocketMiddleware } from "../realtime.ts";

/**
 * What the next commit does: store it, lose the compare-and-set, fail before writing,
 * or store it and then fail as if the reply had been lost.
 */
export type CommitFate = "store" | "lose" | "fail" | "store-then-fail";

export interface MemoryRoomStore extends RoomStore {
  readonly rooms: Map<string, StoredRoom>;
  /** Decides each commit; `store` by default. */
  fate: (code: string) => CommitFate;
  commits: number;
}

export function memoryRoomStore(): MemoryRoomStore {
  const rooms = new Map<string, StoredRoom>();
  const byId = (id: string) => [...rooms.values()].find((room) => room.id === id);
  const store: MemoryRoomStore = {
    rooms,
    fate: () => "store",
    commits: 0,
    insertRoom: async ({ code, state }) => {
      if (rooms.has(code)) return null;
      const room = { id: `id-${code}`, code, version: FIRST_VERSION, state };
      rooms.set(code, room);
      return room;
    },
    loadRoom: async (code) => {
      const room = rooms.get(code);
      // A copy, as Postgres would hand out: the runner compares states by identity.
      return room ? { ...room, state: structuredClone(room.state) } : null;
    },
    loadRoomHeader: async (code) => (rooms.has(code) ? { code, name: null } : null),
    commitRoom: async (id, expectedVersion, next) => {
      const room = byId(id);
      if (!room || room.version !== expectedVersion) return false;
      const fate = store.fate(room.code);
      if (fate === "lose") return false;
      if (fate === "fail") throw new DatabaseError("commit room", "57P01");
      rooms.set(room.code, { ...room, version: room.version + 1, state: structuredClone(next) });
      store.commits += 1;
      if (fate === "store-then-fail") throw new DatabaseError("commit room", "08006");
      return true;
    },
  };
  return store;
}

/**
 * Stands in for `sessionMiddleware`: the handshake's `auth.user` is the user id, and the
 * session id is derived from it. A handshake without one is refused like a missing cookie.
 */
export const fakeIdentity: SocketMiddleware = (socket, next) => {
  const user: unknown = socket.handshake.auth.user;
  if (typeof user !== "string" || user === "") {
    next(new Error("unauthenticated"));
    return;
  }
  socket.data.user = { id: user, name: "", isAnonymous: true };
  socket.data.sessionId = `session-${user}`;
  next();
};

type Socket_ = Socket<ServerToClientEvents, ClientToServerEvents>;

export interface Received {
  snapshot: Snapshot;
  /** `performance.now()` at arrival. */
  at: number;
}

export interface TestClient {
  readonly socket: Socket_;
  /** Every Socket.IO packet the server sent, as the raw text of its WebSocket frame. */
  readonly frames: string[];
  readonly received: Received[];
  readonly kicked: { count: number };
  enter(code: string, protocol?: number): Promise<EnterAck>;
  /** Sends a command; the id is fresh unless given. */
  cmd(type: string, payload?: object, id?: string): Promise<CmdAck>;
  /** The first snapshot received from `from` on (an index into `received`) that matches. */
  waitFor(match: (s: Snapshot) => boolean, timeoutMs?: number, from?: number): Promise<Received>;
  latest(): Snapshot | undefined;
  close(): void;
}

let ids = 0;
export const nextCommandId = () => `c${++ids}`;

export interface ClientOptions {
  /** For `fakeIdentity`. */
  user?: string;
  /** For the real session middleware: `pp.session_token=…`. */
  cookie?: string;
  reconnection?: boolean;
}

/**
 * A WebSocket client. The frames are taken from the engine (`packet` events), so they
 * are exactly what came over the wire, before Socket.IO decoded them.
 */
export function testClient(url: string, options: ClientOptions = {}): TestClient {
  const socket: Socket_ = connect(url, {
    transports: ["websocket"],
    forceNew: true,
    reconnection: options.reconnection ?? false,
    reconnectionDelay: 100,
    reconnectionDelayMax: 500,
    ...(options.user !== undefined && { auth: { user: options.user } }),
    ...(options.cookie !== undefined && { extraHeaders: { cookie: options.cookie } }),
  });
  const frames: string[] = [];
  const received: Received[] = [];
  const kicked = { count: 0 };
  const watchEngine = () => {
    socket.io.engine.on("packet", (packet: { type: string; data?: unknown }) => {
      if (packet.type === "message" && typeof packet.data === "string") frames.push(packet.data);
    });
  };
  watchEngine();
  socket.io.on("open", watchEngine);
  const waiters = new Set<() => void>();
  const receive = (snapshot: Snapshot) => {
    received.push({ snapshot, at: performance.now() });
    for (const wake of waiters) wake();
  };
  socket.on("snapshot", (raw) => receive(snapshotSchema.parse(raw)));
  socket.on("kicked", () => {
    kicked.count += 1;
  });

  return {
    socket,
    frames,
    received,
    kicked,
    enter: async (code, protocol = PROTOCOL_VERSION) => {
      const ack = await socket.timeout(5000).emitWithAck("enter", { code, protocol });
      const parsed = enterAckSchema.parse(ack);
      if (parsed.ok) receive(parsed.snapshot);
      return parsed;
    },
    cmd: async (type, payload, id = nextCommandId()) => {
      const raw = socket as unknown as {
        timeout(ms: number): { emitWithAck(event: string, ...args: unknown[]): Promise<unknown> };
      };
      const message = payload === undefined ? { id, type } : { id, type, payload };
      return cmdAckSchema.parse(await raw.timeout(5000).emitWithAck("cmd", message));
    },
    waitFor: (match, timeoutMs = 3000, from = 0) =>
      new Promise((resolve, reject) => {
        const check = () => {
          const found = received.slice(from).find((r) => match(r.snapshot));
          if (!found) return false;
          waiters.delete(check);
          clearTimeout(timer);
          resolve(found);
          return true;
        };
        const timer = setTimeout(() => {
          waiters.delete(check);
          reject(new Error("no matching snapshot in time"));
        }, timeoutMs);
        if (!check()) waiters.add(check);
      }),
    latest: () => received.at(-1)?.snapshot,
    close: () => {
      socket.disconnect();
    },
  };
}

/** Decodes a Socket.IO frame (`42["snapshot",{…}]`, `430[{…}]`) into its arguments. */
export function frameArgs(frame: string): unknown[] {
  const start = frame.search(/[[{]/);
  if (start < 0) return [];
  const parsed: unknown = JSON.parse(frame.slice(start));
  return Array.isArray(parsed) ? parsed : [parsed];
}

/** The snapshots among raw frames: `snapshot` events and `enter` acks. */
export function snapshotsIn(frames: readonly string[]): Snapshot[] {
  const found: Snapshot[] = [];
  for (const frame of frames) {
    for (const arg of frameArgs(frame)) {
      const direct = snapshotSchema.safeParse(arg);
      if (direct.success) found.push(direct.data);
      const ack = enterAckSchema.safeParse(arg);
      if (ack.success && ack.data.ok) found.push(ack.data.snapshot);
    }
  }
  return found;
}

/** A state with the given round fields replaced, for tests that need a near deadline. */
export function withDeadline(state: RoomState, deadlineAt: number): RoomState {
  if (!state.round) throw new Error("no round");
  return { ...state, round: { ...state.round, deadlineAt } };
}

/** The session cookie's name on http (`cookieNaming`). */
export const SESSION_COOKIE = "pp.session_token";

export interface Guest {
  id: string;
  /** `pp.session_token=…`, to send back. */
  cookie: string;
}

/** Signs in as a new guest on the server at `base`, as the web app does. */
export async function signInGuest(base: string, origin: string): Promise<Guest> {
  const response = await fetch(`${base}/api/auth/sign-in/anonymous`, {
    method: "POST",
    headers: { origin, "content-type": "application/json" },
    body: "{}",
  });
  if (!response.ok) throw new Error(`sign-in answered ${response.status}`);
  const json = (await response.json()) as { user?: { id?: string } };
  const cookie = response.headers
    .getSetCookie()
    .find((line) => line.startsWith(`${SESSION_COOKIE}=`))
    ?.split(";")[0];
  const id = json.user?.id;
  if (!cookie || !id) throw new Error("sign-in gave no session");
  return { id, cookie };
}

/** A random room code of 10 base58 characters, as #14 draws them. */
export function roomCode(): string {
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  return Array.from(
    { length: 10 },
    () => alphabet[Math.floor(Math.random() * alphabet.length)] ?? "1",
  ).join("");
}
