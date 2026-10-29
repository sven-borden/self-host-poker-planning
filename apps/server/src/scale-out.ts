/**
 * Several instances behind one address (#39, ADR-016): with `REDIS_URL`, Socket.IO's Redis
 * adapter carries the room sync's messages between instances (`sync/room-sync.ts`: a room
 * changed, who is here, which rooms are in use) and Redis holds the command ids
 * (`sync/shared-acks.ts`). Without it, nothing here runs and neither package is loaded:
 * `setup.ts` calls `connectScaleOut` only when the variable is set, and the packages are
 * imported then.
 *
 * Three connections: the adapter's publisher and subscriber, and one for the command ids
 * that fails at once while Redis is away (no offline queue), so a command never waits for
 * it. The URL may hold a password: no log line here carries it, nor any message of the
 * driver's (they name the host); only "redis: connected" and "redis: unavailable" with an
 * error code, once per change of state.
 *
 * The start fails when Redis cannot be reached within 30 s, as for the database. Once
 * started, losing Redis never takes the instance down: the adapter fires its publishes
 * and (un)subscribes without catching them, and node-redis rejects the commands in flight
 * when the connection drops, so `catchFireAndForget` gives each of those promises a
 * handler (an unhandled rejection exits the process, `run.ts`). Each instance then serves
 * its own sockets alone until the connection is back.
 *
 * Redis must be trusted (README, "Running several instances"): the adapter answers any
 * client of it that asks for the sockets (their handshake headers, session cookie
 * included) and obeys a broadcast or a disconnect published by anyone.
 */
import type { RedisAdapter } from "@socket.io/redis-adapter";
import type { Logger } from "./logger.ts";
import { type AckCommands, redisAcks, type SharedAcks, within } from "./sync/shared-acks.ts";

/** How long the start waits for Redis before it gives up (as for the database). */
export const REDIS_CONNECT_BUDGET_MS = 30_000;
/** How long the adapter waits for the other instances' answers. */
export const CLUSTER_REQUEST_TIMEOUT_MS = 2_000;
/** `/api/health` gives up on Redis after this. */
const PING_TIMEOUT_MS = 1_000;
/** The adapter's channel prefix: `pp#/#room:<id>#`, never a room code. */
const CHANNEL_PREFIX = "pp";
/** Commands queued while Redis is away, at most; past it, a publish fails (and is dropped). */
const OFFLINE_QUEUE_MAX = 10_000;

export type RedisStatus = "ok" | "down";

export interface ScaleOut {
  /** For Socket.IO's `adapter` option. */
  readonly adapter: (nsp: unknown) => RedisAdapter;
  /** The command ids shared by every instance. */
  readonly acks: SharedAcks;
  /** For `/api/health`: whether Redis answers a PING now. */
  ping(): Promise<RedisStatus>;
  /** Closes the three connections. After the Socket.IO server closed (its adapter). */
  close(): Promise<void>;
}

export interface ScaleOutOptions {
  /** Aborts the wait: a signal during the start. */
  signal?: AbortSignal;
  budgetMs?: number;
}

/** The error the start fails with: a fixed message, never the URL or the driver's text. */
export class RedisUnavailableError extends Error {
  constructor() {
    super("redis: unavailable");
    this.name = "RedisUnavailableError";
  }
}

/** A driver error's code (`ECONNREFUSED`, `NOAUTH` …); never its message. */
function codeOf(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === "string" && /^[A-Z][A-Z0-9_]{1,31}$/.test(code)) return code;
  const name = (error as { name?: unknown } | null)?.name;
  return typeof name === "string" && /^\w{1,40}$/.test(name) ? name : "unknown";
}

/** The client methods the adapter calls without awaiting or catching what they return. */
const FIRE_AND_FORGET = [
  "publish",
  "sPublish",
  "subscribe",
  "pSubscribe",
  "sSubscribe",
  "unsubscribe",
  "pUnsubscribe",
  "sUnsubscribe",
  "sendCommand",
] as const;

const ignore = () => {};

/**
 * Gives every promise the adapter's calls return a rejection handler, and still returns
 * that promise, so a caller that awaits it sees the failure. Without it, a connection that
 * drops with a publish in flight (a Redis restart) rejects it unhandled, and the process
 * exits. In place, on the client's own methods (node-redis keeps private state on it).
 */
