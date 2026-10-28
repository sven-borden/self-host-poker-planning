import { apply, type Command, createRoom, type Participant, type RoomState } from "@pp/domain";
import { type HistoryRoundView, toSnapshot } from "@pp/protocol";
import { describe, expect, it } from "vitest";
import {
  capRounds,
  defaultRange,
  type ExportRound,
  exportRounds,
  inRange,
  MAX_EXPORT_ROUNDS,
  summarize,
  tableRound,
  voteCount,
} from "./summary.ts";

const NOW = new Date(2026, 9, 28, 15, 0, 0).getTime();
const YESTERDAY = new Date(2026, 9, 27, 23, 30, 0).getTime();
const EARLY_TODAY = new Date(2026, 9, 28, 0, 5, 0).getTime();

const stats = (over: Partial<ExportRound["stats"]> = {}): ExportRound["stats"] => ({
  distribution: [],
  core: [],
  mode: null,
  agreement: 0,
  spread: null,
  consensus: false,
  average: null,
  median: null,
  suggested: null,
  ...over,
});

function row(
  number: number,
  final: string | null,
  over: Partial<HistoryRoundView> = {},
): HistoryRoundView {
  return {
    number,
    subject: { kind: "none" },
    final,
    stats: stats(),
    startedAt: NOW - 120_000,
    revealedAt: NOW - 60_000,
    finishedAt: NOW - 1_000,
    votes: { kind: "named", votes: [{ name: "Ana", card: "5" }] },
    ...over,
  };
}

function step(state: RoomState, actor: string, command: Command): RoomState {
  const result = apply(state, command, { actor, now: NOW - 30_000 });
  if (!result.ok) throw new Error(result.error);
  return result.state;
}

/** A room whose round 1 is revealed, Pia 5 and Ana 8, with or without a final. */
function revealedRoom(final?: string) {
  const participants: Record<string, Participant> = {
    po: { name: "Pia", role: "voter", joinedAt: 1, connected: true },
    ana: { name: "Ana", role: "voter", joinedAt: 2, connected: true },
  };
  let state: RoomState = { ...createRoom({ ownerId: "po" }), participants };
  state = step(state, "po", {
    type: "startRound",
    subject: { kind: "title", text: "PAY-9 Login" },
  });
  state = step(state, "po", { type: "castVote", card: "5", round: 1 });
  state = step(state, "ana", { type: "castVote", card: "8", round: 1 });
  if (state.round?.phase !== "revealed") state = step(state, "po", { type: "reveal" });
  if (final !== undefined) state = step(state, "po", { type: "setFinal", card: final });
  return toSnapshot(state, "ana", { code: "abcdefghij", version: 2, now: NOW }).room;
}

describe("the round on the table", () => {
  it("counts once it is revealed and has a final, its reveal standing in for its end", () => {
    const round = tableRound(revealedRoom("8").round);
    expect(round).toMatchObject({
      number: 1,
      subject: { kind: "title", text: "PAY-9 Login" },
      final: "8",
      finishedAt: NOW - 30_000,
      revealedAt: NOW - 30_000,
    });
    expect(round?.stats.distribution).toEqual([
      { card: "5", count: 1 },
      { card: "8", count: 1 },
    ]);
    // Round level only: no votes, no names.
    expect(round && "votes" in round).toBe(false);
    expect(JSON.stringify(round)).not.toMatch(/Ana|Pia/);
  });

  it("does not count before a final, while voting, or in the lobby", () => {
    expect(tableRound(revealedRoom().round)).toBeNull();
    expect(tableRound(null)).toBeNull();
    expect(tableRound(undefined)).toBeNull();
  });

  it("joins the history rounds, oldest first, once per number, without votes", () => {
    const table = tableRound(revealedRoom("8").round);
    const rows = exportRounds([row(3, "5"), row(2, null)], table);
    expect(rows.map((r) => r.number)).toEqual([1, 2, 3]);
    expect(rows.every((r) => !("votes" in r))).toBe(true);
    expect(JSON.stringify(rows)).not.toContain("Ana");
    // A history row wins over the table's round of the same number.
    const same = exportRounds([row(1, "13")], table);
    expect(same).toHaveLength(1);
    expect(same[0]?.final).toBe("13");
    expect(exportRounds([], null)).toEqual([]);
  });
});

