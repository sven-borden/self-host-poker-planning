import { describe, expect, it } from "vitest";
import { createKeyedTokenBuckets } from "./token-bucket.ts";

describe("createKeyedTokenBuckets", () => {
  it("gives each key its own bucket, refilled at the rate", () => {
    let clock = 0;
    const buckets = createKeyedTokenBuckets({ perSecond: 2, burst: 3, now: () => clock });
    expect([1, 2, 3, 4].map(() => buckets.take("a"))).toEqual([true, true, true, false]);
    expect(buckets.take("b")).toBe(true);
    clock += 499;
    expect(buckets.take("a")).toBe(false);
    clock += 1;
    expect(buckets.take("a")).toBe(true);
    expect(buckets.take("a")).toBe(false);
  });

  it("forgets the buckets that refilled, every 30 s", () => {
    let clock = 0;
    const buckets = createKeyedTokenBuckets({ perSecond: 1, burst: 10, now: () => clock });
    buckets.take("idle");
    for (let i = 0; i < 10; i++) buckets.take("busy");
    clock += 30_000;
    // "busy" has had 30 tokens' time and is full too; "fresh" is new.
    buckets.take("fresh");
    expect(buckets.size).toBe(1);
  });

  it("holds at most maxKeys, dropping the tenth whose last take is oldest", () => {
    let clock = 0;
    const buckets = createKeyedTokenBuckets({ perSecond: 0.001, burst: 1, now: () => clock }, 20);
    for (let i = 0; i < 20; i++) {
      buckets.take(`k${i}`);
      clock += 1;
    }
    // Every bucket is empty, none can be swept: the two oldest go to make room.
    expect(buckets.take("new")).toBe(true);
    expect(buckets.size).toBe(19);
    expect(buckets.take("k2")).toBe(false);
    expect(buckets.take("k0")).toBe(true);
  });
});
