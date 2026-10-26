import { describe, expect, it } from "vitest";
import {
  type Card,
  cardLength,
  cardValue,
  type DeckSpec,
  deckCards,
  isNumericDeck,
  isSpecial,
  PRESET_DECKS,
  type PresetDeckId,
  SPECIAL_CARDS,
  validateCustomDeck,
} from "./decks.ts";

describe("PRESET_DECKS", () => {
  it.each<[PresetDeckId, Card[]]>([
    ["fib", ["0", "1", "2", "3", "5", "8", "13", "21"]],
    ["mfib", ["0", "½", "1", "2", "3", "5", "8", "13", "20", "40", "100"]],
    ["tshirt", ["XS", "S", "M", "L", "XL", "XXL"]],
    ["pow2", ["0", "1", "2", "4", "8", "16", "32", "64"]],
    ["seq", ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10"]],
  ])("%s holds exactly its cards", (id, cards) => {
    expect(PRESET_DECKS[id]).toEqual(cards);
    expect(deckCards({ kind: "preset", id }, [])).toEqual(cards);
  });
});

describe("SPECIAL_CARDS and isSpecial", () => {
  it("lists the specials in display order", () => {
    expect(SPECIAL_CARDS).toEqual(["?", "☕", "∞"]);
  });

  it.each<[string, boolean]>([
    ["?", true],
    ["☕", true],
    ["∞", true],
    ["0", false],
    ["XL", false],
    [" ?", false],
  ])("isSpecial(%j) is %s", (card, expected) => {
    expect(isSpecial(card)).toBe(expected);
  });
});

describe("deckCards", () => {
  const fib: DeckSpec = { kind: "preset", id: "fib" };

  it.each<[Array<"?" | "☕" | "∞">, Card[]]>([
    [[], []],
    [
      ["?", "☕"],
      ["?", "☕"],
    ],
    [
      ["∞", "?"],
      ["?", "∞"],
    ],
    [
      ["∞", "☕", "?"],
      ["?", "☕", "∞"],
    ],
  ])("appends the enabled specials %j in display order", (specials, tail) => {
    expect(deckCards(fib, specials)).toEqual([...PRESET_DECKS.fib, ...tail]);
  });

  it("keeps a custom deck's order and drops specials stored in it", () => {
    expect(deckCards({ kind: "custom", cards: ["8", "?", "1"] }, ["☕"])).toEqual(["8", "1", "☕"]);
  });
});

describe("cardValue", () => {
  it.each<[string, number | null]>([
    ["0", 0],
    ["13", 13],
    ["½", 0.5],
    ["0.5", 0.5],
    ["1.5", 1.5],
    ["-1", -1],
    ["XL", null],
    ["?", null],
    ["☕", null],
    ["∞", null],
    ["1,5", null],
    [".5", null],
    ["1.", null],
    ["", null],
  ])("cardValue(%j) is %s", (card, expected) => {
    expect(cardValue(card)).toBe(expected);
  });
});

describe("isNumericDeck", () => {
  it.each<[DeckSpec, boolean]>([
    [{ kind: "preset", id: "fib" }, true],
    [{ kind: "preset", id: "mfib" }, true],
    [{ kind: "preset", id: "tshirt" }, false],
    [{ kind: "preset", id: "pow2" }, true],
    [{ kind: "preset", id: "seq" }, true],
    [{ kind: "custom", cards: ["0", "0.5", "1"] }, true],
    [{ kind: "custom", cards: ["1", "2", "?"] }, true],
    [{ kind: "custom", cards: ["1", "2", "big"] }, false],
  ])("%j is numeric: %s", (deck, expected) => {
    expect(isNumericDeck(deck)).toBe(expected);
  });
});

describe("cardLength", () => {
  it.each<[string, number]>([
    ["XXL", 3],
    ["☕", 1],
    ["👍🏽", 1],
    ["🇨🇭", 1],
    ["é", 1],
    ["👍🏽👍🏽👍🏽👍🏽", 4],
  ])("%j counts %i user-perceived characters", (label, expected) => {
    expect(cardLength(label)).toBe(expected);
  });

  it("falls back to code points when Intl.Segmenter is missing", () => {
    const intl = Intl as { Segmenter?: unknown };
    const original = intl.Segmenter;
    intl.Segmenter = undefined;
    try {
      expect(cardLength("XXL")).toBe(3);
      expect(cardLength("☕")).toBe(1);
      expect(cardLength("👍🏽")).toBe(2);
    } finally {
      intl.Segmenter = original;
    }
    expect(cardLength("👍🏽")).toBe(1);
  });
});

describe("validateCustomDeck", () => {
  const twenty = Array.from({ length: 20 }, (_, i) => String(i));

  it.each<[string[], Card[]]>([
    [
      [" 1 ", "XL", "☕☕"],
      ["1", "XL", "☕☕"],
    ],
    [twenty, twenty],
    [
      ["👍🏽👍🏽👍🏽👍🏽", "abcd"],
      ["👍🏽👍🏽👍🏽👍🏽", "abcd"],
    ],
    [["é"], ["é"]],
    // Zero-width joiners inside emoji sequences: a family, and a woman technologist.
    [
      ["\u{1F468}‍\u{1F469}‍\u{1F467}", "\u{1F469}\u{1F3FD}‍\u{1F4BB}"],
      ["\u{1F468}‍\u{1F469}‍\u{1F467}", "\u{1F469}\u{1F3FD}‍\u{1F4BB}"],
    ],
  ])("accepts %j", (cards, expected) => {
    expect(validateCustomDeck(cards)).toEqual({ ok: true, cards: expected });
  });

  it.each<[string, string[]]>([
    ["deck_empty", []],
    ["deck_too_many_cards", [...twenty, "20"]],
    ["card_empty", ["1", "  "]],
    ["card_empty", [""]],
    ["card_invalid", ["\u0000"]],
    ["card_invalid", ["1", "a\tb"]],
    ["card_invalid", ["​"]],
    ["card_invalid", ["1​"]],
    ["card_invalid", ["a‍b"]],
    ["card_invalid", ["‍"]],
    ["card_invalid", ["\u{1F44D}‍"]],
    ["card_invalid", ["‍\u{1F44D}"]],
    ["card_special", ["☕️"]],
    ["card_special", ["☕︎"]],
    ["card_special", ["?️"]],
    ["card_too_long", ["12345"]],
    ["card_too_long", ["👍🏽👍🏽👍🏽👍🏽👍🏽"]],
    // One user-perceived character, 65 code units after NFC.
    ["card_too_long", [`a${"́".repeat(65)}`]],
    ["card_duplicate", ["1", " 1"]],
    ["card_duplicate", ["1", "1.0"]],
    ["card_duplicate", ["1", "2", "01"]],
    ["card_duplicate", ["1.50", "1.5"]],
    ["card_duplicate", ["½", "0.5"]],
    ["card_duplicate", ["0.5", "½"]],
    ["card_duplicate", ["-0", "0"]],
    ["card_duplicate", ["0", "-0"]],
    ["card_duplicate", ["é", "é"]],
    ["card_special", ["1", "?"]],
    ["card_special", [" ☕ "]],
    ["card_special", ["∞"]],
  ])("refuses with %s: %j", (code, cards) => {
    expect(validateCustomDeck(cards)).toEqual({ ok: false, code });
  });
});
