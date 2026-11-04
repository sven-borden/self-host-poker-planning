/**
 * Limits shared by every instance through Redis (U4). With `REDIS_URL`, the app's rate limiter
 * (Better Auth's endpoints, room creation and header reads, the password guard, and every other
 * route that counts with `rate-limit.ts`) and the socket handshake cap (`realtime.ts`) count in
 * Redis, so N instances behind one load balancer allow what one would, not N times as much.
 * Without it nothing here runs: `setup.ts` builds these from `scale-out.ts` only when the
 * variable is set, and the in-memory limiter and buckets stay as they are.
 *
 * Each limit keeps its in-memory counter too, which counts every call this instance sees while
 * Redis answers. When Redis does not answer (an error, or no answer within `LIMIT_TIMEOUT_MS`),
 * that counter decides instead, and the next `LIMIT_LOCAL_FOR_MS` go straight to it: a limit
 * never falls open (a password room stays closed to guessing at its per-instance numbers) and
 * never shut (a handshake or a room creation still passes as on one instance). A Redis error
 * never reaches a request. The connection is `scale-out.ts`'s one without an offline queue, so
 * a Redis that is away fails at once and only a stalled one costs the timeout.
 *
 * One atomic Lua script per call, the same arithmetic as the in-memory versions (the unit and
 * db tests hold them to the same answers), on Redis's own clock (`TIME`), so instances whose
 * clocks differ share one window. Every key has a TTL: a window's lasts until it ends, a
 * bucket's until it would be full again. A key never holds what it counts in clear (an
 * address, a session, a room's id or a person's): it is an HMAC of it under a key derived from
 * `BETTER_AUTH_SECRET`, so a dump of Redis cannot be turned back into addresses by trying
 * every one, and is `<prefix>:rl:<hmac>` (fixed windows) or `<prefix>:tb:<name>:<hmac>`
 * (token buckets).
 */
import { createHash, createHmac } from "node:crypto";
import type { Logger } from "./logger.ts";
import type { RateLimiter, RateLimitResult, RateLimitRule } from "./rate-limit.ts";
import { within } from "./sync/shared-acks.ts";
import type { KeyedTokenBuckets, TokenBucketOptions } from "./sync/token-bucket.ts";

/**
 * A limit's call to Redis gives up after this and the instance's own counter answers: a
 * handshake or a sign-in waits at most this long for a stalled Redis. A script takes well
 * under a millisecond on the network the instances share with Redis.
 */
export const LIMIT_TIMEOUT_MS = 250;
/** After a failure, limits count on the instance alone this long before asking Redis again. */
export const LIMIT_LOCAL_FOR_MS = 5_000;

/** The two Redis commands this needs (`@redis/client`'s names and shapes). */
export interface LimitCommands {
  evalSha(sha: string, options: { keys: string[]; arguments: string[] }): Promise<unknown>;
  eval(script: string, options: { keys: string[]; arguments: string[] }): Promise<unknown>;
}

/** Token buckets whose answer may come from Redis: never rejects. */
export interface SharedTokenBuckets {
  take(key: string): Promise<boolean>;
}

export interface SharedLimits {
  /** The app's rate limiter in Redis, `local` answering when Redis does not. */
  rateLimiter(local: RateLimiter): RateLimiter;
  /** Keyed token buckets in Redis under `name`, `local` answering when Redis does not. */
  tokenBuckets(
    name: string,
    limit: Pick<TokenBucketOptions, "perSecond" | "burst">,
    local: KeyedTokenBuckets,
  ): SharedTokenBuckets;
}

export interface SharedLimitsOptions {
  redis: LimitCommands;
  /** `REDIS_KEY_PREFIX`. */
  prefix: string;
  /** `BETTER_AUTH_SECRET`: the keys' HMAC key is derived from it. Never logged. */
  secret: string;
  logger: Logger;
  timeoutMs?: number;
  localForMs?: number;
  /** For tests: the scripts' clock in milliseconds, instead of Redis's `TIME`. */
  scriptNow?: () => number;
  /** For tests: the clock of `localForMs`. */
  now?: () => number;
}

/** A driver error's code (`ECONNREFUSED`, `NOAUTH` …); never its message. */
export function redisErrorCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === "string" && /^[A-Z][A-Z0-9_]{1,31}$/.test(code)) return code;
  const name = (error as { name?: unknown } | null)?.name;
  return typeof name === "string" && /^\w{1,40}$/.test(name) ? name : "unknown";
}

