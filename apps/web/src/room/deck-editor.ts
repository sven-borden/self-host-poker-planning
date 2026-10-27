import {
  type Card,
  type CustomDeckErrorCode,
  cardValue,
  generateRange,
  MAX_CARD_LENGTH,
  MAX_DECK_CARDS,
  type RangeErrorCode,
  validateCustomDeck,
} from "@pp/domain";
import type { TFunction } from "../i18n/i18n.ts";

// The custom deck editor's rules (#26), pure so the unit tests read every message: the
// cards a PO types, what is wrong with them in plain words, and the range generator's
// inputs. The domain decides (`validateCustomDeck`, `generateRange`); this file only
// finds the card at fault and words it.

/**
 * The cards of the custom field: split on commas, trimmed. A trailing comma (the PO is
 * about to type the next card) is not an empty card; one between two cards is.
 */
export function splitCards(text: string): string[] {
  const parts = text.split(",").map((part) => part.trim());
  while (parts.length > 0 && parts.at(-1) === "") parts.pop();
  return parts;
}

/** What is wrong with a custom deck, with the card at fault when there is one. */
export type DeckProblem =
  | { code: "deck_empty" }
  | { code: "deck_too_many_cards"; count: number }
  | { code: "card_empty" | "card_invalid"; position: number }
  | { code: "card_too_long" | "card_special"; card: string }
  | { code: "card_duplicate"; card: string; other: string };

export type DeckCheck = { ok: true; cards: Card[] } | { ok: false; problem: DeckProblem };

/**
 * The custom field's cards as the domain will take them, or the first problem. The
 * domain reads the cards in order and stops at the first one it refuses, so the card at
 * fault ends the shortest prefix it refuses.
 */
export function checkCustomDeck(text: string): DeckCheck {
  const typed = splitCards(text);
  const result = validateCustomDeck(typed);
  if (result.ok) return result;
  return { ok: false, problem: problemOf(result.code, typed) };
}

function problemOf(code: CustomDeckErrorCode, typed: readonly string[]): DeckProblem {
  if (code === "deck_empty") return { code };
  if (code === "deck_too_many_cards") return { code, count: typed.length };
  const at = Math.max(
    0,
    typed.findIndex((_, i) => !validateCustomDeck(typed.slice(0, i + 1)).ok),
  );
  if (code === "card_empty" || code === "card_invalid") return { code, position: at + 1 };
  const card = canonical(typed[at] ?? "");
  if (code !== "card_duplicate") return { code, card };
  // The card it repeats: the same label, or another with the same value (1 and 1.0).
  const value = cardValue(card);
  const other =
    typed
      .slice(0, at)
      .map(canonical)
      .find((c) => c === card || (value !== null && cardValue(c) === value)) ?? card;
  return { code, card, other };
}

const canonical = (card: string) => card.trim().normalize("NFC");

/** A deck problem in plain words, naming the card at fault. */
export function deckProblemMessage(t: TFunction, problem: DeckProblem): string {
  switch (problem.code) {
    case "deck_empty":
      return t("deckField.deck_empty");
    case "deck_too_many_cards":
      return t("deckField.deck_too_many_cards", { count: problem.count, max: MAX_DECK_CARDS });
    case "card_empty":
      return t("deckField.card_empty", { position: problem.position });
    case "card_invalid":
      return t("deckField.card_invalid", { position: problem.position });
    case "card_too_long":
      return t("deckField.card_too_long", { card: problem.card, max: MAX_CARD_LENGTH });
    case "card_special":
      return t("deckField.card_special", { card: problem.card });
    case "card_duplicate":
      return problem.other === problem.card
        ? t("deckField.card_duplicate", { card: problem.card })
        : t("deckField.card_same_value", { card: problem.card, other: problem.other });
  }
}

/**
 * A number typed in a range input, with "," or "." as the decimal mark (they are numbers,
 * not labels): "0,5", "0.5", " 2 ", "-1", ".5". Null when it is not one.
 */
export function parseDecimal(text: string): number | null {
  const plain = text.trim().replace(",", ".");
  return /^-?(?:\d+(?:\.\d*)?|\.\d+)$/.test(plain) ? Number(plain) : null;
}

export interface RangeInput {
  start: string;
  end: string;
  step: string;
}

/** The range's cards, or why there are none. A field that holds no number is not finite. */
export function rangeCards(
  input: RangeInput,
): { ok: true; cards: Card[] } | { ok: false; code: RangeErrorCode } {
  const start = parseDecimal(input.start);
  const end = parseDecimal(input.end);
  const step = parseDecimal(input.step);
  if (start === null || end === null || step === null) {
    return { ok: false, code: "range_not_finite" };
  }
  return generateRange({ start, end, step });
}

/** A range problem in plain words. */
export function rangeProblemMessage(t: TFunction, code: RangeErrorCode): string {
  switch (code) {
    case "range_not_finite":
      return t("deckField.range_not_finite");
    case "range_step_not_positive":
      return t("deckField.range_step_not_positive");
    case "range_end_before_start":
      return t("deckField.range_end_before_start");
    case "range_too_many_cards":
      return t("deckField.range_too_many_cards", { max: MAX_DECK_CARDS });
    case "range_label_too_long":
      return t("deckField.range_label_too_long", { max: MAX_CARD_LENGTH });
  }
}

/** The custom field's text for a list of cards: what the PO would type. */
export const cardsText = (cards: readonly string[]) => cards.join(", ");
