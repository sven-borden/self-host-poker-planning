import { useSyncExternalStore } from "react";

// The server's clock, as this page estimates it (#27, architecture section 9). A timer is
// a deadline in the server's epoch milliseconds (`round.deadlineAt`); this page's own clock
// may be off by seconds, so the countdown reads the server's time instead:
//
//   server now ≈ localNow() + offset
//
// `localNow()` is this page's monotonic clock in epoch milliseconds
// (`performance.timeOrigin + performance.now()`), the clock the ring's animation runs on,
// not `Date.now()`: a wall-clock step (an NTP correction, a person setting the time) moves
// nothing here. Some browsers pause the monotonic clock while the computer sleeps; it then
// lags the server by the time asleep, and every sample after it is that much higher. A
// sample more than `JUMP_MS` above the median starts the window over from that sample
// instead of waiting for it to become the median. A sample far below it is a snapshot
// that arrived late (a busy or frozen tab, a slow hop): it only ever lowers a sample, and
// the median outvotes it, which is what the window is for.
//
// Every snapshot carries `serverNow`, the server's clock when it built it. It left the
// server about half a round trip before it arrived, so each snapshot gives one sample:
//
//   offset ≈ serverNow + roundTrip / 2 − (local time of arrival)
//
// The round trip is measured on `enter`, the one message this page answers itself: sent
// at t0, its snapshot back at t1, round trip t1 − t0. The offset is the median of the last
// `SAMPLES` samples, so one late packet (a busy tab, a slow hop) does not move the ring.
// A page never decides anything with it: at 0:00 it waits for the server's reveal.

/** How many recent samples the median is taken over. */
export const SAMPLES = 9;
/** A sample this far above the median means this page's clock paused: start over from it. */
export const JUMP_MS = 1_000;

/** This page's clock in epoch milliseconds: monotonic, so a wall-clock step moves nothing. */
export function localNow(): number {
  return performance.timeOrigin + performance.now();
}

let samples: number[] = [];
let roundTrip = 0;
const listeners = new Set<() => void>();

/** Notes the round trip of an `enter` (milliseconds), for the samples that follow. */
export function noteRoundTrip(ms: number) {
  if (Number.isFinite(ms) && ms >= 0) roundTrip = ms;
}

/** One sample: a snapshot built at `serverNow` (server clock) arrived at `arrivedAt` (local). */
export function sampleServerClock(serverNow: number, arrivedAt: number = localNow()) {
  if (!Number.isFinite(serverNow)) return;
  const before = clockOffset();
  const sample = serverNow + roundTrip / 2 - arrivedAt;
  samples =
    samples.length > 0 && sample - median(samples) > JUMP_MS
      ? [sample]
      : [...samples, sample].slice(-SAMPLES);
  if (clockOffset() !== before) for (const listener of listeners) listener();
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  return sorted.length % 2 === 1
    ? (sorted[middle] as number)
    : ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2;
}

/** The median of the recent samples, in milliseconds; 0 before the first one. */
export function clockOffset(): number {
  return samples.length === 0 ? 0 : Math.round(median(samples));
}

/**
 * The server's time now (epoch milliseconds), as this page estimates it; or the server's
 * time at `local`, a reading of `localNow()`. Anything that compares a server timestamp
 * (a deadline, a claim's opening) with now reads this, never `Date.now()`, and re-reads
 * it when `onClockOffset` (or `useClockOffset`) says the estimate moved.
 */
export function serverTime(local: number = localNow()): number {
  return local + clockOffset();
}

/** The last `enter`'s round trip in milliseconds (0 before the first). */
export function roundTripMs(): number {
  return roundTrip;
}

/** Calls `listener` whenever the offset changes; returns the unsubscribe. */
export function onClockOffset(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The clock offset, in a component that draws again whenever the estimate moves. */
export function useClockOffset(): number {
  return useSyncExternalStore(onClockOffset, clockOffset, () => 0);
}

/** Forgets every sample (tests). */
export function resetServerClock() {
  samples = [];
  roundTrip = 0;
}
