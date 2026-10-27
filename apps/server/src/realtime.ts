/**
 * Socket.IO on the app's HTTP server. Every incoming payload is `unknown` (the event maps
 * describe a well-behaved client and check nothing at runtime): `enter` goes through
 * `parseEnter`, `cmd` through `toDomainCommand`, and only parsed values reach the
 * handlers (`sync/room-sync.ts` in the running server). Every message first takes a token
 * from the socket's bucket (`SOCKET_MESSAGE_LIMIT`): past it, the answer is `rate_limited`
 * and the socket stays open.
 */
import { randomBytes } from "node:crypto";
import type { Server as HttpServer } from "node:http";
import type { Command } from "@pp/domain";
import {
  type ClientToServerEvents,
  type CmdAck,
  type EnterAck,
  type EnterPayload,
  parseEnter,
  type ServerToClientEvents,
  toDomainCommand,
} from "@pp/protocol";
import { type ExtendedError, Server, type Socket } from "socket.io";
import type { SocketUser } from "./auth.ts";
import type { Logger } from "./logger.ts";
import {
  createTokenBucket,
  SOCKET_MESSAGE_LIMIT,
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
  /** The code of the room this socket entered; a socket follows one room at a time. */
  room?: string;
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
  /** Messages (`enter` and `cmd`) per socket; `SOCKET_MESSAGE_LIMIT` by default. */
  messageLimit?: TokenBucketOptions;
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
  handlers.attach?.(io);

  io.on("connection", (socket) => {
    const log = logger.child({ conn: socket.data.conn });
    log.info({ transport: socket.conn.transport.name }, "socket connected");
    socket.on("disconnect", (reason) => {
      log.info({ reason }, "socket disconnected");
      handlers.disconnect?.(socket);
    });
    const bucket = createTokenBucket(messageLimit);
    const limited = { ok: false, code: "rate_limited" } as const;

    onRaw(socket, log, "enter", async (payload) => {
      if (!bucket.take()) return limited;
      const parsed = parseEnter(payload);
      return parsed.ok ? handlers.enter(socket, parsed.enter) : { ok: false, code: parsed.code };
    });
    onRaw(socket, log, "cmd", async (payload) => {
      if (!bucket.take()) return limited;
      const parsed = toDomainCommand(payload);
      return parsed.ok
        ? handlers.cmd(socket, parsed.id, parsed.command)
        : { ok: false, code: parsed.code };
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
 * answer is dropped); a throwing handler answers `internal` and logs the error.
 */
function onRaw<A extends EnterAck | CmdAck>(
  socket: RealtimeSocket,
  log: Logger,
  event: "enter" | "cmd",
  handle: (payload: unknown) => Promise<A>,
): void {
  const untyped = socket as unknown as {
    on(event: string, listener: (...args: unknown[]) => void): void;
  };
  untyped.on(event, (...args) => {
    const last = args.at(-1);
    const ack = typeof last === "function" ? (last as (answer: A | CmdAck) => void) : undefined;
    const payload = args.length > (ack ? 1 : 0) ? args[0] : undefined;
    handle(payload).then(
      (answer) => {
        if (!answer.ok) log.debug({ event, code: answer.code }, "message refused");
        ack?.(answer);
      },
      (error: unknown) => {
        log.error({ event, err: error }, "message handler failed");
        ack?.({ ok: false, code: "internal" });
      },
    );
  });
}
