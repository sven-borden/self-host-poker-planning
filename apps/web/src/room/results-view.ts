import { isNumericDeck } from "@pp/domain";
import type { RoomView } from "@pp/protocol";
import type { TFunction } from "../i18n/i18n.ts";
import type { Extreme } from "../table/seat.tsx";

// What a revealed round says (#20), read from the server's `round.results`: the domain's
// `computeResults` over the round's votes (a named round's `votes`, the departed and the
// off-table ones included; an anonymous round's unmapped cards) and its deck. Nothing is
// computed again here: this only sorts the numbers into what the page shows (counted
// cards, the cards that do not count, ties, the lowest and highest voters). Pure, so the
// unit tests hold it against the domain for every deck.

export type RevealedRound = Extract<NonNullable<RoomView["round"]>, { phase: "revealed" }>;

/** The centre's one line and the live region's sentence. */
export type RevealSummary =
  | { kind: "consensus"; card: string }
  /** `mostVoted` on a deck without numbers, where the suggestion is the most played card. */
  | { kind: "suggested"; card: string; agreement: number; mostVoted: boolean }
  /** No card counts: nobody voted, or only special cards were played. */
  | { kind: "none" };

export interface ResultColumn {
  card: string;
  count: number;
  /** Named rounds with a spread: the lowest or the highest card played. */
  extreme?: Extreme;
}

export interface ResultsModel {
  anonymous: boolean;
  /** A numeric deck: average and median; otherwise the most voted card. */
  numeric: boolean;
  /** The cards that count, in the deck's order, with how many played each. */
  columns: ResultColumn[];
  /** Special cards (and any card outside the deck): listed, never counted. */
  uncounted: Array<{ card: string; count: number }>;
  /** How many votes count. */
  counted: number;
  average: number | null;
  median: number | null;
  /** From 0 to 1; null when no vote counts. */
  agreement: number | null;
  spread: [string, string] | null;
  /** The cards played most often, in deck order: several on a tie. */
  mostVoted: string[];
  summary: RevealSummary;
  /**
   * Named rounds with a spread: who played the lowest and the highest card, in the order
   * the round lists its votes. A name is null for a departed vote the server kept no name for.
   */
  extremes: Array<{ extreme: Extreme; card: string; names: Array<string | null> }>;
}

/** The lowest or the highest card of a named round whose cards differ; never anonymous. */
export function extremeOf(round: RevealedRound, card: string): Extreme | undefined {
  const spread = round.results.spread;
  if (round.anonymous || spread === null || spread[0] === spread[1]) return undefined;
  if (card === spread[0]) return "low";
  if (card === spread[1]) return "high";
  return undefined;
}

export function revealSummary(round: RevealedRound): RevealSummary {
  const { results } = round;
  if (results.suggested === null) return { kind: "none" };
  if (results.consensus) return { kind: "consensus", card: results.mode ?? results.suggested };
  return {
    kind: "suggested",
    card: results.suggested,
    agreement: results.agreement,
    mostVoted: !isNumericDeck(round.deck),
  };
}

/** "Consensus on 8.", "Suggested 5, agreement 60%.", "Nothing to count." */
export function summarySentence(t: TFunction, summary: RevealSummary): string {
  switch (summary.kind) {
    case "consensus":
      return t("results.consensusOn", { card: summary.card });
    case "suggested":
      return t(summary.mostVoted ? "results.mostVotedAgreement" : "results.suggestedAgreement", {
        card: summary.card,
        agreement: summary.agreement,
      });
    case "none":
      return t("results.nothing");
  }
}

/** The results panel's content, or null before a reveal. */
export function resultsModel(room: RoomView): ResultsModel | null {
  const round = room.round;
  if (round?.phase !== "revealed") return null;
  const { results } = round;
  const counts = new Set(results.core);
  const columns: ResultColumn[] = [];
  const uncounted: ResultsModel["uncounted"] = [];
  for (const { card, count } of results.distribution) {
    if (!counts.has(card)) {
      uncounted.push({ card, count });
      continue;
    }
    const extreme = extremeOf(round, card);
    columns.push(extreme ? { card, count, extreme } : { card, count });
  }
  const top = Math.max(0, ...columns.map((c) => c.count));
  const counted = results.core.length;

  const extremes: ResultsModel["extremes"] = [];
  if (!round.anonymous && results.spread !== null) {
    const people = new Map(room.participants.map((p) => [p.id, p.name]));
    for (const column of columns) {
      if (!column.extreme) continue;
      const names = round.votes
        .filter((vote) => vote.card === column.card)
        .map((vote) => people.get(vote.who) ?? vote.name ?? null);
      extremes.push({ extreme: column.extreme, card: column.card, names });
    }
  }

  return {
    anonymous: round.anonymous,
    numeric: isNumericDeck(round.deck),
    columns,
    uncounted,
    counted,
    average: results.average,
    median: results.median,
    agreement: counted > 0 ? results.agreement : null,
    spread: results.spread,
    mostVoted: counted > 0 ? columns.filter((c) => c.count === top).map((c) => c.card) : [],
    summary: revealSummary(round),
    extremes,
  };
}
