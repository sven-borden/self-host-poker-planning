/**
 * The shared limits' plumbing (U4) against a stand-in Redis: which answer wins, when the
 * instance's own counters decide, the keys, and the scripts' loading. The scripts themselves
 * run against a real Redis in `shared-limits.db.test.ts`, held to the in-memory answers.
 */
import { describe, expect, it, vi } from "vitest";
import { memoryRateLimit } from "./rate-limit.ts";
import {
  createSharedLimits,
  FIXED_WINDOW_SCRIPT,
  LIMIT_LOCAL_FOR_MS,
  LIMIT_TIMEOUT_MS,
  type LimitCommands,
  limitErrorCode,
  redisErrorCode,
  TOKEN_BUCKET_SCRIPT,
} from "./shared-limits.ts";
import { createKeyedTokenBuckets } from "./sync/token-bucket.ts";
import { collectLogs } from "./test-support.ts";

const SECRET = "a-test-secret-of-at-least-32-characters";
const RULE = { window: 60, max: 2 };
const RULE_BUCKET = { perSecond: 1, burst: 30 };

interface Call {
  how: "evalSha" | "eval";
  script: string;
  keys: string[];
  args: string[];
}

/**
 * A stand-in for Redis: `answer` decides each script's reply (or throws); every call is kept.
 * `knows` is whether Redis holds the scripts already (else `evalSha` fails with NOSCRIPT).
 */
function fakeRedis(answer: (call: Call) => unknown | Promise<unknown>, knows = true) {
  const calls: Call[] = [];
  const known = new Set<string>();
  const redis: LimitCommands & { calls: Call[] } = {
    calls,
    evalSha: async (sha, { keys, arguments: args }) => {
      const call = { how: "evalSha" as const, script: sha, keys, args };
      calls.push(call);
      if (!knows && !known.has(sha)) throw new Error("NOSCRIPT No matching script.");
      return answer(call);
    },
    eval: async (script, { keys, arguments: args }) => {
      const call = { how: "eval" as const, script, keys, args };
      calls.push(call);
      const { createHash } = await import("node:crypto");
      known.add(createHash("sha1").update(script).digest("hex"));
      return answer(call);
    },
  };
  return redis;
}

/** What node-redis 6 throws for a command while it has no connection: no `code`, named Error. */
const refused = new Error("The client is offline");
/** What Redis answers a user without `+@scripting`. */
const noPermission = new Error("NOPERM this user has no permissions to run the 'evalsha' command");

function limits(redis: LimitCommands, options: { now?: () => number; prefix?: string } = {}) {
  const logs = collectLogs("debug");
  const shared = createSharedLimits({
    redis,
    prefix: options.prefix ?? "pp",
    secret: SECRET,
    logger: logs.logger,
    ...(options.now && { now: options.now }),
  });
  return { shared, logs };
}

