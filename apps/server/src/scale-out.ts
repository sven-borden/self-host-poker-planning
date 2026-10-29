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
 * error code.
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
    socket: { reconnectStrategy: (retries: number) => Math.min(100 * 2 ** retries, 2_000) },
  };
  const pub = createClient(options);
  const sub = pub.duplicate();
  const commands = pub.duplicate({ disableOfflineQueue: true });
  const clients = [pub, sub, commands];

  let available = false;
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

  const destroy = () => {
    for (const client of clients) {
      if (client.isOpen) client.destroy();
    }
  };
  try {
    const connected = Promise.all(clients.map((client) => client.connect()));
    connected.catch(() => {});
    const aborted = new Promise<never>((_, reject) => {
      signal?.addEventListener("abort", () => reject(new RedisUnavailableError()), { once: true });
    });
    aborted.catch(() => {});
    signal?.throwIfAborted();
    await Promise.race([within(connected, budgetMs), aborted]);
  } catch {
    destroy();
    log.error("redis: unavailable");
    throw new RedisUnavailableError();
  }
  if (!available) {
    available = true;
    log.info("redis: connected");
  }

  const adapter = createAdapter(pub, sub, {
    key: CHANNEL_PREFIX,
    requestsTimeout: CLUSTER_REQUEST_TIMEOUT_MS,
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
      await Promise.allSettled(clients.map((client) => within(client.close(), 2_000)));
      destroy();
    },
  };
}