describe("today", () => {
  const rounds = exportRounds(
    [
      row(1, "3", { finishedAt: YESTERDAY }),
      row(2, "5", { finishedAt: EARLY_TODAY }),
      row(3, "8", { finishedAt: NOW - 1_000 }),
    ],
    null,
  );

  it("keeps the rounds that ended on the reader's day, from midnight on", () => {
    expect(inRange(rounds, "today", NOW).map((r) => r.number)).toEqual([2, 3]);
    expect(inRange(rounds, "all", NOW).map((r) => r.number)).toEqual([1, 2, 3]);
  });

  it("is the default when a round ended today, else all rounds", () => {
    expect(defaultRange(rounds, NOW)).toBe("today");
    expect(defaultRange(rounds.slice(0, 1), NOW)).toBe("all");
    expect(defaultRange([], NOW)).toBe("all");
  });
});

describe("the summary", () => {
  it("sums the numeric finals and counts the rest, averages agreement and voting time", () => {
    const rounds = exportRounds(
      [
        row(1, "5", {
          stats: stats({ core: ["3", "5", "5"], agreement: 2 / 3 }),
          startedAt: 0,
          revealedAt: 60_000,
        }),
        row(2, "½", {
          stats: stats({ core: ["½"], agreement: 1 }),
          startedAt: 0,
          revealedAt: 30_000,
        }),
        row(3, "M", {
          stats: stats({ core: ["M", "L"], agreement: 0.5 }),
          startedAt: 0,
          revealedAt: 90_000,
        }),
        row(4, "?", { startedAt: 0, revealedAt: 20_000 }),
        // Nobody's card counted: no agreement to average.
        row(5, null, { startedAt: 0, revealedAt: 0 }),
        row(6, "13", {
          stats: stats({ core: ["13"], agreement: 1 }),
          startedAt: 0,
          revealedAt: 40_000,
        }),
      ],
      null,
    );
    const summary = summarize(rounds);
    expect(summary.rounds).toBe(6);
    expect(summary.total).toBe(18.5);
    expect(summary.withoutNumber).toBe(3);
    expect(summary.agreement).toBeCloseTo((2 / 3 + 1 + 0.5 + 1) / 4, 10);
    expect(summary.votingSeconds).toBe(40);
  });

  it("has nothing to average without rounds or counted votes", () => {
    expect(summarize([])).toEqual({
      rounds: 0,
      total: 0,
      withoutNumber: 0,
      agreement: null,
      votingSeconds: null,
    });
    expect(summarize(exportRounds([row(1, null)], null)).agreement).toBeNull();
  });

  it("counts every vote of a round, specials included", () => {
    const round = exportRounds(
      [
        row(1, "5", {
          stats: stats({
            distribution: [
              { card: "5", count: 2 },
              { card: "☕", count: 1 },
            ],
          }),
        }),
      ],
      null,
    )[0];
    expect(round && voteCount(round)).toBe(3);
  });

  it("caps the rounds at 1,000 and says when older ones were left out", () => {
    const many = Array.from({ length: MAX_EXPORT_ROUNDS + 20 }, (_, i) =>
      row(MAX_EXPORT_ROUNDS + 20 - i, "1"),
    );
    expect(capRounds({ rounds: many, next: undefined })).toMatchObject({ capped: true });
    expect(capRounds({ rounds: many, next: undefined }).rounds).toHaveLength(MAX_EXPORT_ROUNDS);
    expect(capRounds({ rounds: many.slice(0, 50), next: 7 }).capped).toBe(true);
    expect(capRounds({ rounds: many.slice(0, 50), next: undefined })).toEqual({
      rounds: many.slice(0, 50),
      capped: false,
    });
  });
});
