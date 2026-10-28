/**
 * Socket.IO on the app's HTTP server. Every incoming payload is `unknown` (the event maps
 * describe a well-behaved client and check nothing at runtime): `enter` goes through
 * `parseEnter`, `cmd` through `toDomainCommand`, `history` (#33) through
 * `parseHistoryRequest`, and only parsed values reach the
 * handlers (`sync/room-sync.ts` in the running server). Every message first takes a token
 * from its sender's bucket (`SOCKET_MESSAGE_LIMIT`, one bucket per person shared by all
 * their sockets): past it, the answer is `rate_limited` and the socket stays open. One
 * person holds at most `MAX_SOCKETS_PER_USER` sockets; the next handshake is refused with
 * `rate_limited`. `drainRealtime` stops taking messages and waits for the answers owed.
 */
import { randomBytes } from "node:crypto";
import type { Server as HttpServer } from "node:http";
import type { Command } from "@pp/domain";
import {
  type ClientToServerEvents,
  type CmdAck,
  type EnterAck,
  type EnterPayload,
  type HistoryAck,
  type HistoryRequest,
  parseEnter,
  parseHistoryRequest,
  type ServerToClientEvents,
  toDomainCommand,
} from "@pp/protocol";
import { type ExtendedError, Server, type Socket } from "socket.io";
import type { SocketUser } from "./auth.ts";
import type { Logger } from "./logger.ts";
import {
  createTokenBucket,
  SOCKET_MESSAGE_LIMIT,
  type TokenBucket,
  type TokenBucketOptions,
} from "./sync/token-bucket.ts";

/** Per-socket server data. */
export interface SocketData {
  /** Random id that ties a socket's log lines together; never sent to clients. */
  conn: string;
  /**
   * The person behind the socket, from the handshake's session cookie (`auth.ts`,
   * `sessionMiddleware`). Set before `connection` fires whenever the server runs with
   * identity (`setupServer`): a socket without a valid session never connects.
   */
  user?: SocketUser;
  /**
   * The session behind `user` (its id, not its token): a socket outlives a sign-out, so
   * the room sync checks it again on every `enter`.
   */
  sessionId?: string;
  /**
   * The room this socket entered, set once every check of `enter` passed; a socket
   * follows one room at a time. Logs and channel names use the id, never the code.
   */
  room?: { id: string; code: string };
}

type InterServerEvents = Record<string, never>;

export type RealtimeServer = Server<
  ClientToServerEvents,
  ServerToClientEvents,
  InterServerEvents,
  SocketData
>;
export type RealtimeSocket = Socket<
  ClientToServerEvents,
  ServerToClientEvents,
  InterServerEvents,
  SocketData
>;
/**
 * A handshake middleware. It may be async: a throw or a rejection refuses the handshake
 * with `internal` and logs one error line, instead of becoming an unhandled rejection.
 */
export type SocketMiddleware = (
  socket: RealtimeSocket,
  next: (err?: ExtendedError) => void,
) => void | Promise<void>;

/** What the server does with a parsed message (`sync/room-sync.ts`). */
export interface RealtimeHandlers {
  enter(socket: RealtimeSocket, enter: EnterPayload): EnterAck | Promise<EnterAck>;
  cmd(socket: RealtimeSocket, id: string, command: Command): CmdAck | Promise<CmdAck>;
  /** One page of the entered room's history (#33); left out, every request is refused. */
  history?(socket: RealtimeSocket, request: HistoryRequest): HistoryAck | Promise<HistoryAck>;
  /** Called once with the Socket.IO server, before any connection (for broadcasts). */
  attach?(io: RealtimeServer): void;
  /** Called after a socket closed; it has already left its Socket.IO rooms. */
  disconnect?(socket: RealtimeSocket): void;
}

export const noRoomHandlers: RealtimeHandlers = {
  enter: () => ({ ok: false, code: "room_not_found" }),
  cmd: () => ({ ok: false, code: "room_not_found" }),
};

