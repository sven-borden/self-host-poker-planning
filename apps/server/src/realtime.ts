/**
 * Socket.IO on the app's HTTP server. Every incoming payload is `unknown` (the event maps
 * describe a well-behaved client and check nothing at runtime): `enter` goes through
 * `parseEnter`, `cmd` through `toDomainCommand`, and only parsed values reach the
 * handlers. Rooms arrive in W1; until then both events answer `room_not_found`.
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
import type { Logger } from "./logger.ts";

/** Per-socket server data. #10 adds the resolved user, W1 the room. */
export interface SocketData {
  /** Random id that ties a socket's log lines together; never sent to clients. */
  conn: string;
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
export type SocketMiddleware = (
  socket: RealtimeSocket,
  next: (err?: ExtendedError) => void,
) => void;

/** What the server does with a parsed message. W1 replaces the stubs. */
export interface RealtimeHandlers {
  enter(socket: RealtimeSocket, enter: EnterPayload): EnterAck | Promise<EnterAck>;
  cmd(socket: RealtimeSocket, id: string, command: Command): CmdAck | Promise<CmdAck>;
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
}

/** Payload cap per message, both transports (architecture section 8). */
export const MAX_PAYLOAD_BYTES = 16 * 1024;

export function createRealtime(httpServer: HttpServer, options: RealtimeOptions): RealtimeServer {
  const { logger, allowedOrigin, handlers = noRoomHandlers, middleware = [] } = options;
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
  for (const fn of middleware) io.use(fn);

  io.on("connection", (socket) => {
    const log = logger.child({ conn: socket.data.conn });
    log.info({ transport: socket.conn.transport.name }, "socket connected");
    socket.on("disconnect", (reason) => log.info({ reason }, "socket disconnected"));

    onRaw(socket, log, "enter", async (payload) => {
      const parsed = parseEnter(payload);
      return parsed.ok ? handlers.enter(socket, parsed.enter) : { ok: false, code: parsed.code };
    });
    onRaw(socket, log, "cmd", async (payload) => {
      const parsed = toDomainCommand(payload);
      return parsed.ok
        ? handlers.cmd(socket, parsed.id, parsed.command)
        : { ok: false, code: parsed.code };
    });
  });

  return io;
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
