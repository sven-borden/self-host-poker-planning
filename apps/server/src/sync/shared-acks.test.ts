import { describe, expect, it } from "vitest";
import {
  ACK_CLAIM_MS,
  ACK_KEEP_MS,
  type AckCommands,
  redisAcks,
  sharedAckKey,
  within,
} from "./shared-acks.ts";

/** A Redis stand-in for SET (NX, PX), GET and DEL, recording each call's options. */
function fakeRedis() {
  const values = new Map<string, string>();
  const ttls: number[] = [];
  const redis: AckCommands & { values: typeof values; ttls: number[] } = {
    values,
    ttls,
    set: async (key, value, options) => {
      if (options.condition === "NX" && values.has(key)) return null;
      values.set(key, value);
      ttls.push(options.expiration.value);
      return "OK";
    },
    get: async (key) => values.get(key) ?? null,
    del: async (key) => (values.delete(key) ? 1 : 0),
  };
  return redis;
}

describe("redisAcks (#39)", () => {
  it("lets the first claim run, answers running meanwhile, then the stored answer", async () => {
    const redis = fakeRedis();
    const acks = redisAcks(redis);
    const key = sharedAckKey("user-1", "room-1", "c1");
    expect(key).toBe("pp:ack:user-1 room-1 c1");
    expect(await acks.claim(key)).toEqual({ state: "mine" });
    expect(await acks.claim(key)).toEqual({ state: "running" });
    await acks.settle(key, { ok: true, version: 7 });
    expect(await acks.claim(key)).toEqual({ state: "done", ack: { ok: true, version: 7 } });
    expect(redis.ttls).toEqual([ACK_CLAIM_MS, ACK_KEEP_MS]);
  });

  it("lets a released claim run again", async () => {
    const acks = redisAcks(fakeRedis());
    expect(await acks.claim("k")).toEqual({ state: "mine" });
    await acks.settle("k", null);
    expect(await acks.claim("k")).toEqual({ state: "mine" });
  });

  it("takes an unreadable value for a command still running, never for an answer", async () => {
    const redis = fakeRedis();
    redis.values.set("k", "{not json");
    redis.values.set("j", JSON.stringify({ ok: "yes" }));
    const acks = redisAcks(redis);
    expect(await acks.claim("k")).toEqual({ state: "running" });
    expect(await acks.claim("j")).toEqual({ state: "running" });
  });

  it("claims again when the key expired between its SET and its GET", async () => {
    const redis = fakeRedis();
    let first = true;
    const racing: AckCommands = {
      ...redis,
      set: async (key, value, options) => {
        if (first) {
          first = false;
          return null;
        }
        return redis.set(key, value, options);
      },
    };
    expect(await redisAcks(racing).claim("k")).toEqual({ state: "mine" });
  });

  it("rejects when Redis does not answer in time, so the caller falls back", async () => {
    const hung: AckCommands = {
      set: () => new Promise(() => {}),
      get: () => new Promise(() => {}),
      del: () => new Promise(() => {}),
    };
    await expect(redisAcks(hung, 20).claim("k")).rejects.toThrow("timeout");
    await expect(within(Promise.resolve(3), 20)).resolves.toBe(3);
  });
});
