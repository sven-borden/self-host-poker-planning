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
  it("splits the time from the start to the reveal into minutes and seconds", () => {
    expect(votingTime({ startedAt: 1_000, revealedAt: 134_000 })).toEqual({
      total: 133,
      minutes: 2,
      seconds: 13,
    });
    expect(votingTime({ startedAt: 0, revealedAt: 41_600 })).toEqual({
      total: 42,
      minutes: 0,
      seconds: 42,
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