describe("shared limits (U4)", () => {
  it("answers with Redis's verdict while Redis answers, the local counter counting too", async () => {
    const redis = fakeRedis(() => [1, 61_000, 1_000]);
    const local = memoryRateLimit();
    const limiter = limits(redis).shared.rateLimiter(local);
    // Redis allows past the local max: its count is everyone's, and it wins.
    for (let i = 0; i < 3; i++) {
      expect(await limiter.consume("rooms|create|192.0.2.1", RULE)).toEqual({
        allowed: true,
        retryAfter: null,
      });
    }
    // The local counter saw every call: it would refuse now.
    expect((await local.consume("rooms|create|192.0.2.1", RULE)).allowed).toBe(false);
    const refusal = fakeRedis(() => [0, 61_000, 1_000]);
    expect(await limits(refusal).shared.rateLimiter(memoryRateLimit()).consume("k", RULE)).toEqual({
      allowed: false,
      retryAfter: 60,
    });
  });

  it("counts on the instance when Redis fails, for a while, then asks Redis again", async () => {
    let clock = 0;
    let down = true;
    const redis = fakeRedis(() => {
      if (down) throw refused;
      return [1, 61_000, 1_000];
    });
    const { shared, logs } = limits(redis, { now: () => clock });
    const limiter = shared.rateLimiter(memoryRateLimit());
    expect(await limiter.consume("password|ip|192.0.2.1", RULE)).toEqual({
      allowed: true,
      retryAfter: null,
    });
    expect(await limiter.consume("password|ip|192.0.2.1", RULE)).toEqual({
      allowed: true,
      retryAfter: null,
    });
    // Never open: past the local max it refuses, as one instance would.
    const third = await limiter.consume("password|ip|192.0.2.1", RULE);
    expect(third.allowed).toBe(false);
    expect(third.retryAfter).toBeGreaterThan(0);
    // Only the first call asked Redis: the next ones went straight to the local counter.
    expect(redis.calls).toHaveLength(1);
    down = false;
    clock += LIMIT_LOCAL_FOR_MS - 1;
    await limiter.consume("other", RULE);
    expect(redis.calls).toHaveLength(1);
    clock += 1;
    expect((await limiter.consume("password|ip|192.0.2.1", RULE)).allowed).toBe(true);
    expect(redis.calls).toHaveLength(2);
    const lines = logs.lines.filter((line) => line.part === "redis");
    expect(lines.map((line) => [line.level, line.msg, line.err])).toEqual([
      [40, "rate limits: redis unavailable, counting on this instance", "offline"],
      [30, "rate limits: shared through redis again", undefined],
    ]);
    // No address, key or secret in any line.
    for (const raw of logs.raw) {
      expect(raw).not.toContain("192.0.2.1");
      expect(raw).not.toContain(SECRET);
    }
  });

  it("gives up on a stalled Redis after the timeout and lets the handshake through locally", async () => {
    const redis = fakeRedis(() => new Promise(() => {}));
    const { shared, logs } = limits(redis);
    const buckets = shared.tokenBuckets(
      "handshake",
      { perSecond: 1, burst: 2 },
      createKeyedTokenBuckets({ perSecond: 1, burst: 2 }),
    );
    const started = performance.now();
    expect(await buckets.take("session")).toBe(true);
    const waited = performance.now() - started;
    expect(waited).toBeGreaterThanOrEqual(LIMIT_TIMEOUT_MS - 5);
    expect(waited).toBeLessThan(LIMIT_TIMEOUT_MS + 500);
    // The next one does not wait: local for a while, and still a limit.
    const next = performance.now();
    expect(await buckets.take("session")).toBe(true);
    expect(await buckets.take("session")).toBe(false);
    expect(performance.now() - next).toBeLessThan(100);
    expect(logs.lines.map((line) => [line.level, line.msg, line.err])).toEqual([
      [40, "rate limits: redis unavailable, counting on this instance", "timeout"],
    ]);
  });

  it("logs a refusal by Redis as an error, by its code: waiting will not heal it", async () => {
    let clock = 0;
    const redis = fakeRedis(() => {
      throw noPermission;
    });
    const { shared, logs } = limits(redis, { now: () => clock });
    const limiter = shared.rateLimiter(memoryRateLimit());
    expect((await limiter.consume("rooms|create|192.0.2.1", RULE)).allowed).toBe(true);
    clock += LIMIT_LOCAL_FOR_MS;
    expect((await limiter.consume("rooms|create|192.0.2.1", RULE)).allowed).toBe(true);
    expect(redis.calls).toHaveLength(2);
    // One line, at error level, naming the refusal and nothing of the message's rest.
    expect(logs.lines.map((line) => [line.level, line.msg, line.err])).toEqual([
      [50, "rate limits: redis unavailable, counting on this instance", "NOPERM"],
    ]);
    for (const raw of logs.raw) expect(raw).not.toContain("evalsha");
  });

  it("does not call Redis back by a late answer to a call that started before the failure", async () => {
    let clock = 0;
    const replies: ((value: unknown) => void)[] = [];
    let fail = false;
    const redis = fakeRedis(() => {
      if (fail) throw refused;
      return new Promise((resolve) => replies.push(resolve));
    });
    const { shared, logs } = limits(redis, { now: () => clock });
    const limiter = shared.rateLimiter(memoryRateLimit());
    const slow = limiter.consume("a", RULE);
    await vi.waitFor(() => expect(replies).toHaveLength(1));
    fail = true;
    await limiter.consume("b", RULE);
    // The slow call's answer comes now, inside the local window: Redis is not back for that.
    replies[0]?.([1, 61_000, 1_000]);
    expect(await slow).toEqual({ allowed: true, retryAfter: null });
    expect(logs.messages()).toEqual(["rate limits: redis unavailable, counting on this instance"]);
    // A call that starts after the window and is answered is.
    fail = false;
    clock += LIMIT_LOCAL_FOR_MS;
    const next = limiter.consume("c", RULE);
    await vi.waitFor(() => expect(replies).toHaveLength(2));
    replies[1]?.([1, 61_000, 1_000]);
    await next;
    expect(logs.messages()).toEqual([
      "rate limits: redis unavailable, counting on this instance",
      "rate limits: shared through redis again",
    ]);
  });

  it("takes Redis's bucket over the local one, and the local one when the reply is not one", async () => {
    let reply: unknown = 1;
    const redis = fakeRedis(() => reply);
    const local = createKeyedTokenBuckets({ perSecond: 0.001, burst: 1 });
    const buckets = limits(redis).shared.tokenBuckets(
      "handshake",
      { perSecond: 1, burst: 1 },
      local,
    );
    expect(await buckets.take("s")).toBe(true);
    expect(await buckets.take("s")).toBe(true);
    reply = 0;
    expect(await buckets.take("s")).toBe(false);
    reply = "garbage";
    // An answer that is no verdict counts as no answer: the local bucket, spent, refuses.
    expect(await buckets.take("s")).toBe(false);
  });

  it("keys by an HMAC under the deployment's prefix, never the address or session in clear", async () => {
    const redis = fakeRedis((call) => (call.keys[0]?.includes(":tb:") ? 1 : [1, 2, 1]));
    const { shared } = limits(redis, { prefix: "team_b" });
    await shared.rateLimiter(memoryRateLimit()).consume("rooms|create|192.0.2.1", RULE);
    await shared.rateLimiter(memoryRateLimit()).consume("rooms|create|192.0.2.1", RULE);
    await shared.rateLimiter(memoryRateLimit()).consume("rooms|create|192.0.2.2", RULE);
    await shared
      .tokenBuckets("handshake", { perSecond: 1, burst: 30 }, createKeyedTokenBuckets(RULE_BUCKET))
      .take("session-hash");
    const keys = redis.calls.map((call) => call.keys[0] ?? "");
    expect(keys[0]).toMatch(/^team_b:rl:[\w-]{32}$/);
    expect(keys[1]).toBe(keys[0]);
    expect(keys[2]).not.toBe(keys[0]);
    expect(keys[3]).toMatch(/^team_b:tb:handshake:[\w-]{32}$/);
    for (const key of keys) {
      expect(key).not.toContain("192.0.2");
      expect(key).not.toContain("session-hash");
      expect(key).not.toContain("rooms");
    }
    // Another secret, another key: a dump of one deployment's Redis says nothing of another's.
    const other = fakeRedis(() => [1, 2, 1]);
    await createSharedLimits({
      redis: other,
      prefix: "team_b",
      secret: "another-secret-of-at-least-32-characters",
      logger: collectLogs().logger,
    })
      .rateLimiter(memoryRateLimit())
      .consume("rooms|create|192.0.2.1", RULE);
    expect(other.calls[0]?.keys[0]).not.toBe(keys[0]);
  });

  it("sends a script once when Redis does not hold it, then by its digest", async () => {
    const redis = fakeRedis(() => [1, 2, 1], false);
    const limiter = limits(redis).shared.rateLimiter(memoryRateLimit());
    await limiter.consume("a", RULE);
    await limiter.consume("b", RULE);
    expect(redis.calls.map((call) => call.how)).toEqual(["evalSha", "eval", "evalSha"]);
    expect(redis.calls[1]?.script).toBe(FIXED_WINDOW_SCRIPT);
    // The clock is Redis's own (an empty first argument), the window in ms and the max.
    expect(redis.calls[0]?.args).toEqual(["", "60000", "2"]);
    const buckets = fakeRedis(() => 1, false);
    await limits(buckets)
      .shared.tokenBuckets("h", { perSecond: 0.5, burst: 30 }, createKeyedTokenBuckets(RULE_BUCKET))
      .take("s");
    expect(buckets.calls[1]?.script).toBe(TOKEN_BUCKET_SCRIPT);
    expect(buckets.calls[1]?.args).toEqual(["", "0.5", "30"]);
  });

  it("takes back a reserved try in Redis and locally, once, and only in its own window", async () => {
    const redis = fakeRedis((call) => (call.args.length === 3 ? [1, 601_000, 1_000] : 0));
    const local = memoryRateLimit();
    const limiter = limits(redis).shared.rateLimiter(local);
    const rule = { window: 600, max: 1 };
    const slot = await limiter.reserve("password|user|room|me", rule);
    expect(slot.allowed).toBe(true);
    slot.release();
    slot.release();
    await new Promise((resolve) => setTimeout(resolve, 10));
    const releases = redis.calls.filter((call) => call.args.length === 2);
    expect(releases).toHaveLength(1);
    // The window it counted in, by its end.
    expect(releases[0]?.args).toEqual(["", "601000"]);
    expect(releases[0]?.keys).toEqual(redis.calls[0]?.keys);
    // The local counter was released too: its one try is free again.
    expect((await local.consume("password|user|room|me", rule)).allowed).toBe(true);
    // A refused try holds nothing to give back.
    const refusing = fakeRedis(() => [0, 601_000, 1_000]);
    const none = await limits(refusing).shared.rateLimiter(memoryRateLimit()).reserve("k", rule);
    expect(none).toMatchObject({ allowed: false, retryAfter: 600 });
    none.release();
    expect(refusing.calls).toHaveLength(1);
  });

  it("falls back to the local reservation when Redis fails, which still holds", async () => {
    const redis = fakeRedis(() => {
      throw refused;
    });
    const limiter = limits(redis).shared.rateLimiter(memoryRateLimit());
    const rule = { window: 600, max: 1 };
    const first = await limiter.reserve("password|user|room|me", rule);
    expect(first.allowed).toBe(true);
    expect((await limiter.reserve("password|user|room|me", rule)).allowed).toBe(false);
    first.release();
    expect((await limiter.reserve("password|user|room|me", rule)).allowed).toBe(true);
  });

  it("names a failure by a short code, never its message", () => {
    expect(limitErrorCode(new Error("timeout"))).toBe("timeout");
    expect(limitErrorCode(refused)).toBe("offline");
    expect(limitErrorCode(new Error("The client is closed"))).toBe("closed");
    expect(limitErrorCode(noPermission)).toBe("NOPERM");
    expect(limitErrorCode(new Error("READONLY You can't write against a read only replica."))).toBe(
      "READONLY",
    );
    expect(limitErrorCode(new Error("ERR unknown command 'evalsha'"))).toBe("ERR");
    expect(limitErrorCode(new Error("unexpected reply"))).toBe("unexpected_reply");
    // A socket's error by its code; a message that is no reply by the error's name.
    expect(
      limitErrorCode(Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" })),
    ).toBe("ECONNRESET");
    expect(limitErrorCode(new Error("redis://:secret@host"))).toBe("Error");
    expect(redisErrorCode(Object.assign(new Error("x"), { code: "ECONNREFUSED" }))).toBe(
      "ECONNREFUSED",
    );
    expect(redisErrorCode(new Error("redis://:secret@host"))).toBe("Error");
    expect(redisErrorCode({ code: "redis://x", name: "has spaces" })).toBe("unknown");
    expect(redisErrorCode(null)).toBe("unknown");
  });
});
