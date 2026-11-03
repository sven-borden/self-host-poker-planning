/**
 * Limits shared through Redis (U4), against a real Redis and Postgres. The scripts give the
 * in-memory limiter's and buckets' answers for the same calls at the same times. Two instances
 * on one Redis hold one room-creation limit, one password guard and one handshake cap per
 * session between them. Two deployments with their own `REDIS_KEY_PREFIX` on one Redis hear
 * none of each other's signals and share no limit. With Redis gone mid-test, an instance still
 * creates rooms, takes handshakes and signs people in on its own counters, and its password
 * guard still refuses at its own limit, counting the tries it saw while Redis answered.
 * `STICKY_SESSIONS` serves long-polling to a real client and tells the page.
 *
 * Needs `TEST_REDIS_URL`, like `sync/scale-out.db.test.ts` (CI's `db-tests` job has one):
 * skipped locally without it, failing in CI. Every block takes a fresh prefix, so a run
 * within a window of the one before starts from empty counters, but one: the default prefix
 * (`pp`) keeps #39's channel and key names, which a rolling deploy needs.
 */
import { randomBytes } from "node:crypto";
import net from "node:net";
import { createRoom as newRoom } from "@pp/domain";
import { createClient } from "@redis/client";
import { io } from "socket.io-client";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Config } from "./config.ts";
import { createTestDatabase, type TestDatabase } from "./db/test-db.ts";
import { memoryRateLimit, type RateLimitRule } from "./rate-limit.ts";
import { createServer, type PokerServer } from "./server.ts";
import { type SetupTuning, setupServer } from "./setup.ts";
import { createSharedLimits, type LimitCommands } from "./shared-limits.ts";
import {
  type Guest,
  roomCode,
  signInGuest,
  type TestClient,
  testClient,
} from "./sync/test-support.ts";
import { createKeyedTokenBuckets, type TokenBucketOptions } from "./sync/token-bucket.ts";
import { collectLogs, testConfig, VALID_ENV } from "./test-support.ts";

const REDIS_URL = process.env.TEST_REDIS_URL;
if (!REDIS_URL && process.env.CI) throw new Error("TEST_REDIS_URL is not set in CI");

const ORIGIN = VALID_ENV.BASE_URL;
const PASSWORD = "correct horse";
const newRedis = () => createClient({ url: REDIS_URL ?? "", RESP: 2 });
type Redis = ReturnType<typeof newRedis>;
type Instance = Awaited<ReturnType<typeof setupServer>> & {
  server: PokerServer;
  base: string;
  logs: ReturnType<typeof collectLogs>;
};

const freshPrefix = () => `u4_${randomBytes(5).toString("hex")}`;
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Mulberry32: the same calls in the same order on every run. */
function seeded(seed: number) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pick = <T>(random: () => number, from: readonly T[]): T =>
  from[Math.floor(random() * from.length)] as T;

/**
 * A Redis in front of the test's Redis: `stop` drops every connection through it and refuses
 * new ones, which an instance sees as Redis gone, while the real one serves the other tests.
 */
