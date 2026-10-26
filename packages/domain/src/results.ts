import {
  baseCards,
  type Card,
  cardValue,
  type DeckSpec,
  isNumericDeck,
  SPECIAL_CARDS,
} from "./decks.ts";

export type Results = {
  /** Every voted card with its count, specials included, in display order. */
  distribution: Array<{ card: Card; count: number }>;
  /** The non-special votes, sorted by deck order. Only these count in statistics. */
  core: Card[];
  /** The core card with the highest count; a tie goes to the earlier card in deck order. */
  mode: Card | null;
  /** Mode count divided by core count, from 0 to 1; 0 with no core votes. */
  agreement: number;
  /** The lowest and highest core card by deck order. */
  spread: [Card, Card] | null;
  /** At least 3 core votes, all the same card. */
  consensus: boolean;
  /** The mean of the core values; numeric decks only. */
  average: number | null;
  /** The middle core value, or the mean of the two middles; numeric decks only. */
  median: number | null;
  /** Numeric decks: the deck card nearest the average (a tie goes to the lower card). Otherwise the mode. */
  suggested: Card | null;
};

/** Distances closer than this are a tie, so binary noise never breaks one. */
const EPSILON = 1e-9;

/** Orders labels by Unicode code point (not by UTF-16 unit), the same on every engine. */
function byCodePoint(a: string, b: string): number {
  const x = Array.from(a);
  const y = Array.from(b);
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const d = (x[i]?.codePointAt(0) ?? 0) - (y[i]?.codePointAt(0) ?? 0);
    if (d !== 0) return d;
  }
  return x.length - y.length;
}

/**
 * The results of a revealed round, plain and unrounded (the UI rounds and formats).
 * `votes` holds one card per vote, in any order. A vote for a card outside the deck
 * shows in the distribution, after the deck's cards and sorted by code point, but counts in no statistic.
 */
export function computeResults(votes: readonly Card[], deck: DeckSpec): Results {
  // A Set keeps the first occurrence, so a duplicate label in a custom deck counts once.
  const cards = [...new Set(baseCards(deck))];
  const counts = new Map<Card, number>();
  for (const v of votes) counts.set(v, (counts.get(v) ?? 0) + 1);

  // Display order: the deck's cards, the specials, then cards outside the deck by code
  // point. Never input order: the state machine passes votes in the room's order, and
  // in anonymous mode that order must not tie a value to a voter.
  const known = new Set<Card>([...cards, ...SPECIAL_CARDS]);
  const outside = [...counts.keys()].filter((card) => !known.has(card)).sort(byCodePoint);
  const order = [...known, ...outside];
  const distribution = order
    .filter((card) => counts.has(card))
    .map((card) => ({ card, count: counts.get(card) ?? 0 }));

  const core: Card[] = [];
  let mode: Card | null = null;
  let modeCount = 0;
  for (const card of cards) {
    const n = counts.get(card) ?? 0;
    for (let i = 0; i < n; i++) core.push(card);
    if (n > modeCount) {
      mode = card;
      modeCount = n;
    }
  }

  const first = core[0];
  const last = core[core.length - 1];
  const results: Results = {
    distribution,
    core,
    mode,
    agreement: core.length ? modeCount / core.length : 0,
    spread: first !== undefined && last !== undefined ? [first, last] : null,
    consensus: core.length >= 3 && modeCount === core.length,
    average: null,
    median: null,
    suggested: mode,
  };
  if (core.length === 0 || !isNumericDeck(deck)) return results;

  const values = core.map((c) => cardValue(c) ?? 0).sort((a, b) => a - b);
  const m = values.length;
  const average = values.reduce((a, b) => a + b, 0) / m;
  const half = Math.floor(m / 2);
  const median = m % 2 ? (values[half] ?? 0) : ((values[half - 1] ?? 0) + (values[half] ?? 0)) / 2;

  let suggested: Card | null = null;
  let best = Number.POSITIVE_INFINITY;
  let bestValue = Number.POSITIVE_INFINITY;
  for (const card of cards) {
    const value = cardValue(card) ?? 0;
    const distance = Math.abs(value - average);
    if (distance < best - EPSILON || (Math.abs(distance - best) <= EPSILON && value < bestValue)) {
      suggested = card;
      best = distance;
      bestValue = value;
    }
  }
  return { ...results, average, median, suggested };
}
