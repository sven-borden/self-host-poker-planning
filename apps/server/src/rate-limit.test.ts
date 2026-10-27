import { describe, expect, it } from "vitest";
import { memoryRateLimit } from "./rate-limit.ts";

describe("memoryRateLimit", () => {
  it("uses a store of its own per instance", async () => {
    const store = memoryRateLimit(() => 1000);
    const rule = { window: 10, max: 1 };
    expect(await store.consume("a", rule)).toEqual({ allowed: true, retryAfter: null });
    expect(await store.consume("a", rule)).toEqual({ allowed: false, retryAfter: 10 });
    expect(await memoryRateLimit().consume("a", rule)).toEqual({ allowed: true, retryAfter: null });
  });

  it("keeps at most maxKeys counters, dropping the oldest tenth when full", async () => {
    let now = 0;
    const store = memoryRateLimit(() => now, 10);
    const rule = { window: 60, max: 1 };
    for (let i = 0; i < 10; i++) await store.consume(`k${i}`, rule);
    expect((await store.consume("k0", rule)).allowed).toBe(false);
    // The 11th key evicts k0, the oldest; newer keys keep counting.
    await store.consume("k10", rule);
    expect((await store.consume("k0", rule)).allowed).toBe(true);
    expect((await store.consume("k2", rule)).allowed).toBe(false);
    // Expired counters go at the next sweep; a new window starts.
    now = 61_000;
    expect((await store.consume("k2", rule)).allowed).toBe(true);
  });
});
