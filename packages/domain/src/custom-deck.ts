import {
  type Card,
  cardLength,
  cardValue,
  isSpecial,
  MAX_CARD_LENGTH,
  MAX_DECK_CARDS,
  UNITS_PER_CHARACTER,
} from "./decks.ts";

// A custom deck's rules (#4), in a module of their own: the web bundles them only in the
// settings panel's lazy chunk (#26), while `decks.ts` ships with every room.

export type CustomDeckErrorCode =
  | "deck_empty"
  | "deck_too_many_cards"
  | "card_empty"
  | "card_invalid"
  | "card_too_long"
  | "card_duplicate"
  | "card_special";

/** Control and format characters (zero-width space, joiners, tag characters …) are invisible. */
const INVISIBLE = /[\p{Cc}\p{Cf}]/u;
/** A zero-width joiner between two pictographs, as in "👨‍👩‍👧"; `$1` keeps what precedes it. */
const EMOJI_JOINER =
  /(\p{Extended_Pictographic}[\uFE0E\uFE0F\u{1F3FB}-\u{1F3FF}]*)\u200D(?=\p{Extended_Pictographic})/gu;

/**
 * Validates the labels of a custom deck. On success the cards are trimmed and
 * NFC-normalised, in the given order. Specials are refused (also with a variation
 * selector, "☕️"): they are a room setting. Labels with control or format characters or
 * a lone surrogate are refused, except a zero-width joiner inside an emoji sequence.
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
    // A lone surrogate is not text, and Postgres jsonb would refuse it.
    if (!card.isWellFormed() || INVISIBLE.test(card.replace(EMOJI_JOINER, "$1"))) {
      return { ok: false, code: "card_invalid" };
    }
    if (card.length > MAX_CARD_LENGTH * UNITS_PER_CHARACTER || cardLength(card) > MAX_CARD_LENGTH) {
      return { ok: false, code: "card_too_long" };
    }
    if (isSpecial(card.replace(/[\uFE0E\uFE0F]/gu, ""))) return { ok: false, code: "card_special" };
    if (out.includes(card)) return { ok: false, code: "card_duplicate" };
    // Equal numeric values (1 and 1.0, ½ and 0.5, -0 and 0) would split the votes.
    const value = cardValue(card);
    if (value !== null && out.some((other) => cardValue(other) === value)) {
      return { ok: false, code: "card_duplicate" };
    }
    out.push(card);
  }
  return { ok: true, cards: out };
}