export function catchFireAndForget<T extends object>(client: T): T {
  const methods = client as unknown as Record<string, unknown>;
  for (const name of FIRE_AND_FORGET) {
    const original = methods[name];
    if (typeof original !== "function") continue;
    methods[name] = (...args: unknown[]) => {
      const result: unknown = original.apply(client, args);
      if (typeof (result as Promise<unknown> | null)?.catch === "function") {
        (result as Promise<unknown>).catch(ignore);
      }
      return result;
    };
  }
  return client;
}

export async function connectScaleOut(
  url: string,
  logger: Logger,
  { signal, budgetMs = REDIS_CONNECT_BUDGET_MS }: ScaleOutOptions = {},
): Promise<ScaleOut> {
  const [{ createClient }, { createAdapter }] = await Promise.all([
    import("@redis/client"),
    import("@socket.io/redis-adapter"),
  ]);
  const log = logger.child({ part: "redis" });
  const options = {
    url,
    // The adapter speaks node-redis 4's RESP2 replies (PUBSUB NUMSUB as an array).
    RESP: 2 as const,
    commandsQueueMaxLength: OFFLINE_QUEUE_MAX,
    socket: { reconnectStrategy: (retries: number) => Math.min(100 * 2 ** retries, 2_000) },
  };
  const open = () => createClient(options);
  type Client = ReturnType<typeof open>;
  let clients: Client[] = [];
  let available = false;
  const destroy = () => {
    for (const client of clients) {
      // Rejects whatever is still queued: the adapter's calls are caught, the rest awaited.
      if (client.isOpen) client.destroy();
    }
  };
  let pub: Client;
  let sub: Client;
  let commands: Client;
  try {
    // Inside the try: a URL the driver refuses fails like an unreachable Redis, with the
    // fixed message (the driver's could name the URL).
    pub = catchFireAndForget(open());
    sub = catchFireAndForget(pub.duplicate());
    commands = pub.duplicate({ disableOfflineQueue: true });
    clients = [pub, sub, commands];
    for (const client of clients) {
      // node-redis throws an `error` event nobody listens to: every client has a listener.
      client.on("error", (error: unknown) => {
        if (!available) return;
        available = false;
        log.warn({ err: codeOf(error) }, "redis: unavailable");
      });
      client.on("ready", () => {
        if (available || !clients.every((c) => c.isReady)) return;
        available = true;
        log.info("redis: connected");
      });
    }
    const connected = Promise.all(clients.map((client) => client.connect()));
    connected.catch(ignore);
    const aborted = new Promise<never>((_, reject) => {
      signal?.addEventListener("abort", () => reject(new RedisUnavailableError()), { once: true });
    });
    aborted.catch(ignore);
    signal?.throwIfAborted();
    await Promise.race([within(connected, budgetMs), aborted]);
  } catch {
    destroy();
    // A stop during the start (SIGTERM) is no failure of Redis: `run.ts` says why it stops.
    if (!signal?.aborted) log.error("redis: unavailable");
    throw new RedisUnavailableError();
  }
  if (!available) {
    available = true;
    log.info("redis: connected");
  }

  const adapter = createAdapter(pub, sub, {
    key: CHANNEL_PREFIX,
    requestsTimeout: CLUSTER_REQUEST_TIMEOUT_MS,
    // Answers go to the asking instance's own channel, not to every instance.
    publishOnSpecificResponseChannel: true,
  }) as (nsp: unknown) => RedisAdapter;
  let closed = false;
  return {
    adapter,
    acks: redisAcks(commands as unknown as AckCommands),
    ping: async () => {
      try {
        return (await within(commands.ping(), PING_TIMEOUT_MS)) === "PONG" ? "ok" : "down";
      } catch {
        return "down";
      }
    },
    close: async () => {
      if (closed) return;
      closed = true;
      available = false;
      // With Redis away, `close` waits for a reconnect that may never come: give up after
      // 2 s and destroy, which rejects what is queued (caught: the shutdown exits 0).
      await Promise.allSettled(
        clients.map((client) => {
          const closing = client.close();
          closing.catch(ignore);
          return within(closing, 2_000);
        }),
      );
      destroy();
    },
  };
}
