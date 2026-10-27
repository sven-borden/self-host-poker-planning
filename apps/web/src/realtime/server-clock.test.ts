import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clockOffset,
  noteRoundTrip,
  onClockOffset,
  resetServerClock,
  SAMPLES,
  sampleServerClock,
  serverTime,
} from "./server-clock.ts";

afterEach(() => resetServerClock());

describe("the server clock (#27)", () => {
  it("is this page's clock until a snapshot arrives", () => {
    expect(clockOffset()).toBe(0);
    expect(serverTime(1_000)).toBe(1_000);
  });

  it("takes half the round trip off each sample's age", () => {
    // The server's clock runs 5 s ahead; a snapshot spends half of a 200 ms round trip.
    noteRoundTrip(200);
    sampleServerClock(105_000 - 100, 100_000);
    expect(clockOffset()).toBe(5_000);
    expect(serverTime(100_000)).toBe(105_000);
  });

  it("follows the median of recent samples, so one late packet does not move it", () => {
    for (const offset of [-5_000, -5_010, -4_990]) sampleServerClock(100_000 + offset, 100_000);
    sampleServerClock(100_000 - 9_000, 100_000); // a snapshot that sat 4 s in a busy tab
    expect(clockOffset()).toBe(-5_005);
    sampleServerClock(100_000 - 5_000, 100_000);
    expect(clockOffset()).toBe(-5_000);
  });

  it("keeps only the last samples, so a clock that jumped is followed", () => {
    for (let i = 0; i < SAMPLES; i += 1) sampleServerClock(100_000, 100_000);
    for (let i = 0; i < SAMPLES; i += 1) sampleServerClock(103_000, 100_000);
    expect(clockOffset()).toBe(3_000);
  });

  it("tells its listeners when the offset moves, not on every sample", () => {
    const heard = vi.fn();
    const stop = onClockOffset(heard);
    sampleServerClock(101_000, 100_000);
    sampleServerClock(101_000, 100_000);
    expect(heard).toHaveBeenCalledTimes(1);
    stop();
    sampleServerClock(109_000, 100_000);
    sampleServerClock(109_000, 100_000);
    expect(heard).toHaveBeenCalledTimes(1);
  });

  it("ignores a sample or a round trip that is not a number", () => {
    sampleServerClock(Number.NaN, 0);
    noteRoundTrip(-1);
    noteRoundTrip(Number.POSITIVE_INFINITY);
    expect(clockOffset()).toBe(0);
    sampleServerClock(1_000, 0);
    expect(clockOffset()).toBe(1_000);
  });
});
