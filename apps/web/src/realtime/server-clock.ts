// The server's clock, as this page estimates it (#27, architecture section 9). A timer is
// a deadline in the server's epoch milliseconds (`round.deadlineAt`); this page's own clock
// may be off by seconds, so the countdown reads the server's time instead:
//
//   server now ≈ Date.now() + offset
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

let samples: number[] = [];
let roundTrip = 0;
const listeners = new Set<() => void>();

/** Notes the round trip of an `enter` (milliseconds), for the samples that follow. */
export function noteRoundTrip(ms: number) {
  if (Number.isFinite(ms) && ms >= 0) roundTrip = ms;
}

/** One sample: a snapshot built at `serverNow` (server clock) arrived at `arrivedAt` (local). */
export function sampleServerClock(serverNow: number, arrivedAt: number = Date.now()) {
  if (!Number.isFinite(serverNow)) return;
  const before = clockOffset();
  samples = [...samples, serverNow + roundTrip / 2 - arrivedAt].slice(-SAMPLES);
  if (clockOffset() !== before) for (const listener of listeners) listener();
}

/** The median of the recent samples, in milliseconds; 0 before the first one. */
export function clockOffset(): number {
  if (samples.length === 0) return 0;
  const sorted = [...samples].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  const value =
    sorted.length % 2 === 1
      ? (sorted[middle] as number)
      : ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2;
  return Math.round(value);
}

/** The server's time now, as this page estimates it. */
export function serverTime(local: number = Date.now()): number {
  return local + clockOffset();
}

/** Calls `listener` whenever the offset changes; returns the unsubscribe. */
export function onClockOffset(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Forgets every sample (tests). */
export function resetServerClock() {
  samples = [];
  roundTrip = 0;
}
