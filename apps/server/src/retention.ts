/**
 * The retention job (#35, ADR-014): in the server process, a few minutes after the start
 * and then every 24 hours, one purge of what stayed idle longer than `ROOM_TTL_DAYS`
 * (`db/retention.ts`). With several instances the advisory lock lets one run at a time;
 * the others skip that run. Nothing opens or runs at import time: `startRetention` is
 * called by `setupServer`, and `stop` by its `dispose`.
 */
import { DatabaseError } from "./db/errors.ts";
import type { PurgeCounts, RetentionStore } from "./db/retention.ts";
import type { Logger } from "./logger.ts";

/** The first run comes this long after the start, plus up to `RETENTION_JITTER_MS`. */
export const RETENTION_START_DELAY_MS = 3 * 60_000;
/** Instances started together by one deploy do not all try at the same moment. */
export const RETENTION_JITTER_MS = 2 * 60_000;
/** From the end of one run to the start of the next. */
export const RETENTION_PERIOD_MS = 24 * 60 * 60_000;

export interface RetentionOptions {
  store: Pick<RetentionStore, "purge">;
  ttlDays: number;
  logger: Logger;
  /**
   * The rooms (by id) with a socket on any instance, asked at each run. A rejection (an
   * instance did not answer, #39) skips the run: a room in use must never be taken for an
   * idle one.
   */
  occupied?: () => readonly string[] | Promise<readonly string[]>;
  /**
   * The run's clock, epoch milliseconds, for tests. Left out (production), each run reads
   * Postgres's `now()`, the clock that writes `last_active_at`.
   */
  now?: () => number;
  /** In [0, 1): the share of the jitter. `Math.random` by default. */
  random?: () => number;
  startDelayMs?: number;
  jitterMs?: number;
  periodMs?: number;
  /** Rows per statement (`PURGE_BATCH` by default). */
  batchSize?: number;
}

/** How a run ended: its counts, `busy` (another instance held the lock) or `failed`. */
export type RetentionRun = PurgeCounts | "busy" | "failed";

export interface Retention {
  /** Runs one purge now, outside the schedule (tests), unless one is running. */
  runNow(): Promise<RetentionRun>;
  /** Clears the timer, stops a run at its next batch and waits for it. Idempotent. */
  stop(): Promise<void>;
}

export function startRetention(options: RetentionOptions): Retention {
  const {
    store,
    ttlDays,
    occupied = () => [],
    now,
    random = Math.random,
    startDelayMs = RETENTION_START_DELAY_MS,
    jitterMs = RETENTION_JITTER_MS,
    periodMs = RETENTION_PERIOD_MS,
    batchSize,
  } = options;
  const log = options.logger.child({ part: "retention" });
  const aborter = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running: Promise<RetentionRun> | undefined;

  function schedule(delayMs: number) {
    if (aborter.signal.aborted) return;
    timer = setTimeout(() => {
      timer = undefined;
      void runOnce().then(() => schedule(periodMs));
    }, delayMs);
    // The job never keeps the process alive: a shutdown does not wait for the next run.
    timer.unref();
  }

  function runOnce(): Promise<RetentionRun> {
    running ??= purge().finally(() => {
      running = undefined;
    });
    return running;
  }

  async function purge(): Promise<RetentionRun> {
    const started = performance.now();
    const durationMs = () => Math.round(performance.now() - started);
    let inUse: readonly string[];
    try {
      // One instance answers at once; a store called in the same tick keeps the order.
      const asked = occupied();
      inUse = asked instanceof Promise ? await asked : asked;
    } catch {
      log.warn({ durationMs: durationMs() }, "retention: rooms in use unknown, run skipped");
      return "failed";
    }
    try {
      const counts = await store.purge({
        ...(now && { now: new Date(now()) }),
        ttlDays,
        occupied: inUse,
        signal: aborter.signal,
        ...(batchSize !== undefined && { batchSize }),
      });
      if (counts === null) {
        // At info: a lock that never frees (a transaction-mode pooler, a stuck session)
        // must not stop the purge without a trace.
        log.info("retention: another instance runs the purge");
        return "busy";
      }
      const { rooms, history, guests, passwordWindows, interrupted } = counts;
      log.info(
        { rooms, history, guests, passwordWindows, interrupted, durationMs: durationMs() },
        "retention: purge done",
      );
      return counts;
    } catch (error) {
      // The code alone: a driver message can name the host or the user.
      const code = error instanceof DatabaseError ? error.code : "unknown";
      log.warn({ err: code, durationMs: durationMs() }, "retention: purge failed");
      return "failed";
    }
  }

  schedule(startDelayMs + Math.floor(random() * jitterMs));

  return {
    runNow: runOnce,
    stop: async () => {
      aborter.abort();
      clearTimeout(timer);
      timer = undefined;
      await running;
    },
  };
}
