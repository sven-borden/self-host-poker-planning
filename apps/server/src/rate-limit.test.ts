import { describe, expect, it } from "vitest";
import { memoryRateLimit } from "./rate-limit.ts";

describe("memoryRateLimit", () => {
  it("reserves a call and takes it back on release, once, in its own window (#31)", async () => {
    let now = 1000;
    const store = memoryRateLimit(() => now);
    const rule = { window: 10, max: 2 };
    // Released calls never close the window.
    for (let i = 0; i < 5; i++) {
      const held = await store.reserve("a", rule);
      expect(held.allowed).toBe(true);
      held.release();
    }
    const first = await store.reserve("a", rule);
    const second = await store.reserve("a", rule);
    expect([first.allowed, second.allowed]).toEqual([true, true]);
    const refused = await store.reserve("a", rule);
    expect(refused).toMatchObject({ allowed: false, retryAfter: 10 });
    // A refused call holds nothing; a second release changes nothing.
    refused.release();
    expect((await store.consume("a", rule)).allowed).toBe(false);
    second.release();
    second.release();
    expect((await store.consume("a", rule)).allowed).toBe(true);
    expect((await store.consume("a", rule)).allowed).toBe(false);
    // A release after its window ended leaves the new window alone.
    now = 11_000;
    expect((await store.consume("a", rule)).allowed).toBe(true);
    first.release();
    expect((await store.consume("a", rule)).allowed).toBe(true);
    expect((await store.consume("a", rule)).allowed).toBe(false);
  });

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
