/**
 * One Node HTTP server carrying the Hono app and Socket.IO. `createServer` opens nothing;
 * `listen()` binds the port and `close()` shuts down in phases.
 */
import type { Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createAdaptorServer } from "@hono/node-server";
import type { Hono } from "hono";
import { type AppDeps, type AppEnv, createApp, responseHeaders } from "./app.ts";
import type { Config } from "./config.ts";
import {
  createRealtime,
  drainRealtime,
  type RealtimeHandlers,
  type RealtimeOptions,
  type RealtimeServer,
  type SocketMiddleware,
} from "./realtime.ts";

export interface ServerDeps extends AppDeps {
  /** Socket.IO event handlers (W1); defaults answer `room_not_found`. */
  handlers?: RealtimeHandlers;
  /** Socket.IO handshake middleware (#10: resolve the session cookie). */
  socketMiddleware?: readonly SocketMiddleware[];
  /** How long `close()` waits for the answers owed to sockets; `DRAIN_TIMEOUT_MS`. */
  drainTimeoutMs?: number;
  /**
   * The cookie a socket handshake must carry to be considered at all (`setup.ts`: the
   * session cookie's name); see `RealtimeOptions.sessionCookie`.
   */
  sessionCookie?: string;
  /** The socket limits per person, for tests only (the fuzz test raises them). */
  realtimeLimits?: Pick<RealtimeOptions, "messageLimit" | "rosterLimit" | "historyLimit">;
  /** Several instances (#39, `scale-out.ts`): the Redis adapter, WebSocket only. */
  realtimeCluster?: Pick<RealtimeOptions, "adapter" | "transports">;
}

/**
 * How long a shutdown waits for the commands already taken to be answered: well inside
 * the 10 s shutdown limit (`run.ts`), which cuts open connections 2 s before it ends.
 */
export const DRAIN_TIMEOUT_MS = 5_000;

/** Where Socket.IO answers (its default path, which the web client uses). */
const SOCKET_PATH = "/socket.io/";

export interface PokerServer {
  readonly app: Hono<AppEnv>;
  readonly httpServer: HttpServer;
  readonly io: RealtimeServer;
  /** Binds `config.port` (0 picks a free port) and resolves with the bound address. */
  listen(): Promise<AddressInfo>;
  /**
   * Stops accepting connections and new socket messages, waits until every message
   * already taken has been answered (at most `drainTimeoutMs`), drops every socket at
   * once, then waits for open HTTP requests to finish. Idempotent. Resolves once the HTTP
   * server has closed. Each log line is written when its phase has happened.
   */
  close(): Promise<void>;
}

export function createServer(config: Config, deps: ServerDeps): PokerServer {
  const { logger } = deps;
  const app = createApp(config, deps);
  const httpServer = createAdaptorServer({ fetch: app.fetch }) as HttpServer;
  const headers = responseHeaders(config);
  const io = createRealtime(httpServer, {
    logger,
    allowedOrigin: config.baseUrl,
    responseHeaders: headers,
    ...(deps.sessionCookie !== undefined && { sessionCookie: deps.sessionCookie }),
    ...deps.realtimeLimits,
    ...deps.realtimeCluster,
    ...(deps.handlers && { handlers: deps.handlers }),
    ...(deps.socketMiddleware && { middleware: deps.socketMiddleware }),
  });
  // Engine.IO's own refusals (a foreign Origin, no session cookie, a bad query) answer
  // without its "headers" event; set ours first, and its writeHead adds its own.
  // After `createRealtime`: Engine.IO's attach moves the listeners it finds behind its own.
  httpServer.prependListener("request", (request, response) => {
    if (!request.url?.startsWith(SOCKET_PATH)) return;
    for (const [name, value] of Object.entries(headers)) response.setHeader(name, value);
  });
  let closing: Promise<void> | undefined;

  return {
    app,
    httpServer,
    io,
    listen: () =>
      new Promise((resolve, reject) => {
        httpServer.once("error", reject);
        httpServer.listen(config.port, () => {
          httpServer.off("error", reject);
          resolve(httpServer.address() as AddressInfo);
        });
      }),
    close: () => {
      closing ??= (async () => {
        const httpClosed = new Promise<void>((resolve) => httpServer.close(() => resolve()));
        logger.info("shutdown: stopped accepting connections");
        // An ack lost here would make the client send its command again to the next
        // process, whose memory of recent commands is empty: it could apply twice.
        const answered = await drainRealtime(io, deps.drainTimeoutMs ?? DRAIN_TIMEOUT_MS);
        logger.info({ answered }, "shutdown: socket messages answered");
        const sockets = io.of("/").sockets.size;
        // Closing the engine drops every connection now, without a disconnect packet, so
        // clients see "transport close" and reconnect on their own. io.close() then frees
        // the adapters; its promise waits for the HTTP server like `httpClosed` does,
        // which can take until the last open request ends.
        io.engine.close();
        const ioClosed = io.close();
        logger.info({ sockets }, "shutdown: sockets disconnected");
        await Promise.all([httpClosed, ioClosed]);
        logger.info("shutdown: http server closed");
      })();
      return closing;
    },
  };
}
