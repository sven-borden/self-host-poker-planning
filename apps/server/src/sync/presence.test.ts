import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createGraceTimers, PRESENCE_GRACE_MS } from "./presence.ts";

describe("presence grace timers", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("waits 15 s by default, then fires once for that person and room", () => {
    const fired: string[] = [];
    const graces = createGraceTimers((room, who) => fired.push(`${room}/${who}`));
    graces.start("r1", "ana");
    expect(graces.pending("r1", "ana")).toBe(true);
    vi.advanceTimersByTime(PRESENCE_GRACE_MS - 1);
    expect(fired).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(fired).toEqual(["r1/ana"]);
    expect(graces.pending("r1", "ana")).toBe(false);
    vi.advanceTimersByTime(PRESENCE_GRACE_MS);
    expect(fired).toEqual(["r1/ana"]);
  });

  it("keeps a running grace's deadline when started again, and cancels it on return", () => {
    const fired: string[] = [];
    const graces = createGraceTimers((room, who) => fired.push(`${room}/${who}`), 100);
    graces.start("r1", "ana");
    vi.advanceTimersByTime(60);
    graces.start("r1", "ana");
    vi.advanceTimersByTime(40);
    expect(fired).toEqual(["r1/ana"]);
    graces.start("r1", "ben");
    expect(graces.cancel("r1", "ben")).toBe(true);
    expect(graces.cancel("r1", "ben")).toBe(false);
    expect(graces.cancel("r9", "ben")).toBe(false);
    vi.advanceTimersByTime(200);
    expect(fired).toEqual(["r1/ana"]);
  });

  it("drops a room's timers, or all of them, without firing", () => {
    const fire = vi.fn();
    const graces = createGraceTimers(fire, 100);
    graces.start("r1", "ana");
    graces.start("r1", "ben");
    graces.start("r2", "ana");
    graces.clearRoom("r1");
    graces.clearRoom("r3");
    expect(graces.pending("r1", "ana")).toBe(false);
    expect(graces.pending("r2", "ana")).toBe(true);
    graces.clearAll();
    vi.advanceTimersByTime(500);
    expect(fire).not.toHaveBeenCalled();
  });
});