export interface RealtimeOptions {
  logger: Logger;
  /**
   * The only browser origin allowed to open a socket: `config.baseUrl`. A handshake with
   * another `Origin` is refused on both transports, so a page on another site (even a
   * same-site one such as another `*.example.com` app, which SameSite=Lax lets through)
   * cannot ride a visitor's session cookie. A handshake without `Origin` is a non-browser
   * client, which carries no visitor's cookie, and is accepted.
   */
  allowedOrigin: string;
  handlers?: RealtimeHandlers;
  /** Run in order on every handshake after the connection id is set (#10: session). */
  middleware?: readonly SocketMiddleware[];
  /** Messages (`enter` and `cmd`) per person; `SOCKET_MESSAGE_LIMIT` by default. */
  messageLimit?: TokenBucketOptions;
  /** Sockets one person may hold at once; `MAX_SOCKETS_PER_USER` by default. */
  maxSocketsPerUser?: number;
}

/**
 * Sockets one person may hold open at once (tabs, devices): enough for a few tabs, few
 * enough that one session cannot multiply its message budget or the server's work.
 */
export const MAX_SOCKETS_PER_USER = 8;

/** One person's sockets and their shared message bucket. */
interface Holder {
  sockets: Set<string>;
  bucket: TokenBucket;
  /** Set while the person holds no socket: forgets the holder once the bucket refilled. */
  idle?: ReturnType<typeof setTimeout> | undefined;
}

/** What `drainRealtime` needs from a server built by `createRealtime`. */
interface Drain {
  accepting: boolean;
  inFlight: Set<Promise<void>>;
}

const drains = new WeakMap<RealtimeServer, Drain>();

/**
 * Stops taking `enter` and `cmd` (a new one gets no answer: the client sends it again
 * after it reconnected, with the same id) and resolves once every message already taken
 * has been answered, or after `timeoutMs`, with how many were in flight. The server is
 * shutting down; the engine closes after this, so the answers owed reach their sockets.
 */
export async function drainRealtime(io: RealtimeServer, timeoutMs: number): Promise<number> {
  const drain = drains.get(io);
  if (!drain) return 0;
  drain.accepting = false;
  const pending = drain.inFlight.size;
  if (pending === 0) return 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    Promise.allSettled([...drain.inFlight]),
    new Promise((resolve) => {
      timer = setTimeout(resolve, timeoutMs);
    }),
  ]);
  clearTimeout(timer);
  return pending;
}

/** Payload cap per message, both transports (architecture section 8). */
export const MAX_PAYLOAD_BYTES = 16 * 1024;

export function createRealtime(httpServer: HttpServer, options: RealtimeOptions): RealtimeServer {
  const {
    logger,
    allowedOrigin,
    handlers = noRoomHandlers,
    middleware = [],
    messageLimit = SOCKET_MESSAGE_LIMIT,
    maxSocketsPerUser = MAX_SOCKETS_PER_USER,
  } = options;
  const io: RealtimeServer = new Server(httpServer, {
    maxHttpBufferSize: MAX_PAYLOAD_BYTES,
    serveClient: false,
    allowRequest: (request, callback) => {
      const origin = request.headers.origin;
      callback(null, origin === undefined || origin === allowedOrigin);
    },
  });

  io.use((socket, next) => {
    socket.data.conn = randomBytes(6).toString("base64url");
    next();
  });
  for (const fn of middleware) io.use(guard(fn, logger));

  // After the session: the sockets and the message bucket of each person. Without
  // identity (tests), each socket counts as its own person.
  const holders = new Map<string, Holder>();
  const holderKey = (socket: RealtimeSocket) => socket.data.user?.id ?? `socket ${socket.id}`;
  const refillMs = (messageLimit.burst / messageLimit.perSecond) * 1000;
  const release = (key: string, id: string) => {
    const holder = holders.get(key);
    if (!holder?.sockets.delete(id) || holder.sockets.size > 0) return;
    // Kept until its bucket would be full again: closing every socket and opening new
    // ones does not refill it sooner.
    holder.idle = setTimeout(() => {
      if (holder.sockets.size === 0) holders.delete(key);
    }, refillMs);
    holder.idle.unref();
  };
  io.use((socket, next) => {
    const conn = socket.client.conn;
    if (conn.readyState === "closing" || conn.readyState === "closed") {
      next(new Error("internal"));
      return;
    }
    const key = holderKey(socket);
    let holder = holders.get(key);
    if (holder && holder.sockets.size >= maxSocketsPerUser) {
      logger.debug({ conn: socket.data.conn }, "socket refused: too many sockets for one person");
      next(new Error("rate_limited"));
      return;
    }
    if (!holder) {
      holder = { sockets: new Set(), bucket: createTokenBucket(messageLimit) };
      holders.set(key, holder);
    }
    clearTimeout(holder.idle);
    holder.idle = undefined;
    holder.sockets.add(socket.id);
    // Released when the socket disconnects, and when the connection closes before the
    // socket ever connected.
    conn.once("close", () => release(key, socket.id));
    next();
  });

  const drain: Drain = { accepting: true, inFlight: new Set() };
  drains.set(io, drain);
  handlers.attach?.(io);

  io.on("connection", (socket) => {
    const log = logger.child({ conn: socket.data.conn });
    log.info({ transport: socket.conn.transport.name }, "socket connected");
    const key = holderKey(socket);
    socket.on("disconnect", (reason) => {
      log.info({ reason }, "socket disconnected");
      release(key, socket.id);
      handlers.disconnect?.(socket);
    });
    const bucket = holders.get(key)?.bucket ?? createTokenBucket(messageLimit);
    const limited = { ok: false, code: "rate_limited" } as const;

    onRaw(socket, log, drain, "enter", async (payload) => {
      if (!bucket.take()) return limited;
      const parsed = parseEnter(payload);
      return parsed.ok ? handlers.enter(socket, parsed.enter) : { ok: false, code: parsed.code };
    });
    onRaw(socket, log, drain, "cmd", async (payload) => {
      if (!bucket.take()) return limited;
      const parsed = toDomainCommand(payload);
      return parsed.ok
        ? handlers.cmd(socket, parsed.id, parsed.command)
        : { ok: false, code: parsed.code };
    });
    onRaw(socket, log, drain, "history", async (payload) => {
      if (!bucket.take()) return limited;
      const parsed = parseHistoryRequest(payload);
      if (!parsed.ok) return { ok: false, code: parsed.code };
      return handlers.history
        ? handlers.history(socket, parsed.request)
        : { ok: false, code: "room_not_found" };
    });
  });

  return io;
}

