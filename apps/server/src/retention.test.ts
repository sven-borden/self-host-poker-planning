/**
 * The retention job's schedule on fake timers, with a fake store: the first run after the
 * start delay and its jitter, then one every period, nothing after `stop`, a run in
 * progress stopped and awaited, and one log line per run with counts only. The purge
 * itself, against Postgres: `db/retention.db.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DatabaseError } from "./db/errors.ts";
import { cutoffOf, type PurgeCounts, type PurgeOptions, touchAfterMs } from "./db/retention.ts";
import {
  RETENTION_JITTER_MS,
  RETENTION_PERIOD_MS,
  RETENTION_START_DELAY_MS,
  type RetentionOptions,
  startRetention,
} from "./retention.ts";
import { collectLogs } from "./test-support.ts";

const COUNTS: PurgeCounts = {
  rooms: 3,
  history: 7,
  guests: 2,
  passwordWindows: 1,
  batches: 2,
  interrupted: false,
};
const NOW = Date.UTC(2027, 0, 15, 12);
const MINUTE = 60_000;

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

function job(
  purge: (options: PurgeOptions) => Promise<PurgeCounts | null> = async () => COUNTS,
  options: Partial<RetentionOptions> = {},
) {
  const logs = collectLogs();
  const calls: PurgeOptions[] = [];
  const retention = startRetention({
    store: {
      purge: (o) => {
        calls.push(o);
        return purge(o);
      },
    },
    ttlDays: 90,
    logger: logs.logger,
    now: () => NOW,
    random: () => 0.5,
    ...options,
  });
  return { retention, calls, logs };
}

describe("the schedule", () => {
  it("runs first after the start delay plus its share of the jitter", async () => {
    const { retention, calls } = job();
    const first = RETENTION_START_DELAY_MS + RETENTION_JITTER_MS / 2;
    await vi.advanceTimersByTimeAsync(first - 1);
    expect(calls).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toHaveLength(1);
    await retention.stop();
  });

  it("starts three to five minutes after the start", () => {
    expect(RETENTION_START_DELAY_MS).toBe(3 * MINUTE);
    expect(RETENTION_START_DELAY_MS + RETENTION_JITTER_MS).toBe(5 * MINUTE);
    expect(RETENTION_PERIOD_MS).toBe(24 * 60 * MINUTE);
  });

  it("jitters from no delay to the whole jitter", async () => {
    const early = job(undefined, { random: () => 0 });
    await vi.advanceTimersByTimeAsync(RETENTION_START_DELAY_MS);
    expect(early.calls).toHaveLength(1);
    await early.retention.stop();
    const late = job(undefined, { random: () => 0.999_999 });
    await vi.advanceTimersByTimeAsync(RETENTION_START_DELAY_MS + RETENTION_JITTER_MS - 2);
    expect(late.calls).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(2);
    expect(late.calls).toHaveLength(1);
    await late.retention.stop();
  });

  it("runs again every period after a run, also after one that failed or was busy", async () => {
    const results: (PurgeCounts | null | Error)[] = [
      COUNTS,
      new DatabaseError("purge rooms", "57P01"),
      null,
    ];
    const { retention, calls } = job(async () => {
      const next = results.shift() ?? COUNTS;
      if (next instanceof Error) throw next;
      return next;
    });
    await vi.advanceTimersByTimeAsync(RETENTION_START_DELAY_MS + RETENTION_JITTER_MS);
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(RETENTION_PERIOD_MS);
    expect(calls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(RETENTION_PERIOD_MS);
    expect(calls).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(RETENTION_PERIOD_MS);
    expect(calls).toHaveLength(4);
    await retention.stop();
  });

  it("never keeps the process alive: the timer is unref'd", async () => {
    const unref = vi.fn();
    const spy = vi.spyOn(globalThis, "setTimeout");
    spy.mockImplementationOnce(() => ({ unref }) as unknown as ReturnType<typeof setTimeout>);
    const { retention } = job();
    expect(unref).toHaveBeenCalledOnce();
    spy.mockRestore();
    await retention.stop();
  });

  it("runs no more once stopped", async () => {
    const { retention, calls } = job();
    await retention.stop();
    await vi.advanceTimersByTimeAsync(RETENTION_PERIOD_MS * 3);
    expect(calls).toHaveLength(0);
    await retention.stop();
  });

  it("stops a run in progress through its signal and waits for it", async () => {
    let finish: (() => void) | undefined;
    const { retention, calls } = job(
      (o) =>
        new Promise((resolve) => {
          finish = () => resolve({ ...COUNTS, interrupted: o.signal?.aborted === true });
        }),
    );
    await vi.advanceTimersByTimeAsync(RETENTION_START_DELAY_MS + RETENTION_JITTER_MS);
    expect(calls).toHaveLength(1);
    let stopped = false;
    const stopping = retention.stop().then(() => {
      stopped = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(calls[0]?.signal?.aborted).toBe(true);
    expect(stopped).toBe(false);
    finish?.();
    await stopping;
    expect(stopped).toBe(true);
    await vi.advanceTimersByTimeAsync(RETENTION_PERIOD_MS * 2);
    expect(calls).toHaveLength(1);
  });

  it("runs one purge at a time: runNow during a run joins it", async () => {
    let finish: (() => void) | undefined;
    const { retention, calls } = job(
      () =>
        new Promise((resolve) => {
          finish = () => resolve(COUNTS);
        }),
    );
    const one = retention.runNow();
    const two = retention.runNow();
    expect(calls).toHaveLength(1);
    finish?.();
    expect(await one).toBe(await two);
    await retention.stop();
  });
});

describe("a run", () => {
  it("passes the clock, the TTL, the occupied rooms and the batch size", async () => {
    const { retention, calls } = job(undefined, {
      ttlDays: 1,
      occupied: () => ["room-a"],
      batchSize: 2,
    });
    await retention.runNow();
    expect(calls[0]).toMatchObject({
      now: new Date(NOW),
      ttlDays: 1,
      occupied: ["room-a"],
      batchSize: 2,
    });
    await retention.stop();
  });

  it("logs one line with the counts and the duration, nothing else", async () => {
    const { retention, logs } = job();
    expect(await retention.runNow()).toEqual(COUNTS);
    const lines = logs.lines.filter((line) => line.part === "retention");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      level: 30,
      msg: "retention: purge done",
      rooms: 3,
      history: 7,
      guests: 2,
      passwordWindows: 1,
      interrupted: false,
    });
    expect(typeof lines[0]?.durationMs).toBe("number");
    await retention.stop();
  });

  it("leaves the clock to Postgres when none is injected (production)", async () => {
    const calls: PurgeOptions[] = [];
    const retention = startRetention({
      store: {
        purge: async (o) => {
          calls.push(o);
          return COUNTS;
        },
      },
      ttlDays: 90,
      logger: collectLogs().logger,
    });
    await retention.runNow();
    expect(calls).toHaveLength(1);
    expect(calls[0]).not.toHaveProperty("now");
    await retention.stop();
  });

  it("logs a run another instance holds once, at info: a lock that never frees shows", async () => {
    const { retention, logs } = job(async () => null);
    expect(await retention.runNow()).toBe("busy");
    const lines = logs.lines.filter((line) => line.part === "retention");
    expect(lines).toEqual([
      expect.objectContaining({ level: 30, msg: "retention: another instance runs the purge" }),
    ]);
    await retention.stop();
  });

  it("logs a failure with its code alone and never rejects", async () => {
    const { retention, logs } = job(async () => {
      throw new DatabaseError("purge rooms", "57P01");
    });
    expect(await retention.runNow()).toBe("failed");
    expect(logs.lines.at(-1)).toMatchObject({
      level: 40,
      msg: "retention: purge failed",
      err: "57P01",
    });
    const other = job(async () => {
      throw new Error("connection to postgres://pp:secret@db failed");
    });
    expect(await other.retention.runNow()).toBe("failed");
    expect(other.logs.lines.at(-1)).toMatchObject({ err: "unknown" });
    expect(other.logs.raw.join("")).not.toContain("secret");
    await retention.stop();
    await other.retention.stop();
  });
});

describe("cutoffOf", () => {
  it("is ROOM_TTL_DAYS whole days before the run's clock", () => {
    const now = new Date(NOW);
    expect(cutoffOf(now, 90).toISOString()).toBe("2026-10-17T12:00:00.000Z");
    expect(cutoffOf(now, 1).toISOString()).toBe("2027-01-14T12:00:00.000Z");
    expect(cutoffOf(now, 3650).getTime()).toBe(NOW - 3650 * 24 * 60 * MINUTE);
  });
});

describe("touchAfterMs", () => {
  it("is a day, or a 24th of a shorter period", () => {
    expect(touchAfterMs(90)).toBe(24 * 60 * MINUTE);
    expect(touchAfterMs(24)).toBe(24 * 60 * MINUTE);
    expect(touchAfterMs(1)).toBe(60 * MINUTE);
    expect(touchAfterMs(12)).toBe(12 * 60 * MINUTE);
  });
});
