/**
 * Cards and decks. A card is its label, and the label is canonical: the domain never
 * localises it (the UI may display "0.5" as "0,5", the card stays "0.5").
 */

/** A card label: "0", "½", "13", "XL", "?", "☕", "∞" or a custom label. */
export type Card = string;

/** The special cards, in display order. They are a room setting, never deck cards. */
export const SPECIAL_CARDS = ["?", "☕", "∞"] as const;
export type SpecialCard = (typeof SPECIAL_CARDS)[number];

export const PRESET_DECK_IDS = ["fib", "mfib", "tshirt", "pow2", "seq"] as const;
export type PresetDeckId = (typeof PRESET_DECK_IDS)[number];

export type DeckSpec = { kind: "preset"; id: PresetDeckId } | { kind: "custom"; cards: Card[] };

/** The cards of each preset deck, in display order, without specials. */
export const PRESET_DECKS: Readonly<Record<PresetDeckId, readonly Card[]>> = {
  fib: ["0", "1", "2", "3", "5", "8", "13", "21"],
  mfib: ["0", "½", "1", "2", "3", "5", "8", "13", "20", "40", "100"],
  tshirt: ["XS", "S", "M", "L", "XL", "XXL"],
  pow2: ["0", "1", "2", "4", "8", "16", "32", "64"],
  seq: ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10"],
};

/** A custom deck holds at most this many cards. */
export const MAX_DECK_CARDS = 20;
/** A card label holds at most this many user-perceived characters. */
export const MAX_CARD_LENGTH = 4;

export function isSpecial(card: Card): card is SpecialCard {
  return (SPECIAL_CARDS as readonly string[]).includes(card);
}

/** The deck's own cards (no specials), in display order. */
export function baseCards(deck: DeckSpec): readonly Card[] {
  return deck.kind === "preset" ? PRESET_DECKS[deck.id] : deck.cards.filter((c) => !isSpecial(c));
}

/**
 * The playable cards in display order: the deck's cards, then the enabled specials in
 * `SPECIAL_CARDS` order (whatever order `specials` lists them in).
 */
export function deckCards(deck: DeckSpec, specials: readonly SpecialCard[]): Card[] {
  return [...baseCards(deck), ...SPECIAL_CARDS.filter((s) => specials.includes(s))];
}

const DECIMAL = /^-?\d+(?:\.\d+)?$/;

/**
 * The numeric value of a card, or `null` for a non-numeric card (T-shirt sizes,
 * specials, free text). "½" is 0.5; "0.5" and "1.5" are decimals with "." as the mark.
 */
export function cardValue(card: Card): number | null {
  if (card === "½") return 0.5;
  return DECIMAL.test(card) ? Number(card) : null;
}

/** True when every non-special card of the deck has a numeric value. */
export function isNumericDeck(deck: DeckSpec): boolean {
  return baseCards(deck).every((c) => cardValue(c) !== null);
}

const graphemes = new Intl.Segmenter("en", { granularity: "grapheme" });

/** The length of a label in user-perceived characters ("☕" and "👍🏽" count as 1). */
export function cardLength(label: string): number {
  return Array.from(graphemes.segment(label)).length;
}

export type CustomDeckErrorCode =
  | "deck_empty"
  | "deck_too_many_cards"
  | "card_empty"
  | "card_too_long"
  | "card_duplicate"
  | "card_special";

/**
 * Validates the labels of a custom deck. On success the cards are trimmed and
 * NFC-normalised, in the given order. Specials are refused: they are a room setting.
 */
export function validateCustomDeck(
  cards: readonly string[],
): { ok: true; cards: Card[] } | { ok: false; code: CustomDeckErrorCode } {
  if (cards.length === 0) return { ok: false, code: "deck_empty" };
  if (cards.length > MAX_DECK_CARDS) return { ok: false, code: "deck_too_many_cards" };
  const out: Card[] = [];
  for (const raw of cards) {
    const card = raw.trim().normalize("NFC");
    if (card === "") return { ok: false, code: "card_empty" };
    if (cardLength(card) > MAX_CARD_LENGTH) return { ok: false, code: "card_too_long" };
    if (isSpecial(card)) return { ok: false, code: "card_special" };
    if (out.includes(card)) return { ok: false, code: "card_duplicate" };
    out.push(card);
  }
  return { ok: true, cards: out };
}