const UNEXPECTED_REPLY = "unexpected reply";

/**
 * A refusal by Redis, which waiting does not heal: the word its error reply starts with
 * (`NOPERM` for a user without `+@scripting`, `READONLY` for a replica, `OOM`, `WRONGTYPE`,
 * `ERR` …), or `unexpected_reply` when the answer was none of the script's.
 */
function refusalCode(error: unknown): string | undefined {
  if (!(error instanceof Error)) return undefined;
  if (error.message === UNEXPECTED_REPLY) return "unexpected_reply";
  return /^([A-Z][A-Z_]{1,19})(?:\s|$)/.exec(error.message)?.[1];
}

/**
 * Why a limit's call failed, as a short code and never the message: `timeout` (no answer
 * within `LIMIT_TIMEOUT_MS`), `offline` or `closed` (node-redis 6 has no connection: these
 * errors carry no `code` and are named `Error`), a refusal's code (`refusalCode`), else
 * `redisErrorCode`.
 */
export function limitErrorCode(error: unknown): string {
  if (error instanceof Error) {
    if (error.message === "timeout") return "timeout";
    if (error.message === "The client is offline") return "offline";
    if (error.message === "The client is closed") return "closed";
  }
  return refusalCode(error) ?? redisErrorCode(error);
}

/** The clock both scripts start from: the caller's (tests), else Redis's own. */
const CLOCK = `
local now = tonumber(ARGV[1])
if not now then
  local time = redis.call('TIME')
  now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
end`;

/**
 * A fixed window, as `memoryRateLimit`: the first call opens a window of `ARGV[2]` ms, each
 * allowed call counts one, a refused one counts nothing. Answers `{ allowed, reset, now }`.
 */
export const FIXED_WINDOW_SCRIPT = `${CLOCK}
now = math.floor(now)
local window = tonumber(ARGV[2])
local max = tonumber(ARGV[3])
local entry = redis.call('HMGET', KEYS[1], 'c', 'r')
local count = tonumber(entry[1])
local reset = tonumber(entry[2])
if not count or not reset or reset <= now then
  reset = now + window
  redis.call('HSET', KEYS[1], 'c', 1, 'r', string.format('%.0f', reset))
  redis.call('PEXPIRE', KEYS[1], window)
  return {1, reset, now}
end
if count >= max then
  return {0, reset, now}
end
redis.call('HINCRBY', KEYS[1], 'c', 1)
return {1, reset, now}`;

/**
 * Takes back one call counted in the window that ends at `ARGV[2]`, if it is still that one
 * (`ARGV[1]`, the clock, is unused).
 */
export const RELEASE_SCRIPT = `
local entry = redis.call('HMGET', KEYS[1], 'c', 'r')
local count = tonumber(entry[1])
if count and count > 0 and entry[2] == ARGV[2] then
  redis.call('HINCRBY', KEYS[1], 'c', -1)
end
return 0`;

/**
 * A token bucket, as `createKeyedTokenBuckets`: `ARGV[3]` tokens to start with, refilled at
 * `ARGV[2]` a second; a take answers 1 and spends one, or 0. The key lives until the bucket
 * would be full again, which is the same as no key.
 */
export const TOKEN_BUCKET_SCRIPT = `${CLOCK}
local rate = tonumber(ARGV[2])
local burst = tonumber(ARGV[3])
local entry = redis.call('HMGET', KEYS[1], 't', 'l')
local tokens = tonumber(entry[1])
local last = tonumber(entry[2])
if not tokens or not last then
  tokens = burst
else
  tokens = math.min(burst, tokens + math.max(0, now - last) / 1000 * rate)
end
local allowed = 0
if tokens >= 1 then
  tokens = tokens - 1
  allowed = 1
end
redis.call('HSET', KEYS[1], 't', string.format('%.17g', tokens), 'l', string.format('%.17g', now))
redis.call('PEXPIRE', KEYS[1], math.ceil((burst - tokens) / rate * 1000) + 1)
return allowed`;

interface Script {
  source: string;
  sha: string;
}
const script = (source: string): Script => ({
  source,
  sha: createHash("sha1").update(source).digest("hex"),
});
const FIXED_WINDOW = script(FIXED_WINDOW_SCRIPT);
const RELEASE = script(RELEASE_SCRIPT);
const TOKEN_BUCKET = script(TOKEN_BUCKET_SCRIPT);

