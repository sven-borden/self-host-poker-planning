/**
 * Socket.IO on the app's HTTP server. Every incoming payload is `unknown` (the event maps
 * describe a well-behaved client and check nothing at runtime): `enter` goes through
 * `parseEnter`, `cmd` through `toDomainCommand`, `history` (#33) through
 * `parseHistoryRequest`, and only parsed values reach the
 * handlers (`sync/room-sync.ts` in the running server). Every message first takes a token
 * from its sender's bucket (`SOCKET_MESSAGE_LIMIT`, one bucket per person shared by all
 * their sockets): past it, the answer is `rate_limited` and the socket stays open. Roster
 * commands (`ROSTER_LIMIT`), changes to the queue (`QUEUE_WRITE_LIMIT`) and history requests
 * (`HISTORY_LIMIT`) take a token from a tighter bucket of the person's too. One
 * person holds at most `MAX_SOCKETS_PER_USER` sockets; the next handshake is refused with
 * `rate_limited`. `drainRealtime` stops taking messages and waits for the answers owed.
 *
 * A connection costs memory before it is anyone's (#36): a handshake without a session
 * cookie whose signature holds is refused before the upgrade (`sessionCookie`), a refused
 * handshake closes its transport at once, and a connection that never asks for a socket is
 * closed after `CONNECT_TIMEOUT_MS`. One session opens at most `HANDSHAKE_LIMIT` connections
 * (U2), counted before the session is looked up, and a connection asks for one socket.
 */
import { randomBytes } from "node:crypto";
import type { Server as HttpServer } from "node:http";
import { type Command, MAX_MESSAGE_BYTES } from "@pp/domain";
import {
  type ClientToServerEvents,
  type CmdAck,
  type EnterAck,
  type EnterPayload,
  type HistoryAck,
  type HistoryRequest,
  parseEnter,
  parseHistoryRequest,
  parseQueueRequest,
  type QueueAck,
  type ServerToClientEvents,
  toDomainCommand,
} from "@pp/protocol";
import { type ExtendedError, Server, type ServerOptions, type Socket } from "socket.io";
import { Decoder, Encoder } from "socket.io-parser";
import type { SocketUser } from "./auth.ts";
import type { Logger } from "./logger.ts";
import { sessionKey, signedSessionToken } from "./session-cookie.ts";
import type { SharedLimits } from "./shared-limits.ts";
import {
  createKeyedTokenBuckets,
  createTokenBucket,
  HISTORY_LIMIT,
  QUEUE_WRITE_LIMIT,
  ROSTER_LIMIT,
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
  /** When that session began (epoch ms): a room with a rule asks a recent sign-in (ADR-028). */
  sessionStartedAt?: number;
  /**
   * The room this socket entered, set once every check of `enter` passed; a socket
   * follows one room at a time. Logs and channel names use the id, never the code.
   */
  room?: { id: string; code: string };
}

/**
 * What instances say to each other through the Redis adapter (#39, `sync/room-sync.ts`).
 * With the in-memory adapter (one instance) none of them is ever sent. Each payload is
 * checked on arrival like a client's: Redis is a network service.
 */