/**
 * Runs a middleware so that it cannot crash the process: a synchronous throw or a
 * rejected promise logs one error line and refuses the handshake with `internal` (the
 * client sees `connect_error`). `next` is passed on at most once.
 */
function guard(fn: SocketMiddleware, logger: Logger): SocketMiddleware {
  return (socket, next) => {
    let done = false;
    const once = (err?: ExtendedError) => {
      if (done) return;
      done = true;
      next(err);
    };
    const fail = (error: unknown) => {
      logger.error({ conn: socket.data.conn, err: error }, "socket middleware failed");
      once(new Error("internal"));
    };
    try {
      const result = fn(socket, once);
      if (result instanceof Promise) result.catch(fail);
    } catch (error) {
      fail(error);
    }
  };
}

/**
 * Listens to an event without trusting its arguments: the first one is the payload, the
 * last one the ack when it is a function. A message without an ack is still handled (its
 * answer is dropped); a throwing handler answers `internal` and logs the error. Each
 * message is tracked until its answer is sent; while the server drains, a new one is
 * dropped unanswered.
 */
function onRaw<A extends EnterAck | CmdAck | HistoryAck>(
  socket: RealtimeSocket,
  log: Logger,
  drain: Drain,
  event: "enter" | "cmd" | "history",
  handle: (payload: unknown) => Promise<A>,
): void {
  const untyped = socket as unknown as {
    on(event: string, listener: (...args: unknown[]) => void): void;
  };
  untyped.on(event, (...args) => {
    const last = args.at(-1);
    const ack = typeof last === "function" ? (last as (answer: A | CmdAck) => void) : undefined;
    const payload = args.length > (ack ? 1 : 0) ? args[0] : undefined;
    if (!drain.accepting) {
      log.debug({ event }, "message dropped: shutting down");
      return;
    }
    const answered: Promise<void> = handle(payload).then(
      (answer) => {
        if (!answer.ok) log.debug({ event, code: answer.code }, "message refused");
        ack?.(answer);
      },
      (error: unknown) => {
        log.error({ event, err: error }, "message handler failed");
        ack?.({ ok: false, code: "internal" });
      },
    );
    drain.inFlight.add(answered);
    void answered.finally(() => drain.inFlight.delete(answered));
  });
}