const isNoScript = (error: unknown) =>
  error instanceof Error && error.message.startsWith("NOSCRIPT");

export function createSharedLimits({
  redis,
  prefix,
  secret,
  logger,
  timeoutMs = LIMIT_TIMEOUT_MS,
  localForMs = LIMIT_LOCAL_FOR_MS,
  scriptNow,
  now = () => performance.now(),
}: SharedLimitsOptions): SharedLimits {
  const log = logger.child({ part: "redis" });
  const keyKey = createHmac("sha256", secret).update("pp shared limit keys").digest();
  const hashed = (key: string) =>
    createHmac("sha256", keyKey).update(key).digest("base64url").slice(0, 32);

  /** Runs a script by its digest, sending it once when Redis does not hold it yet. */
  const run = async (s: Script, key: string, args: string[]) => {
    const options = { keys: [key], arguments: [scriptNow ? String(scriptNow()) : "", ...args] };
    try {
      return await redis.evalSha(s.sha, options);
    } catch (error) {
      if (!isNoScript(error)) throw error;
      return await redis.eval(s.source, options);
    }
  };

  let localUntil = Number.NEGATIVE_INFINITY;
  let shared = true;
  /** What Redis answered, or undefined when it did not (and the local counter decides). */
  const attempt = async <T>(call: () => Promise<T>): Promise<T | undefined> => {
    const startedAt = now();
    if (startedAt < localUntil) return undefined;
    try {
      const answer = await within(Promise.resolve().then(call), timeoutMs);
      // A call that started before a failure says nothing of Redis since: only one that
      // started after the local window is a sign that Redis is back.
      if (!shared && startedAt >= localUntil) {
        shared = true;
        log.info("rate limits: shared through redis again");
      }
      return answer;
    } catch (error) {
      localUntil = now() + localForMs;
      if (shared) {
        shared = false;
        const err = limitErrorCode(error);
        const message = "rate limits: redis unavailable, counting on this instance";
        // A refusal (no right to run scripts, a read-only replica, a full Redis) does not
        // pass by waiting: every limit stays per instance until someone fixes it.
        if (refusalCode(error) === undefined) log.warn({ err }, message);
        else log.error({ err }, message);
      }
      return undefined;
    }
  };

  /** One call in the fixed window under `key`: Redis's answer, or a throw. */
  const fixedWindow = async (key: string, { window, max }: RateLimitRule) => {
    const reply = await run(FIXED_WINDOW, key, [String(window * 1000), String(max)]);
    const [allowed, reset, at] = Array.isArray(reply) ? reply : [];
    if (typeof allowed !== "number" || typeof reset !== "number" || typeof at !== "number") {
      throw new Error(UNEXPECTED_REPLY);
    }
    return {
      allowed: allowed === 1,
      retryAfter: allowed === 1 ? null : Math.ceil((reset - at) / 1000),
      reset,
    };
  };

  return {
    rateLimiter(local) {
      return {
        async consume(key, rule): Promise<RateLimitResult> {
          const mine = await local.consume(key, rule);
          const answer = await attempt(() => fixedWindow(`${prefix}:rl:${hashed(key)}`, rule));
          return answer ? { allowed: answer.allowed, retryAfter: answer.retryAfter } : mine;
        },
        async reserve(key, rule) {
          const mine = await local.reserve(key, rule);
          const redisKey = `${prefix}:rl:${hashed(key)}`;
          const answer = await attempt(() => fixedWindow(redisKey, rule));
          if (!answer) return mine;
          let held = answer.allowed;
          return {
            allowed: answer.allowed,
            retryAfter: answer.retryAfter,
            release: () => {
              mine.release();
              if (!held) return;
              held = false;
              // Not awaited: a release Redis misses leaves the call counted, never more.
              void attempt(() => run(RELEASE, redisKey, [String(answer.reset)]));
            },
          };
        },
      };
    },
    tokenBuckets(name, { perSecond, burst }, local) {
      const args = [String(perSecond), String(burst)];
      return {
        async take(key) {
          const mine = local.take(key);
          const answer = await attempt(async () => {
            const reply = await run(TOKEN_BUCKET, `${prefix}:tb:${name}:${hashed(key)}`, args);
            if (reply !== 0 && reply !== 1) throw new Error(UNEXPECTED_REPLY);
            return reply === 1;
          });
          return answer ?? mine;
        },
      };
    },
  };
}
