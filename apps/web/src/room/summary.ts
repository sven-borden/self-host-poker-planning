import { cardValue } from "@pp/domain";
import type { HistoryRoundView, RoomView } from "@pp/protocol";
import { type HistoryList, sameDay } from "./history-view.ts";

// The session summary (#34): which rounds count, and what they add up to. Pure, so the
// sums, the averages and "Today" are tested without a page. The summary and every export
// read the same rounds: the history (#33), oldest first, plus the round on the table once
// it has a final, since the history leaves that one out until the next round starts.

/**
 * A round as the summary and the exports read it: the history row without its votes, so
 * no name and no person's card can reach a file. The number of votes comes from the
 * distribution.
 */
export type ExportRound = Omit<HistoryRoundView, "votes">;

/** "Today" (rounds that ended today where the reader is) or every round. */
export type Range = "today" | "all";

/** At most this many rounds are fetched for the summary and the exports. */
export const MAX_EXPORT_ROUNDS = 1000;
/** Rounds per history request while fetching them all (the server's maximum). */
export const EXPORT_PAGE = 50;

/** The history row's fields that are not votes, copied one by one (never a vote). */
function withoutVotes(round: ExportRound): ExportRound {
  return {
    number: round.number,
    subject: round.subject,
    final: round.final,
    stats: round.stats,
    startedAt: round.startedAt,
    revealedAt: round.revealedAt,
    finishedAt: round.finishedAt,
  };
}

/**
 * The round on the table when it counts: revealed, with a final estimate recorded. It has
 * not ended yet, so its reveal stands in for the end.
 */
export function tableRound(round: RoomView["round"] | undefined): ExportRound | null {
  if (round?.phase !== "revealed" || round.final === undefined) return null;
  return {
    number: round.number,
    subject: round.subject,
    final: round.final,
    stats: round.results,
    startedAt: round.startedAt,
    revealedAt: round.revealedAt,
    finishedAt: round.revealedAt,
  };
}

/**
 * Every round to count, oldest first, one per number: the history held and the table's
 * round (`tableRound`), which the history never holds.
 */
export function exportRounds(
  history: readonly HistoryRoundView[],
  table: ExportRound | null,
): ExportRound[] {
  const byNumber = new Map<number, ExportRound>();
  for (const round of history) byNumber.set(round.number, withoutVotes(round));
  if (table !== null && !byNumber.has(table.number)) byNumber.set(table.number, table);
  return [...byNumber.values()].sort((a, b) => a.number - b.number);
}

/** The start of `now`'s day where the reader is: local midnight, as epoch ms. */
export function startOfDay(now: number): number {
  const day = new Date(now);
  day.setHours(0, 0, 0, 0);
  return day.getTime();
}

/** The rounds in `range`: "today" keeps those that ended on `now`'s day where the reader is. */
export function inRange(rounds: readonly ExportRound[], range: Range, now: number): ExportRound[] {
  return range === "all" ? [...rounds] : rounds.filter((round) => sameDay(round.finishedAt, now));
}

/** "Today" when a round ended today, else every round. */
export function defaultRange(rounds: readonly ExportRound[], now: number): Range {
  return rounds.some((round) => sameDay(round.finishedAt, now)) ? "today" : "all";
}

export interface Summary {
  /** How many rounds. */
  rounds: number;
  /**
   * The numeric final estimates, summed ("½" counts 0.5). A story counts once: of
   * consecutive rounds with the same subject (a re-vote keeps it), only the last.
   */
  total: number;
  /**
   * Stories (counted as `total` counts them) whose final is not a number (`?`, a T-shirt
   * size) or was never recorded.
   */
  withoutNumber: number;
  /** The mean agreement, from 0 to 1, of the rounds where some vote counted; null if none. */
  agreement: number | null;
  /** The mean voting time (`revealedAt − startedAt`) in seconds; null without rounds. */
  votingSeconds: number | null;
}

/**
 * Whether two rounds estimate the same story: the same title or the same link. Rounds
 * without a subject never do, since a team that types none plays every story that way.
 */
export function sameSubject(a: ExportRound["subject"], b: ExportRound["subject"]): boolean {
  if (a.kind === "title" && b.kind === "title") return a.text === b.text;
  if (a.kind === "link" && b.kind === "link") return a.url === b.url;
  return false;
}

/** What the summary says about `rounds`, oldest first. */
export function summarize(rounds: readonly ExportRound[]): Summary {
  let total = 0;
  let withoutNumber = 0;
  let agreements = 0;
  let agreed = 0;
  let voting = 0;
  rounds.forEach((round, index) => {
    const later = rounds[index + 1];
    // A re-vote follows: the story counts by its last round only.
    if (later === undefined || !sameSubject(round.subject, later.subject)) {
      const value = round.final === null ? null : cardValue(round.final);
      if (value === null) withoutNumber += 1;
      else total += value;
    }
    if (round.stats.core.length > 0) {
      agreements += round.stats.agreement;
      agreed += 1;
    }
    voting += Math.max(0, round.revealedAt - round.startedAt);
  });
  return {
    rounds: rounds.length,
    total,
    withoutNumber,
    agreement: agreed > 0 ? agreements / agreed : null,
    votingSeconds: rounds.length > 0 ? voting / rounds.length / 1000 : null,
  };
}

/** The number of votes in a round: every card played, specials included. */
export function voteCount(round: ExportRound): number {
  return round.stats.distribution.reduce((sum, { count }) => sum + count, 0);
}

/** Whether the oldest round held ended before `now`'s day began where the reader is. */
function reachesBefore(list: HistoryList, now: number): boolean {
  const oldest = list.rounds.at(-1);
  return oldest !== undefined && oldest.finishedAt < startOfDay(now);
}

/**
 * Whether `list` holds every round `range` needs, so no further page is read: the oldest
 * round is in, or `MAX_EXPORT_ROUNDS` are, or (for "Today") a round that ended before
 * local midnight is.
 */
export function covers(list: HistoryList, range: Range, now: number): boolean {
  if (list.next === undefined || list.rounds.length >= MAX_EXPORT_ROUNDS) return true;
  return range === "today" && reachesBefore(list, now);
}

/**
 * The rounds fetched so far for the summary, newest first (a `HistoryList`), capped at
 * `MAX_EXPORT_ROUNDS`; `capped` when the cap left out older rounds that `range` counts.
 */
export function capRounds(
  list: HistoryList,
  range: Range,
  now: number,
): { rounds: HistoryRoundView[]; capped: boolean } {
  const rounds = list.rounds.slice(0, MAX_EXPORT_ROUNDS);
  const cut = list.rounds.length > MAX_EXPORT_ROUNDS || list.next !== undefined;
  const capped =
    rounds.length === MAX_EXPORT_ROUNDS &&
    cut &&
    !(range === "today" && reachesBefore({ rounds, next: undefined }, now));
  return { rounds, capped };
}
