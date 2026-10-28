import type { HistoryRoundView } from "@pp/protocol";
import { describe, expect, it } from "vitest";
import {
  historyKey,
  NO_ROUNDS,
  sameDay,
  votingTime,
  withEarlierPage,
  withFirstPage,
} from "./history-view.ts";

const round = (number: number): HistoryRoundView => ({
  number,
  subject: { kind: "none" },
  final: null,
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
  startedAt: 0,
  revealedAt: 0,
  finishedAt: 0,
  votes: { kind: "anonymous", cards: [] },
});
const rounds = (...numbers: number[]) => numbers.map(round);
const numbersOf = (list: { rounds: HistoryRoundView[] }) => list.rounds.map((r) => r.number);

describe("withFirstPage", () => {
  it("takes the first page as it is into an empty panel", () => {
    expect(withFirstPage(NO_ROUNDS, { rounds: rounds(3, 2), next: 2 })).toEqual({
      rounds: rounds(3, 2),
      next: 2,
    });
    expect(withFirstPage(NO_ROUNDS, { rounds: [] })).toEqual(NO_ROUNDS);
  });

  it("puts a new round on top and keeps the earlier pages already loaded", () => {
    // Rounds 10 to 5 loaded in two pages of 3; round 11 ended since.
    const shown = { rounds: rounds(10, 9, 8, 7, 6, 5), next: 5 };
    const next = withFirstPage(shown, { rounds: rounds(11, 10, 9), next: 9 });
    expect(numbersOf(next)).toEqual([11, 10, 9, 8, 7, 6, 5]);
    expect(next.next).toBe(5);
  });

  it("keeps the next page's cursor when only the first page was loaded", () => {
    const shown = { rounds: rounds(10, 9, 8), next: 8 };
    const next = withFirstPage(shown, { rounds: rounds(11, 10, 9), next: 9 });
    expect(numbersOf(next)).toEqual([11, 10, 9, 8]);
    expect(next.next).toBe(8);
  });

  it("drops the rounds held when the page does not reach them, so none goes missing", () => {
    // Rounds 60 to 21 held; 25 rounds ended since, and the new first page holds 85 to 66.
    const held = { rounds: rounds(...Array.from({ length: 40 }, (_, i) => 60 - i)), next: 21 };
    const page = { rounds: rounds(...Array.from({ length: 20 }, (_, i) => 85 - i)), next: 66 };
    const merged = withFirstPage(held, page);
    expect(numbersOf(merged)).toEqual(numbersOf(page));
    // "Show earlier rounds" goes on at 65, not at 21.
    expect(merged.next).toBe(66);
  });

  it("keeps the rounds held when they overlap the page or touch it", () => {
    const page = { rounds: rounds(12, 11, 10), next: 10 };
    // Overlap: 11 and 10 come from the page.
    const overlap = withFirstPage({ rounds: rounds(11, 10, 9, 8), next: 8 }, page);
    expect(numbersOf(overlap)).toEqual([12, 11, 10, 9, 8]);
    expect(overlap.next).toBe(8);
    // The held top is the page's oldest round.
    const same = withFirstPage({ rounds: rounds(10, 9, 8), next: 8 }, page);
    expect(numbersOf(same)).toEqual([12, 11, 10, 9, 8]);
    // The held top is the round just below the page: no round lies between.
    const touch = withFirstPage({ rounds: rounds(9, 8), next: 8 }, page);
    expect(numbersOf(touch)).toEqual([12, 11, 10, 9, 8]);
    expect(touch.next).toBe(8);
    // One round number between them: it may hold a round, so the page replaces them.
    const gap = withFirstPage({ rounds: rounds(8, 7), next: 7 }, page);
    expect(numbersOf(gap)).toEqual([12, 11, 10]);
    expect(gap.next).toBe(10);
  });

  it("replaces everything with a first page that holds every round", () => {
    const shown = { rounds: rounds(2, 1), next: undefined };
    expect(numbersOf(withFirstPage(shown, { rounds: rounds(3, 2, 1) }))).toEqual([3, 2, 1]);
  });

  it("takes a rewritten row from the new page", () => {
    const shown = { rounds: rounds(2, 1), next: undefined };
    const rewritten = { ...round(2), final: "8" };
    const next = withFirstPage(shown, { rounds: [rewritten, round(1)] });
    expect(next.rounds[0]?.final).toBe("8");
  });
});

describe("withEarlierPage", () => {
  it("adds the page at the end, without repeating a round, and moves the cursor", () => {
    const shown = { rounds: rounds(5, 4), next: 4 };
    expect(withEarlierPage(shown, { rounds: rounds(4, 3, 2), next: 2 })).toEqual({
      rounds: rounds(5, 4, 3, 2),
      next: 2,
    });
    expect(withEarlierPage(shown, { rounds: rounds(3) }).next).toBeUndefined();
  });
});

describe("historyKey", () => {
  it("changes with the table's round number and its final, not with votes", () => {
    expect(historyKey(undefined)).toBe("lobby");
    expect(historyKey({ round: null })).toBe("lobby");
    const voting = { round: { number: 4, phase: "voting" } } as never;
    expect(historyKey(voting)).toBe("4:");
    const revealed = { round: { number: 4, phase: "revealed" } } as never;
    expect(historyKey(revealed)).toBe("4:");
    const decided = { round: { number: 4, phase: "revealed", final: "8" } } as never;
    expect(historyKey(decided)).toBe("4:8");
  });
});

describe("votingTime", () => {
  it("splits the time from the start to the reveal into hours, minutes and seconds", () => {
    expect(votingTime({ startedAt: 1_000, revealedAt: 134_000 })).toEqual({
      total: 133,
      hours: 0,
      minutes: 2,
      seconds: 13,
    });
    expect(votingTime({ startedAt: 0, revealedAt: 41_600 })).toEqual({
      total: 42,
      hours: 0,
      minutes: 0,
      seconds: 42,
    });
    // From an hour on: 62 min 5 s is 1 h, 2 min and 5 s.
    expect(votingTime({ startedAt: 0, revealedAt: 3_725_000 })).toEqual({
      total: 3725,
      hours: 1,
      minutes: 2,
      seconds: 5,
    });
    // A clock that went back never shows a negative time.
    expect(votingTime({ startedAt: 5_000, revealedAt: 1_000 }).total).toBe(0);
  });
});

describe("sameDay", () => {
  it("compares calendar days where the reader is", () => {
    const morning = new Date(2026, 9, 28, 8, 0).getTime();
    expect(sameDay(morning, new Date(2026, 9, 28, 23, 59).getTime())).toBe(true);
    expect(sameDay(morning, new Date(2026, 9, 27, 23, 59).getTime())).toBe(false);
  });
});
