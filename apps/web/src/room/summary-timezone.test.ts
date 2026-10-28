import type { HistoryRoundView } from "@pp/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isoWithOffset } from "./exports.ts";
import { covers, defaultRange, exportRounds, inRange, startOfDay } from "./summary.ts";

// "Today" is the reader's day, not UTC's. This file runs at UTC+14 (Kiritimati), where
// the local date runs a day ahead of UTC's for ten hours of every day: a summary that
// read the UTC date would put yesterday's rounds into "Today". Node reads TZ again when
// it changes, so the zone is set for this file alone and restored after it.

const ZONE = "Pacific/Kiritimati";
let before: string | undefined;

beforeAll(() => {
  before = process.env.TZ;
  process.env.TZ = ZONE;
});

afterAll(() => {
  if (before === undefined) delete process.env.TZ;
  else process.env.TZ = before;
});

/** 2026-10-28 10:00 at UTC+14, which is still 2026-10-27 in UTC. */
const NOW = Date.UTC(2026, 9, 27, 20, 0);
/** 2026-10-28 09:00 locally (2026-10-27 19:00 UTC): today. */
const THIS_MORNING = Date.UTC(2026, 9, 27, 19, 0);
/** 2026-10-27 23:00 locally (2026-10-27 09:00 UTC): yesterday, though UTC's same day. */
const LAST_NIGHT = Date.UTC(2026, 9, 27, 9, 0);

function row(number: number, finishedAt: number): HistoryRoundView {
  return {
    number,
    subject: { kind: "none" },
    final: "3",
    stats: {
      distribution: [],
      core: [],
      mode: null,
      agreement: 0,
      spread: null,
      consensus: false,
      average: null,
      median: null,
      suggested: null,
    },
    startedAt: finishedAt - 60_000,
    revealedAt: finishedAt - 30_000,
    finishedAt,
    votes: { kind: "anonymous", cards: [] },
  };
}

describe("Today, far from UTC", () => {
  it("runs at UTC+14", () => {
    expect(new Date(NOW).getTimezoneOffset()).toBe(-14 * 60);
    expect(isoWithOffset(NOW)).toBe("2026-10-28T10:00:00+14:00");
  });

  it("starts at the reader's midnight", () => {
    // 2026-10-28 00:00 at UTC+14 is 2026-10-27 10:00 UTC.
    expect(startOfDay(NOW)).toBe(Date.UTC(2026, 9, 27, 10, 0));
  });

  it("keeps the rounds of the reader's day only", () => {
    const rounds = exportRounds([row(2, THIS_MORNING), row(1, LAST_NIGHT)], null);
    expect(inRange(rounds, "today", NOW).map((round) => round.number)).toEqual([2]);
    expect(defaultRange(rounds.slice(0, 1), NOW)).toBe("all");
    expect(defaultRange(rounds, NOW)).toBe("today");
  });

  it("stops reading for Today at a round of the reader's yesterday", () => {
    expect(covers({ rounds: [row(3, THIS_MORNING)], next: 3 }, "today", NOW)).toBe(false);
    expect(
      covers({ rounds: [row(3, THIS_MORNING), row(2, LAST_NIGHT)], next: 2 }, "today", NOW),
    ).toBe(true);
  });
});
