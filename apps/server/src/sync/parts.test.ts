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
  const counter = () => {
    let runs = 0;
    return async () => ({ ok: true as const, version: ++runs });
  };

  it("runs a key once and hands out the same answer, also while it runs", async () => {
    const acks = createRecentAcks();
    const run = counter();
    const [a, b] = await Promise.all([
      acks.remember("u1", "k", run),
      acks.remember("u1", "k", run),
    ]);
    expect(a).toEqual({ ok: true, version: 1 });
    expect(b).toBe(a);
    expect(await acks.remember("u1", "k", run)).toBe(a);
    // The same key of another person is another command.
    expect(await acks.remember("u2", "k", run)).toEqual({ ok: true, version: 2 });
  });

  it("forgets a person's least recently used key past their own bound", async () => {
    const acks = createRecentAcks({ perUser: 2 });
    const run = counter();
    await acks.remember("u1", "a", run);
    await acks.remember("u1", "b", run);
    await acks.remember("u1", "a", run);
    await acks.remember("u1", "c", run);
    expect(acks.size).toBe(2);
    expect(await acks.remember("u1", "a", run)).toEqual({ ok: true, version: 1 });
    expect(await acks.remember("u1", "b", run)).toEqual({ ok: true, version: 4 });
  });

  it("keeps everyone else's results while one person floods", async () => {
    const acks = createRecentAcks({ perUser: 5 });
    const run = counter();
    const honest = await acks.remember("ada", "vote", run);
    for (let i = 0; i < 1000; i++) await acks.remember("mallory", `m${i}`, run);
    expect(acks.size).toBe(6);
    expect(await acks.remember("ada", "vote", run)).toBe(honest);
  });

  it("forgets the person who has not sent a command for longest past the people bound", async () => {
    const acks = createRecentAcks({ users: 2 });
    const run = counter();
    await acks.remember("u1", "k", run);
    await acks.remember("u2", "k", run);
    await acks.remember("u1", "j", run);
    await acks.remember("u3", "k", run);
    expect(acks.size).toBe(3);
    expect(await acks.remember("u1", "k", run)).toEqual({ ok: true, version: 1 });
    expect(await acks.remember("u2", "k", run)).toEqual({ ok: true, version: 5 });
  });

  it("drops an answer `forget` accepts, and a rejection, once known", async () => {
    const acks = createRecentAcks({ forget: (ack) => !ack.ok && ack.code === "busy" });
    expect(await acks.remember("u1", "k", async () => ({ ok: false, code: "busy" }))).toEqual({
      ok: false,
      code: "busy",
    });
    expect(acks.size).toBe(0);
    await expect(acks.remember("u1", "j", () => Promise.reject(new Error("bug")))).rejects.toThrow(
      "bug",
    );
    await Promise.resolve();
    expect(acks.size).toBe(0);
  });

  it("counts right when a forgotten person's command settles later", async () => {
    const acks = createRecentAcks({ users: 1, forget: (ack) => !ack.ok });
    let settle: (ack: { ok: false; code: "busy" }) => void = () => {};
    const slow = acks.remember("u1", "k", () => new Promise((resolve) => (settle = resolve)));
    await acks.remember("u2", "k", counter());
    settle({ ok: false, code: "busy" });
    await slow;
    expect(acks.size).toBe(1);
  });

  it("keys by room and command id", () => {
    expect(ackKey("room-1", "c1")).not.toBe(ackKey("room-2", "c1"));
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
