import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeadlineTimers, DEADLINE_SLACK_MS } from "./deadlines.ts";
import { ackKey, createRecentAcks } from "./recent-acks.ts";
import { createTokenBucket, SOCKET_MESSAGE_LIMIT } from "./token-bucket.ts";

describe("createTokenBucket", () => {
  it("allows a burst of 20, then 10 a second", () => {
    let now = 0;
    const bucket = createTokenBucket({ ...SOCKET_MESSAGE_LIMIT, now: () => now });
    const first = Array.from({ length: 25 }, () => bucket.take());
    expect(first.filter(Boolean)).toHaveLength(20);
    now += 100;
    expect(bucket.take()).toBe(true);
    expect(bucket.take()).toBe(false);
    now += 10_000;
    expect(Array.from({ length: 25 }, () => bucket.take()).filter(Boolean)).toHaveLength(20);
  });
});

describe("createRecentAcks", () => {
  it("runs a key once and hands out the same answer, also while it runs", async () => {
    const acks = createRecentAcks(10);
    let runs = 0;
    const run = async () => ({ ok: true as const, version: ++runs });
    const [a, b] = await Promise.all([acks.remember("k", run), acks.remember("k", run)]);
    expect(a).toEqual({ ok: true, version: 1 });
    expect(b).toBe(a);
    expect(await acks.remember("k", run)).toBe(a);
    expect(runs).toBe(1);
  });

  it("forgets the least recently used key past its size", async () => {
    const acks = createRecentAcks(2);
    let runs = 0;
    const run = async () => ({ ok: true as const, version: ++runs });
    await acks.remember("a", run);
    await acks.remember("b", run);
    await acks.remember("a", run);
    await acks.remember("c", run);
    expect(acks.size).toBe(2);
    expect(await acks.remember("a", run)).toEqual({ ok: true, version: 1 });
    expect(await acks.remember("b", run)).toEqual({ ok: true, version: 4 });
  });

  it("drops an answer `forget` accepts, and a rejection, once known", async () => {
    const acks = createRecentAcks(10, (ack) => !ack.ok && ack.code === "busy");
    expect(await acks.remember("k", async () => ({ ok: false, code: "busy" }))).toEqual({
      ok: false,
      code: "busy",
    });
    expect(acks.size).toBe(0);
    await expect(acks.remember("j", () => Promise.reject(new Error("bug")))).rejects.toThrow("bug");
    await Promise.resolve();
    expect(acks.size).toBe(0);
  });

  it("keys by user, room and command id", () => {
    expect(ackKey("u1", "Room1", "c1")).not.toBe(ackKey("u1", "Room2", "c1"));
  });
});

describe("createDeadlineTimers", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("fires once just after the deadline, keeps the same deadline and replaces another", () => {
    vi.useFakeTimers({ now: 1000 });
    const fired: string[] = [];
    const timers = createDeadlineTimers((code) => fired.push(code));
    timers.set("r", 2000);
    timers.set("r", 2000);
    vi.advanceTimersByTime(1000 + DEADLINE_SLACK_MS - 1);
    expect(fired).toEqual([]);
    timers.set("r", 3000);
    vi.advanceTimersByTime(1000);
    expect(fired).toEqual([]);
    vi.advanceTimersByTime(DEADLINE_SLACK_MS);
    expect(fired).toEqual(["r"]);
    expect(timers.armed("r")).toBeUndefined();
  });

  it("fires at once for a past deadline, and clears one or all", () => {
    vi.useFakeTimers({ now: 5000 });
    const fired: string[] = [];
    const timers = createDeadlineTimers((code) => fired.push(code));
    timers.set("past", 1000);
    vi.advanceTimersByTime(DEADLINE_SLACK_MS);
    timers.set("a", 9000);
    timers.set("b", 9000);
    timers.set("a", undefined);
    expect(timers.armed("a")).toBeUndefined();
    timers.clear("b");
    timers.set("c", 9000);
    timers.clearAll();
    vi.advanceTimersByTime(10_000);
    expect(fired).toEqual(["past"]);
  });
});