export interface InterServerEvents {
  /** A room (by id) changed: its version, the change's causes, a new password. */
  roomChanged(signal: unknown): void;
  /** Who has a socket entered in a room (by id) on the instance that answers. */
  present(roomId: unknown, answer: (people: string[]) => void): void;
  /** The rooms (by id) with a socket on the instance that answers. */
  occupied(answer: (rooms: string[]) => void): void;
  /** A guest signed in (#48): their sockets, wherever they are, hear `signedIn` and close. */
  guestLinked(guest: unknown, account: unknown): void;
  /** A room (by id) was deleted (#49): its sockets, wherever they are, hear it and close. */
  roomDeleted(room: unknown): void;
  /** An account is going (#51): its sockets, wherever they are, hear it and close. */
  accountDeleted(who: unknown): void;
}

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
  /** The entered room's queue (#52), for its PO; left out, every request is refused. */
  queue?(socket: RealtimeSocket): QueueAck | Promise<QueueAck>;
  /** Called once with the Socket.IO server, before any connection (for broadcasts). */
  attach?(io: RealtimeServer): void;
  /**
   * Called after a socket closed; it has already left its Socket.IO rooms. `shuttingDown`:
   * the server closed it on its way down, and the client will be back.
   */
  disconnect?(socket: RealtimeSocket, shuttingDown: boolean): void;
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
  /** Messages (`enter`, `cmd`, `history`, `queue`) per person; `SOCKET_MESSAGE_LIMIT` by default. */
  messageLimit?: TokenBucketOptions;
  /** Roster commands per person; `ROSTER_LIMIT` by default. */
  rosterLimit?: TokenBucketOptions;
  /** History and queue requests per person; `HISTORY_LIMIT` by default. */
  historyLimit?: TokenBucketOptions;
  /** Changes to the queue per person; `QUEUE_WRITE_LIMIT` by default. */
  queueLimit?: TokenBucketOptions;
  /** Sockets one person may hold at once; `MAX_SOCKETS_PER_USER` by default. */
  maxSocketsPerUser?: number;
  /** Handshakes per session; `HANDSHAKE_LIMIT` by default. */
  handshakeLimit?: TokenBucketOptions;
  /** How often refused handshakes are logged, as one line; `HANDSHAKE_WARN_EVERY_MS` by default. */
  handshakeWarnEveryMs?: number;
  /** Added to every HTTP answer of Socket.IO's own (polling, the upgrade): the app's (#36). */
  responseHeaders?: Readonly<Record<string, string>>;
  /**
   * The cookie every handshake must carry (`setup.ts`: the session cookie's name) and the
   * secret Better Auth signs it with. Without it, or with a signature that does not hold,
   * Engine.IO refuses the request before any upgrade or query, with the message
   * `unauthenticated` (403 over polling, 400 on a WebSocket opened without a polling
   * connection); the session behind a valid one is still looked up by the session middleware.
   * Its token keys the handshake cap. Left out (tests without identity), no cookie is needed
   * and no handshake is counted.
   */
  sessionCookie?: { readonly name: string; readonly secret: string };
  /**
   * Socket.IO's adapter (#39: the Redis adapter, `scale-out.ts`); the in-memory one when
   * left out.
   */
  adapter?: ServerOptions["adapter"];
  /**
   * The transports a client may use. Left out, Socket.IO's default (long-polling, then
   * the upgrade to WebSocket). With several instances, `["websocket"]`: one connection
   * stays on one instance, so no sticky sessions are needed (#39).
   */
  transports?: ("polling" | "websocket")[];
  /**
   * Several instances (U4, `shared-limits.ts`): the handshake cap counts in Redis for every
   * instance at once, and this instance's own buckets answer while Redis does not.
   */
  sharedLimits?: Pick<SharedLimits, "tokenBuckets">;
}

/**
 * How long a connection may stay open without a socket: the handshake's CONNECT packet
 * normally follows its upgrade within milliseconds. Socket.IO's default is 45 s, which let
 * one address hold thousands of idle connections.
 */
export const CONNECT_TIMEOUT_MS = 5_000;

/**
 * Sockets one person may hold open at once (tabs, devices): enough for a few tabs, few
 * enough that one session cannot multiply its message budget or the server's work.
 */
export const MAX_SOCKETS_PER_USER = 8;

/**
 * Socket handshakes per session (U2): the connections one session cookie opens, each the
 * polling request that opens one or a WebSocket opened without one (a polling connection's
 * later requests and its upgrade carry its `sid` and are not handshakes). Counted in
 * `allowRequest`, before the session middleware's query, once the Origin check and the cookie's
 * signature passed, which cost no query: a forged cookie is refused for that and spends nothing.
 *
 * Per session, not per address. Behind a proxy the app does not trust (`TRUST_PROXY` too low,
 * as at poker.borden.ch until the owner sets it), every visitor shares one address, so a cap
 * per address would let one client refuse everyone's reconnects; per session, a shared address
 * shares nothing, and a loop spends only its own bucket. A client gets more buckets only by
 * signing in again, which the anonymous sign-in limit holds to 60 a minute per address.
 *
 * Sized for one browser: its tabs share the session, a person holds at most
 * `MAX_SOCKETS_PER_USER` (8) sockets, and a redeploy or a laptop waking up reconnects every tab
 * at once (Socket.IO's backoff, 0.5 to 1.5 s for the first try), one handshake each, on a
 * process whose buckets are new and full. 30 at once covers ten tabs three times over; past it,
 * one a second, and a refused tab tries again quietly while it shows "reconnecting". A loop on
 * one session gets one session lookup a second, and holds at most about 35 connections without
 * a socket (each closed after `CONNECT_TIMEOUT_MS`).
 */
export const HANDSHAKE_LIMIT = { perSecond: 1, burst: 30 } as const;

/**
 * Refused handshakes are logged at most this often: the first at once, then one line for those
 * refused since the line before, until a whole period passes with none.
 */
export const HANDSHAKE_WARN_EVERY_MS = 60_000;

