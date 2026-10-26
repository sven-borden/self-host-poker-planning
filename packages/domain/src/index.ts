/** A room holds at most this many people, observers included unless the room says otherwise. */
export const MAX_PARTICIPANTS = 16;

export {
  baseCards,
  type Card,
  type CustomDeckErrorCode,
  cardLength,
  cardValue,
  type DeckSpec,
  deckCards,
  isNumericDeck,
  isSpecial,
  MAX_CARD_LENGTH,
  MAX_DECK_CARDS,
  PRESET_DECK_IDS,
  PRESET_DECKS,
  type PresetDeckId,
  SPECIAL_CARDS,
  type SpecialCard,
  validateCustomDeck,
} from "./decks.ts";
export { generateRange, type RangeErrorCode } from "./range.ts";
export { computeResults, type Results } from "./results.ts";
