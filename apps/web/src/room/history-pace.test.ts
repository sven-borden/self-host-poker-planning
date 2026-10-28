import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPacer, SUMMARY_PACE } from "./history-pace.ts";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

/** When each of `count` requests got its turn, in ms since the start. */
async function turns(pacer: ReturnType<typeof createPacer>, count: number): Promise<number[]> {
  const start = Date.now();
  const at: number[] = [];
  const done = (async () => {
    for (let i = 0; i < count; i++) {
      await pacer.wait(() => false);
      at.push(Date.now() - start);
    }
  })();
  await vi.advanceTimersByTimeAsync(60_000);
  await done;
  return at;
}

describe("the summary's pace", () => {
  it("lets 8 requests go at once, then 2 a second", async () => {
    expect(SUMMARY_PACE).toEqual({ burst: 8, perSecond: 2 });
    const at = await turns(createPacer(SUMMARY_PACE), 12);
    expect(at.slice(0, 8)).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
    expect(at.slice(8)).toEqual([500, 1000, 1500, 2000]);
  });

  it("never lets more go in a window than #36's history bucket holds (10, then 2 a second)", async () => {
    const at = await turns(createPacer(SUMMARY_PACE), 40);
    for (const start of at) {
      for (const seconds of [1, 5, 10]) {
        const inWindow = at.filter((t) => t >= start && t < start + seconds * 1000).length;
        // Two to spare: the list's own requests take from the same bucket.
        expect(inWindow).toBeLessThanOrEqual(8 + 2 * seconds);
      }
    }
  });

  it("refills while nobody asks, never past the burst", async () => {
    const pacer = createPacer(SUMMARY_PACE);
    await turns(pacer, 8);
    await vi.advanceTimersByTimeAsync(60_000);
    const at = await turns(pacer, 9);
    expect(at.filter((t) => t === 0)).toHaveLength(8);
    expect(at[8]).toBe(500);
  });

  it("lets the list spend without waiting, and the summary waits for it", async () => {
    const pacer = createPacer(SUMMARY_PACE);
    for (let i = 0; i < 3; i++) pacer.spend();
    const at = await turns(pacer, 6);
    expect(at).toEqual([0, 0, 0, 0, 0, 500]);
    // The debt stops at one burst.
    for (let i = 0; i < 100; i++) pacer.spend();
    const later = await turns(pacer, 1);
    expect(later).toEqual([4500]);
  });

  it("gives up waiting once the caller stopped", async () => {
    const pacer = createPacer({ burst: 1, perSecond: 1 });
    expect(await pacer.wait(() => false)).toBe(true);
    let stopped = false;
    const waiting = pacer.wait(() => stopped);
    stopped = true;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await waiting).toBe(false);
    // The token it did not take is still there.
    expect(await pacer.wait(() => false)).toBe(true);
    pacer.reset();
    expect(await pacer.wait(() => false)).toBe(true);
  });
});