async function redisProxy() {
  const target = new URL(REDIS_URL ?? "redis://localhost:6379");
  const sockets = new Set<net.Socket>();
  const server = net.createServer((inbound) => {
    const outbound = net.connect(Number(target.port || 6379), target.hostname);
    const close = () => {
      inbound.destroy();
      outbound.destroy();
    };
    for (const socket of [inbound, outbound]) {
      sockets.add(socket);
      socket.on("error", close);
      socket.on("close", () => {
        sockets.delete(socket);
        close();
      });
    }
    inbound.pipe(outbound);
    outbound.pipe(inbound);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as net.AddressInfo;
  return {
    url: `redis://127.0.0.1:${port}`,
    stop: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}

describe.skipIf(!REDIS_URL)("limits shared through Redis (U4)", () => {
  let t: TestDatabase;
  let redis: Redis;
  const instances: Instance[] = [];
  const clients: TestClient[] = [];
  const closers: (() => Promise<void> | void)[] = [];

  beforeAll(async () => {
    t = await createTestDatabase();
    redis = newRedis();
    redis.on("error", () => {});
    await redis.connect();
  });

  afterEach(() => {
    for (const client of clients.splice(0)) client.close();
  });

  afterAll(async () => {
    for (const close of closers.splice(0)) await close();
    for (const instance of instances.splice(0)) {
      await instance.server.close();
      await instance.dispose?.();
    }
    redis?.destroy();
    await t?.drop();
  });

  async function startInstance(
    env: Record<string, string>,
    {
      tuning = {},
      handshakeLimit,
      databaseUrl = t.url,
    }: { tuning?: SetupTuning; handshakeLimit?: TokenBucketOptions; databaseUrl?: string } = {},
  ): Promise<Instance> {
    const logs = collectLogs("debug");
    const config: Config = testConfig({ DATABASE_URL: databaseUrl, ...env });
    const setup = await setupServer(config, logs.logger, undefined, tuning);
    const server = createServer(config, {
      ...setup.deps,
      logger: logs.logger,
      ...(handshakeLimit && { realtimeLimits: { handshakeLimit } }),
    });
    const { port } = await server.listen();
    const instance = { ...setup, server, base: `http://localhost:${port}`, logs };
    instances.push(instance);
    return instance;
  }

  const post = (base: string, guest: Guest, path: string, body: unknown = {}, method = "POST") =>
    fetch(`${base}/api/rooms${path}`, {
      method,
      headers: { origin: ORIGIN, cookie: guest.cookie, "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  async function createRoom(base: string, guest: Guest): Promise<string> {
    const response = await post(base, guest, "");
    expect(response.status).toBe(201);
    return ((await response.json()) as { code: string }).code;
  }

  /**
   * A room with a password, owned by `owner`, written to the store directly: the room-creation
   * limit, which the same address spends, stays whole for its own test.
   */
  async function passwordRoom(instance: Instance, owner: Guest): Promise<string> {
    const code = await insertRoom(instance, owner);
    expect(
      (await post(instance.base, owner, `/${code}/password`, { password: PASSWORD }, "PUT")).status,
    ).toBe(204);
    return code;
  }

  /** A room owned by `owner`, written to the store directly; its code. */
  async function insertRoom(instance: Instance, owner: Guest): Promise<string> {
    const code = roomCode();
    const room = await instance.database.store.insertRoom({
      code,
      name: null,
      state: newRoom({ ownerId: owner.id }),
    });
    if (!room) throw new Error("code taken");
    return code;
  }

  /** How many clients listen on `channel`. */
  async function numsub(channel: string): Promise<unknown> {
    return ((await redis.sendCommand(["PUBSUB", "NUMSUB", channel])) as unknown[])[1];
  }

  /** A wrong password: its status and, when refused for the limit, the error code. */
  async function wrongTry(base: string, guest: Guest, code: string) {
    const response = await post(base, guest, `/${code}/access`, { password: "wrong password" });
    const body = (await response.json()) as { code?: string };
    return `${response.status} ${body.code}`;
  }

  /** The polling request that opens an Engine.IO connection: what the handshake cap counts. */
  async function pollHandshake(base: string, guest: Guest) {
    const response = await fetch(`${base}/socket.io/?EIO=4&transport=polling`, {
      headers: { origin: ORIGIN, cookie: guest.cookie },
    });
    const text = await response.text();
    return response.status === 200 ? "200" : `${response.status} ${text}`;
  }

  describe("the scripts against the in-memory limits", () => {
    const secret = VALID_ENV.BETTER_AUTH_SECRET;
    const logger = collectLogs().logger;

    it("answers every call of a fixed window as memoryRateLimit does, releases included", async () => {
      const random = seeded(16);
      let clock = 1_800_000_000_000;
      const memory = memoryRateLimit(() => clock);
      const shared = createSharedLimits({
        redis: redis as unknown as LimitCommands,
        prefix: freshPrefix(),
        secret,
        logger,
        scriptNow: () => clock,
      }).rateLimiter(memoryRateLimit());
      const rules: Record<string, RateLimitRule> = {
        a: { window: 1, max: 3 },
        b: { window: 10, max: 5 },
        c: { window: 60, max: 1 },
      };
      const held: { memory: () => void; shared: () => void }[] = [];
      const answers: string[] = [];
      for (let i = 0; i < 600; i++) {
        clock += pick(random, [0, 0, 0, 40, 300, 1_000, 4_000, 20_000]);
        const key = pick(random, ["a", "b", "c"]);
        const rule = rules[key] as RateLimitRule;
        const what = random();
        if (what < 0.5) {
          const [m, s] = [await memory.consume(key, rule), await shared.consume(key, rule)];
          expect(s, `step ${i}`).toEqual(m);
          answers.push(`${m.allowed}`);
        } else if (what < 0.85) {
          const m = await memory.reserve(key, rule);
          const s = await shared.reserve(key, rule);
          expect([s.allowed, s.retryAfter], `step ${i}`).toEqual([m.allowed, m.retryAfter]);
          held.push({ memory: m.release, shared: s.release });
          answers.push(`${m.allowed}`);
        } else if (held.length > 0) {
          const slot = held.splice(Math.floor(random() * held.length), 1)[0];
          slot?.memory();
          slot?.shared();
          // The release is not awaited: let it reach Redis before the next call.
          await sleep(0);
          await redis.ping();
        }
      }
      // Both answers came up, so the sequence did test something.
      expect(new Set(answers)).toEqual(new Set(["true", "false"]));
    });

    it("answers every take of a token bucket as createKeyedTokenBuckets does", async () => {
      for (const [seed, limit] of [
        [1, { perSecond: 1, burst: 4 }],
        [2, { perSecond: 10 / 60, burst: 10 }],
        [3, { perSecond: 10, burst: 3 }],
      ] as const) {
        const random = seeded(seed);
        let clock = 1_800_000_000_000;
        const memory = createKeyedTokenBuckets({ ...limit, now: () => clock });
        const shared = createSharedLimits({
          redis: redis as unknown as LimitCommands,
          prefix: freshPrefix(),
          secret,
          logger,
          scriptNow: () => clock,
        }).tokenBuckets("test", limit, createKeyedTokenBuckets(limit));
        const answers = new Set<boolean>();
        for (let i = 0; i < 400; i++) {
          clock += pick(random, [0, 0, 0, 0, 0, 10, 100, 700, 3_000, 60_000]);
          const key = pick(random, ["x", "y", "z"]);
          const m = memory.take(key);
          expect(await shared.take(key), `limit ${seed}, step ${i}`).toBe(m);
          answers.add(m);
        }
        expect(answers).toEqual(new Set([true, false]));
      }
    });

    it("gives every key a TTL, so nothing it writes stays", async () => {
      const prefix = freshPrefix();
      const limits = createSharedLimits({
        redis: redis as unknown as LimitCommands,
        prefix,
        secret,
        logger,
      });
      await limits.rateLimiter(memoryRateLimit()).consume("rooms|create|192.0.2.1", {
        window: 600,
        max: 20,
      });
      await limits
        .tokenBuckets(
          "handshake",
          { perSecond: 1, burst: 30 },
          createKeyedTokenBuckets({ perSecond: 1, burst: 30 }),
        )
        .take("session");
      const keys: string[] = [];
      for await (const batch of redis.scanIterator({ MATCH: `${prefix}:*`, COUNT: 100 })) {
        keys.push(...batch);
      }
      expect(keys).toHaveLength(2);
      for (const key of keys) {
        const ttl = await redis.pTTL(key);
        expect(ttl, key).toBeGreaterThan(0);
        expect(ttl, key).toBeLessThanOrEqual(600_000);
        expect(key).not.toContain("192.0.2.1");
      }
    });
  });

  describe("two instances on one Redis", () => {
    let one: Instance;
    let two: Instance;
    beforeAll(async () => {
      const env = {
        REDIS_URL: REDIS_URL ?? "",
        REDIS_KEY_PREFIX: freshPrefix(),
        STICKY_SESSIONS: "true",
      };
      const handshakeLimit = { perSecond: 0.001, burst: 4 };
      one = await startInstance(env, { handshakeLimit });
      two = await startInstance(env, { handshakeLimit });
    });

    it("holds one room-creation limit between them: 20 in 10 minutes, wherever they go", async () => {
      const ada = await signInGuest(one.base, ORIGIN);
      for (let i = 0; i < 20; i++) await createRoom(i % 2 === 0 ? one.base : two.base, ada);
      for (const instance of [one, two]) {
        const refused = await post(instance.base, ada, "");
        expect(refused.status).toBe(429);
        expect(await refused.json()).toEqual({ code: "rate_limited" });
        expect(Number(refused.headers.get("retry-after"))).toBeGreaterThan(500);
      }
    });

    it("holds one password guard between them: 10 wrong tries per person and room", async () => {
      const [owner, guesser] = await Promise.all([
        signInGuest(two.base, ORIGIN),
        signInGuest(one.base, ORIGIN),
      ]);
      const code = await passwordRoom(two, owner);
      for (let i = 0; i < 10; i++) {
        expect(await wrongTry(i % 2 === 0 ? one.base : two.base, guesser, code)).toBe(
          "403 wrong_password",
        );
      }
      for (const instance of [one, two]) {
        expect(await wrongTry(instance.base, guesser, code)).toBe("429 rate_limited");
      }
      // The right password is refused too while the limit holds, on either instance.
      const right = await post(one.base, guesser, `/${code}/access`, { password: PASSWORD });
      expect(right.status).toBe(429);
    });

    it("holds one handshake cap per session between them, each session its own", async () => {
      const [ada, bob] = await Promise.all([
        signInGuest(one.base, ORIGIN),
        signInGuest(two.base, ORIGIN),
      ]);
      const answers: string[] = [];
      for (let i = 0; i < 4; i++)
        answers.push(await pollHandshake(i % 2 ? two.base : one.base, ada));
      expect(answers).toEqual(["200", "200", "200", "200"]);
      for (const instance of [one, two]) {
        expect(await pollHandshake(instance.base, ada)).toBe(
          '403 {"code":4,"message":"rate_limited"}',
        );
      }
      expect(await pollHandshake(two.base, bob)).toBe("200");
    });

    it("serves long-polling to a real client with sticky sessions on, and tells the page", async () => {
      expect(one.deps?.socketTransports).toBe("polling websocket");
      const guest = await signInGuest(two.base, ORIGIN);
      const socket = io(two.base, {
        transports: ["polling"],
        forceNew: true,
        reconnection: false,
        extraHeaders: { cookie: guest.cookie },
      });
      closers.push(() => {
        socket.close();
      });
      await new Promise<void>((resolve, reject) => {
        socket.once("connect", resolve);
        socket.once("connect_error", reject);
      });
      expect(socket.io.engine.transport.name).toBe("polling");
      socket.close();
    });
  });

  describe("WebSocket only without sticky sessions", () => {
    it("refuses long-polling and tells the page WebSocket only", async () => {
      const instance = await startInstance({
        REDIS_URL: REDIS_URL ?? "",
        REDIS_KEY_PREFIX: freshPrefix(),
      });
      expect(instance.deps?.socketTransports).toBe("websocket");
      const guest = await signInGuest(instance.base, ORIGIN);
      expect(await pollHandshake(instance.base, guest)).toBe(
        '400 {"code":0,"message":"Transport unknown"}',
      );
    });
  });

  describe("two deployments on one Redis, each with its own prefix", () => {
    it("hear none of each other's signals and share no limit", async () => {
      const other = await createTestDatabase();
      closers.push(() => other.drop());
      const [px, py] = [freshPrefix(), freshPrefix()];
      const spy = newRedis();
      spy.on("error", () => {});
      await spy.connect();
      closers.push(() => spy.destroy());
      const heard: Record<string, string[]> = { [px]: [], [py]: [] };
      for (const prefix of [px, py]) {
        await spy.pSubscribe(`${prefix}*`, (_message, channel) => heard[prefix]?.push(channel));
      }
      const x1 = await startInstance({ REDIS_URL: REDIS_URL ?? "", REDIS_KEY_PREFIX: px });
      const x2 = await startInstance({ REDIS_URL: REDIS_URL ?? "", REDIS_KEY_PREFIX: px });
      const y = await startInstance(
        { REDIS_URL: REDIS_URL ?? "", REDIS_KEY_PREFIX: py },
        { databaseUrl: other.url },
      );

      // Each deployment's instances listen on its own channels only (the adapter subscribes
      // once its connection is ready, a moment after the instance listens).
      await vi.waitFor(
        async () => {
          const numsub = (await redis.sendCommand([
            "PUBSUB",
            "NUMSUB",
            `${px}-request#/#`,
            `${py}-request#/#`,
          ])) as unknown[];
          expect(numsub).toEqual([`${px}-request#/#`, 2, `${py}-request#/#`, 1]);
        },
        { timeout: 3_000, interval: 50 },
      );

      // A round on X reaches X's other instance, and nothing reaches Y's channels.
      const [ada, bob] = await Promise.all([
        signInGuest(x1.base, ORIGIN),
        signInGuest(x2.base, ORIGIN),
      ]);
      const code = await createRoom(x1.base, ada);
      const a = testClient(x1.base, { cookie: ada.cookie });
      const b = testClient(x2.base, { cookie: bob.cookie });
      clients.push(a, b);
      await Promise.all([a.enter(code), b.enter(code)]);
      const joined = await b.cmd("join", { name: "Bob", role: "voter" });
      if (!joined.ok) throw new Error(`join refused: ${joined.code}`);
      await a.waitFor((s) => s.version === joined.version);
      await sleep(100);
      expect(heard[px]?.length).toBeGreaterThan(0);
      expect(heard[py]).toEqual([]);
      for (const channel of heard[px] ?? []) expect(channel.startsWith(`${px}`)).toBe(true);
      const acks = async (prefix: string) => {
        const keys: string[] = [];
        for await (const batch of redis.scanIterator({ MATCH: `${prefix}:ack:*`, COUNT: 100 })) {
          keys.push(...batch);
        }
        return keys;
      };
      expect((await acks(px)).length).toBeGreaterThan(0);
      expect(await acks(py)).toEqual([]);

      // X's room-creation limit, spent from this address, leaves Y's whole: same address,
      // same secret, so the same key but for the prefix.
      for (let i = 1; i < 20; i++) await createRoom(i % 2 ? x2.base : x1.base, ada);
      expect((await post(x1.base, ada, "")).status).toBe(429);
      const cy = await signInGuest(y.base, ORIGIN);
      await createRoom(y.base, cy);
      // And Y does not know X's room.
      expect((await fetch(`${y.base}/api/rooms/${code}`)).status).toBe(404);
    });
  });

  describe("the default prefix", () => {
    it("keeps #39's channel and key names, so a rolling deploy keeps one cluster", async () => {
      const before = Number(await numsub("pp-request#/#"));
      const instance = await startInstance({ REDIS_URL: REDIS_URL ?? "" });
      await vi.waitFor(async () => expect(await numsub("pp-request#/#")).toBe(before + 1), {
        timeout: 3_000,
        interval: 50,
      });
      // A room written to the store: no room-creation try spent on the default prefix.
      const guest = await signInGuest(instance.base, ORIGIN);
      const code = await insertRoom(instance, guest);
      const c = testClient(instance.base, { cookie: guest.cookie });
      clients.push(c);
      await c.enter(code);
      const id = `u4-${randomBytes(4).toString("hex")}`;
      const joined = await c.cmd("join", { name: "Ada", role: "voter" }, id);
      expect(joined.ok).toBe(true);
      const roomId = (await instance.database.store.loadRoom(code))?.id;
      const key = `pp:ack:${guest.id} ${roomId} ${id}`;
      expect(JSON.parse(String(await redis.get(key)))).toEqual(joined);
      await redis.del(key);
    });
  });

  describe("Redis gone mid-test", () => {
    it("still creates rooms and takes handshakes, and the password guard refuses at its own limit", async () => {
      const proxy = await redisProxy();
      closers.push(() => proxy.stop());
      const z = await startInstance(
        { REDIS_URL: proxy.url, REDIS_KEY_PREFIX: freshPrefix(), STICKY_SESSIONS: "true" },
        { handshakeLimit: { perSecond: 0.001, burst: 3 } },
      );
      const [owner, guesser] = await Promise.all([
        signInGuest(z.base, ORIGIN),
        signInGuest(z.base, ORIGIN),
      ]);
      const code = await passwordRoom(z, owner);
      // Six wrong tries while Redis answers: counted there and on the instance.
      for (let i = 0; i < 6; i++)
        expect(await wrongTry(z.base, guesser, code)).toBe("403 wrong_password");
      expect(await pollHandshake(z.base, guesser)).toBe("200");

      await proxy.stop();
      const health = async () =>
        ((await (await fetch(`${z.base}/api/health`)).json()) as { redis?: string }).redis;
      const until = Date.now() + 5_000;
      while ((await health()) !== "down" && Date.now() < until) await sleep(50);
      expect(await health()).toBe("down");

      // Never shut: a room, a sign-in and handshakes still pass, on the instance's own counters.
      const started = performance.now();
      await createRoom(z.base, owner);
      const newcomer = await signInGuest(z.base, ORIGIN);
      expect(await pollHandshake(z.base, newcomer)).toBe("200");
      expect(performance.now() - started).toBeLessThan(2_000);
      // The guesser's bucket of 3 had one spent while Redis answered: two more, then refused.
      expect(await pollHandshake(z.base, guesser)).toBe("200");
      expect(await pollHandshake(z.base, guesser)).toBe("200");
      expect(await pollHandshake(z.base, guesser)).toBe('403 {"code":4,"message":"rate_limited"}');

      // Never open: the six tries counted before, four more, then refused.
      for (let i = 0; i < 4; i++)
        expect(await wrongTry(z.base, guesser, code)).toBe("403 wrong_password");
      expect(await wrongTry(z.base, guesser, code)).toBe("429 rate_limited");

      const lines = z.logs.lines.filter((line) => String(line.msg).startsWith("rate limits"));
      expect(lines.map((line) => line.msg)).toEqual([
        "rate limits: redis unavailable, counting on this instance",
      ]);
      for (const raw of z.logs.raw) expect(raw).not.toContain(code);
    });
  });
});
