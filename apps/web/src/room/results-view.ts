import { baseCards, isNumericDeck } from "@pp/domain";
import type { RoomView } from "@pp/protocol";
import { formatList } from "../i18n/format.ts";
import { languageOf, type TFunction } from "../i18n/i18n.ts";
import { localeFor } from "../i18n/language.ts";
import type { Extreme } from "../table/seat.tsx";
import { namesakes } from "./namesakes.ts";

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
  /** A deck without numbers whose top count is shared: the tied cards, in deck order. */
  | { kind: "tie"; cards: string[]; agreement: number }
  /** No card counts: nobody voted, or only special cards were played. */
  | { kind: "none" };

export interface ResultColumn {
  card: string;
  count: number;
  /** Named rounds with a spread: the lowest or the highest card played. */
  extreme?: Extreme;
}

/** A name as the room shows it (`shownName`): with its number when someone else has it. */
export interface PersonName {
  name: string;
  namesake?: number;
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
   * the round lists its votes, each with its number when it shares its name (`namesakes`).
   * A name is null for a departed vote the server kept no name for.
   */
  extremes: Array<{ extreme: Extreme; card: string; names: Array<PersonName | null> }>;
}

/** The lowest or the highest card of a named round whose cards differ; never anonymous. */
export function extremeOf(round: RevealedRound, card: string): Extreme | undefined {
  const spread = round.results.spread;
  if (round.anonymous || spread === null || spread[0] === spread[1]) return undefined;
  if (card === spread[0]) return "low";
  if (card === spread[1]) return "high";
  return undefined;
}

/** The counted cards played most often, in deck order: several on a tie, none without votes. */
function mostVotedOf(results: RevealedRound["results"]): string[] {
  const counted = new Set(results.core);
  const columns = results.distribution.filter(({ card }) => counted.has(card));
  const top = Math.max(0, ...columns.map((c) => c.count));
  return columns.filter((c) => c.count === top).map((c) => c.card);
}

/**
 * The centre's result. A numeric deck suggests the card nearest the average, whatever the
 * tie for most voted; a deck without numbers suggests its most voted card, or names the
 * tie when the top count is shared (the panel's "M · L"), never one card of it.
 */
export function revealSummary(round: RevealedRound): RevealSummary {
  const { results } = round;
  if (results.suggested === null) return { kind: "none" };
  if (results.consensus) return { kind: "consensus", card: results.mode ?? results.suggested };
  const numeric = isNumericDeck(round.deck);
  const top = numeric ? [] : mostVotedOf(results);
  if (top.length > 1) return { kind: "tie", cards: top, agreement: results.agreement };
  return {
    kind: "suggested",
    card: results.suggested,
    agreement: results.agreement,
    mostVoted: !numeric,
  };
}

/**
 * "Consensus on 8.", "Suggested 5. Agreement 60%.", "Tie between M and L. Agreement
 * 50%.", "Nothing to count." The agreement is how much the team agrees (the share of the
 * most voted card), not the suggestion's support: the suggested card may be one nobody played.
 */
export function summarySentence(t: TFunction, summary: RevealSummary): string {
  switch (summary.kind) {
    case "consensus":
      return t("results.consensusOn", { card: summary.card });
    case "suggested":
      return t(summary.mostVoted ? "results.mostVotedAgreement" : "results.suggestedAgreement", {
        card: summary.card,
        agreement: summary.agreement,
      });
    case "tie":
      return t("results.tieAgreement", {
        cards: formatList(summary.cards, localeFor(languageOf(t))),
        agreement: summary.agreement,
      });
    case "none":
      return t("results.nothing");
  }
}

/** What the PO's final estimate picker offers after a reveal (#32). */
export interface FinalChoice {
  /** Every card the final may be: the round's deck without the specials, in deck order. */
  cards: readonly string[];
  /**
   * The card picked before the PO touches anything: the recorded final, else the
   * suggestion (a consensus or a suggested card). Null on a tie or with nothing to count:
   * the PO picks, nothing is guessed.
   */
  preselected: string | null;
  /** The suggested card, marked in the picker. */
  suggested: string | null;
  /** The tied cards of a deck without numbers, marked in the picker. */
  tied: readonly string[];
}

/** The picker's cards and marks, from the round's deck and its result (`revealSummary`). */
export function finalChoice(round: RevealedRound): FinalChoice {
  const cards = baseCards(round.deck);
  const summary = revealSummary(round);
  const suggestion =
    summary.kind === "consensus" || summary.kind === "suggested" ? summary.card : null;
  // A suggestion is a deck card; the check keeps a stray value out of the picker.
  const suggested = suggestion !== null && cards.includes(suggestion) ? suggestion : null;
  return {
    cards,
    preselected: round.final ?? suggested,
    suggested,
    tied: summary.kind === "tie" ? summary.cards : [],
  };
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
  const counted = results.core.length;

  const extremes: ResultsModel["extremes"] = [];
  if (!round.anonymous && results.spread !== null) {
    const numbers = namesakes(room.participants);
    const people = new Map(
      room.participants.map((p): [string, PersonName] => {
        const namesake = numbers.get(p.id);
        return [p.id, namesake === undefined ? { name: p.name } : { name: p.name, namesake }];
      }),
    );
    for (const column of columns) {
      if (!column.extreme) continue;
      const names = round.votes
        .filter((vote) => vote.card === column.card)
        .map((vote) => people.get(vote.who) ?? (vote.name ? { name: vote.name } : null));
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
    mostVoted: mostVotedOf(results),
    summary: revealSummary(round),
    extremes,
  };
}