/** One person's sockets and their shared buckets. */
interface Holder {
  sockets: Set<string>;
  bucket: TokenBucket;
  roster: TokenBucket;
  history: TokenBucket;
  queue: TokenBucket;
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

/** The commands that change who is in the room, or how they show (`ROSTER_LIMIT`). */
const ROSTER_COMMANDS: ReadonlySet<Command["type"]> = new Set([
  "join",
  "leave",
  "rename",
  "setAvatar",
  "setRole",
]);

/** The commands that change the queue, each a write of its column (`QUEUE_WRITE_LIMIT`). */
const QUEUE_COMMANDS: ReadonlySet<Command["type"]> = new Set([
  "queueAdd",
  "queueMove",
  "queueRemove",
  "queueClear",
]);

/**
 * Payload cap per message, both transports (architecture section 8). It holds for every
 * frame, before the session is checked: a long paste comes in several commands instead
 * (#52, ADR-024). The domain holds the number, since the page must fit under it.
 */
export const MAX_PAYLOAD_BYTES = MAX_MESSAGE_BYTES;

/**
 * Socket.IO's own parser, with no binary packets: the protocol has none, and a binary
 * packet's first half would wait for its attachments with no timeout. One closes the
 * connection, as a frame that does not parse does.
 */
class TextOnlyDecoder extends Decoder {
  constructor() {
    super({ maxAttachments: 0 });
  }
}
const TEXT_ONLY_PARSER = { Encoder, Decoder: TextOnlyDecoder };

export function createRealtime(httpServer: HttpServer, options: RealtimeOptions): RealtimeServer {
  const {
    logger,
    allowedOrigin,
    handlers = noRoomHandlers,
    middleware = [],
    messageLimit = SOCKET_MESSAGE_LIMIT,
    rosterLimit = ROSTER_LIMIT,
    historyLimit = HISTORY_LIMIT,
    queueLimit = QUEUE_WRITE_LIMIT,
    maxSocketsPerUser = MAX_SOCKETS_PER_USER,
    handshakeLimit = HANDSHAKE_LIMIT,
    handshakeWarnEveryMs = HANDSHAKE_WARN_EVERY_MS,
    responseHeaders = {},
    sessionCookie,
    adapter,
    transports,
    sharedLimits,
  } = options;
  const localHandshakes = createKeyedTokenBuckets(handshakeLimit);
  const handshakes: { take(key: string): boolean | Promise<boolean> } = sharedLimits
    ? sharedLimits.tokenBuckets("handshake", handshakeLimit, localHandshakes)
    : localHandshakes;
  // Only how many were refused and over how long: no address, no token, no room.
  let refused = 0;
  let windowStart = 0;
  let nextReport: ReturnType<typeof setTimeout> | undefined;
  const report = () => {
    nextReport = undefined;
    if (refused === 0) return;
    const at = Date.now();
    logger.warn(
      { refused, windowMs: at - windowStart },
      "socket handshakes refused: too many from one session",
    );
    refused = 0;
    windowStart = at;
    nextReport = setTimeout(report, handshakeWarnEveryMs);
    nextReport.unref();
  };
  const refuseHandshake = () => {
    refused += 1;
    if (nextReport !== undefined) return;
    windowStart = Date.now();
    report();
  };
  httpServer.once("close", () => clearTimeout(nextReport));
  const io: RealtimeServer = new Server(httpServer, {
    ...(adapter && { adapter }),
    ...(transports && { transports }),
    maxHttpBufferSize: MAX_PAYLOAD_BYTES,
    parser: TEXT_ONLY_PARSER,
    serveClient: false,
    connectTimeout: CONNECT_TIMEOUT_MS,
    // Engine.IO calls this for a new connection only, before the upgrade or the session.
    allowRequest: (request, callback) => {
      const origin = request.headers.origin;
      if (origin !== undefined && origin !== allowedOrigin) {
        callback(null, false);
        return;
      }
      if (sessionCookie !== undefined) {
        const { name, secret } = sessionCookie;
        const token = signedSessionToken(request.headers.cookie, name, secret);
        if (token === null) {
          callback("unauthenticated", false);
          return;
        }
        // Engine.IO answers 403 with this message over polling, which the web app reads and
        // retries (`refusalOf`), and a bare 400 on a WebSocket opened without a polling
        // connection, which Socket.IO retries itself.
        const decide = (allowed: boolean) => {
          if (allowed) {
            callback(null, true);
            return;
          }
          refuseHandshake();
          callback("rate_limited", false);
        };
        // In memory the answer comes at once; through Redis it never rejects (U4).
        const taken = handshakes.take(sessionKey(token));
        if (typeof taken === "boolean") decide(taken);
        else void taken.then(decide);
        return;
      }
      callback(null, true);
    },
  });

  // Engine.IO answers the polling requests and the upgrade itself, outside Hono.
  io.engine.on("headers", (headers: Record<string, string>) => {
    Object.assign(headers, responseHeaders);
  });

  // One socket per Engine.IO connection (U2): the cap counts connections, and every CONNECT
  // packet runs the session lookup, so a second one, even while the first is still being
  // looked up, is refused and the connection closed. The web client sends one per connection.
  const asked = new WeakSet<object>();
  io.use(
    closeOnRefusal((socket, next) => {
      if (asked.has(socket.client)) {
        next(new Error("rate_limited"));
        return;
      }
      asked.add(socket.client);
      socket.data.conn = randomBytes(6).toString("base64url");
      next();
    }),
  );
  for (const fn of middleware) io.use(closeOnRefusal(guard(fn, logger)));

  // After the session: the sockets and the message bucket of each person. Without
  // identity (tests), each socket counts as its own person.
  const holders = new Map<string, Holder>();
  const holderKey = (socket: RealtimeSocket) => socket.data.user?.id ?? `socket ${socket.id}`;
  const refillMs =
    Math.max(
      ...[messageLimit, rosterLimit, historyLimit, queueLimit].map(
        (limit) => limit.burst / limit.perSecond,
      ),
    ) * 1000;
  const newHolder = (): Holder => ({
    sockets: new Set(),
    bucket: createTokenBucket(messageLimit),
    roster: createTokenBucket(rosterLimit),
    history: createTokenBucket(historyLimit),
    queue: createTokenBucket(queueLimit),
  });
  const release = (key: string, id: string) => {
    const holder = holders.get(key);
    if (!holder?.sockets.delete(id) || holder.sockets.size > 0) return;
    // Kept until its buckets would be full again: closing every socket and opening new
    // ones does not refill them sooner.
    holder.idle = setTimeout(() => {
      if (holder.sockets.size === 0) holders.delete(key);
    }, refillMs);
    holder.idle.unref();
  };
  io.use(
    closeOnRefusal((socket, next) => {
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
        holder = newHolder();
        holders.set(key, holder);
      }
      clearTimeout(holder.idle);
      holder.idle = undefined;
      holder.sockets.add(socket.id);
      // Released when the socket disconnects, and when the connection closes before the
      // socket ever connected.
      conn.once("close", () => release(key, socket.id));
      next();
    }),
  );

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
      handlers.disconnect?.(socket, !drain.accepting);
    });
    const { bucket, roster, history, queue } = holders.get(key) ?? newHolder();
    const limited = { ok: false, code: "rate_limited" } as const;

    onRaw(socket, log, drain, "enter", async (payload) => {
      if (!bucket.take()) return limited;
      const parsed = parseEnter(payload);
      return parsed.ok ? handlers.enter(socket, parsed.enter) : { ok: false, code: parsed.code };
    });
    onRaw(socket, log, drain, "cmd", async (payload) => {
      if (!bucket.take()) return limited;
      const parsed = toDomainCommand(payload);
      if (!parsed.ok) return { ok: false, code: parsed.code };
      if (ROSTER_COMMANDS.has(parsed.command.type) && !roster.take()) return limited;
      if (QUEUE_COMMANDS.has(parsed.command.type) && !queue.take()) return limited;
      return handlers.cmd(socket, parsed.id, parsed.command);
    });
    onRaw(socket, log, drain, "history", async (payload) => {
      if (!bucket.take()) return limited;
      const parsed = parseHistoryRequest(payload);
      if (!parsed.ok) return { ok: false, code: parsed.code };
      if (!history.take()) return limited;
      return handlers.history
        ? handlers.history(socket, parsed.request)
        : { ok: false, code: "room_not_found" };
    });
    onRaw(socket, log, drain, "queue", async (payload) => {
      if (!bucket.take()) return limited;
      const parsed = parseQueueRequest(payload);
      if (!parsed.ok) return { ok: false, code: parsed.code };
      if (!history.take()) return limited;
      return handlers.queue ? handlers.queue(socket) : { ok: false, code: "room_not_found" };
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
 * Closes the connection once a middleware refused its socket: Socket.IO sends the
 * `connect_error` and would keep the connection open for another try. The client gives up
 * on a refusal anyway (`connectWhenIdentified` connects again on a new connection), so an
 * open one only holds memory. `setImmediate` runs after Socket.IO wrote the refusal
 * (`process.nextTick`), and Engine.IO closes once that packet has left.
 */
function closeOnRefusal(fn: SocketMiddleware): SocketMiddleware {
  return (socket, next) =>
    fn(socket, (err) => {
      next(err);
      if (err) setImmediate(() => socket.client.conn.close());
    });
}

/**
 * Listens to an event without trusting its arguments: the first one is the payload, the
 * last one the ack when it is a function. A message without an ack is still handled (its
 * answer is dropped); a throwing handler answers `internal` and logs the error. Each
 * message is tracked until its answer is sent; while the server drains, a new one is
 * dropped unanswered.
 */
function onRaw<A extends EnterAck | CmdAck | HistoryAck | QueueAck>(
  socket: RealtimeSocket,
  log: Logger,
  drain: Drain,
  event: "enter" | "cmd" | "history" | "queue",
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
