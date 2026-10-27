import type { RangeErrorCode } from "@pp/domain";
import { beforeAll, describe, expect, it } from "vitest";
import { fixedT, loadLanguage } from "../i18n/i18n.ts";
import {
  checkCustomDeck,
  type DeckProblem,
  deckProblemMessage,
  parseDecimal,
  rangeCards,
  rangeProblemMessage,
  splitCards,
} from "./deck-editor.ts";

const en = fixedT("en");

/** The problem with `text`, or null when the domain takes it. */
function problem(text: string): DeckProblem | null {
  const check = checkCustomDeck(text);
  return check.ok ? null : check.problem;
}

beforeAll(async () => {
  await loadLanguage("fr");
  await loadLanguage("de");
});

describe("the custom deck field", () => {
  it("splits the cards on commas, trims them, and forgives a trailing comma", () => {
    expect(splitCards(" 1,2 , 3 ")).toEqual(["1", "2", "3"]);
    expect(splitCards("1, 2,")).toEqual(["1", "2"]);
    expect(splitCards("1, , 2")).toEqual(["1", "", "2"]);
    expect(splitCards(" , ")).toEqual([]);
    expect(splitCards("")).toEqual([]);
  });

  it("takes decimals with a point, emoji and labels, as typed (AC 2, AC 3)", () => {
    expect(checkCustomDeck("0.5, 1, 1.5, 2.5")).toEqual({
      ok: true,
      cards: ["0.5", "1", "1.5", "2.5"],
    });
    expect(checkCustomDeck("🐜, 🐈, 🐘")).toEqual({ ok: true, cards: ["🐜", "🐈", "🐘"] });
    expect(checkCustomDeck("1, 2, Big")).toEqual({ ok: true, cards: ["1", "2", "Big"] });
    expect(checkCustomDeck("👍🏽, XXL")).toMatchObject({ ok: true });
  });

  it("finds the card at fault for every code the domain gives", () => {
    expect(problem("")).toEqual({ code: "deck_empty" });
    expect(problem(Array.from({ length: 23 }, (_, i) => i).join(","))).toEqual({
      code: "deck_too_many_cards",
      count: 23,
    });
    expect(problem("1, , 3")).toEqual({ code: "card_empty", position: 2 });
    expect(problem("1, 2, a\u{200b}b")).toEqual({ code: "card_invalid", position: 3 });
    expect(problem("1, Large, Huge")).toEqual({ code: "card_too_long", card: "Large" });
    // With the emoji variation selector, as a phone's keyboard types it.
    expect(problem("1, \u{2615}\u{fe0f}")).toEqual({
      code: "card_special",
      card: "\u{2615}\u{fe0f}",
    });
    expect(problem("1, 2, 1")).toEqual({ code: "card_duplicate", card: "1", other: "1" });
    expect(problem("½, 1, 0.5")).toEqual({ code: "card_duplicate", card: "0.5", other: "½" });
    // The first fault in the order typed, whatever comes after it.
    expect(problem("Large, , ?")).toEqual({ code: "card_too_long", card: "Large" });
  });

  it("explains each problem in plain words, naming the card at fault (AC 1)", () => {
    const say = (text: string) => {
      const found = problem(text);
      if (found === null) throw new Error(`no problem with ${text}`);
      return deckProblemMessage(en, found);
    };
    expect(say("")).toBe("Type at least one card.");
    expect(say(Array.from({ length: 21 }, (_, i) => i).join(","))).toBe(
      "These are 21 cards; a deck holds at most 20.",
    );
    expect(say("1, , 3")).toBe("Card 2 is empty. Remove the extra comma.");
    expect(say("1, a\u{200b}b")).toBe(
      "Card 2 holds characters that cannot be shown. Type it again.",
    );
    expect(say("1, Large")).toBe("“Large” is too long: a card holds at most 4 characters.");
    expect(say("?, 1")).toBe(
      "“?” is a special card. Turn it on under “Special cards” instead of typing it.",
    );
    expect(say("XL, XL")).toBe("“XL” is in the deck twice. Keep one.");
    expect(say("1, 1.0")).toBe("“1.0” has the same value as “1”. Keep one of them.");
  });

  it("explains them in French and German too (AC 1)", () => {
    const tooLong: DeckProblem = { code: "card_too_long", card: "Large" };
    const sameValue: DeckProblem = { code: "card_duplicate", card: "1.0", other: "1" };
    expect(deckProblemMessage(fixedT("fr"), tooLong)).toBe(
      "«\u{202f}Large\u{202f}» est trop long\u{202f}: une carte compte 4 caractères au plus.",
    );
    expect(deckProblemMessage(fixedT("de"), tooLong)).toBe(
      "„Large“ ist zu lang: Eine Karte hat höchstens 4 Zeichen.",
    );
    expect(deckProblemMessage(fixedT("fr"), sameValue)).toBe(
      "«\u{202f}1.0\u{202f}» a la même valeur que «\u{202f}1\u{202f}». Gardez l’une des deux.",
    );
    expect(deckProblemMessage(fixedT("de"), { code: "card_empty", position: 3 })).toBe(
      "Karte 3 ist leer. Entfernen Sie das überzählige Komma.",
    );
    // Every problem has words in every language, none of them the key.
    const all: DeckProblem[] = [
      { code: "deck_empty" },
      { code: "deck_too_many_cards", count: 25 },
      { code: "card_empty", position: 1 },
      { code: "card_invalid", position: 1 },
      tooLong,
      { code: "card_special", card: "∞" },
      { code: "card_duplicate", card: "3", other: "3" },
      sameValue,
    ];
    for (const language of ["en", "fr", "de"] as const) {
      for (const each of all) {
        expect(deckProblemMessage(fixedT(language), each)).not.toMatch(/deckField|\{\{/);
      }
    }
  });
});

describe("the range generator", () => {
  it("reads a comma or a point as the decimal mark", () => {
    expect(parseDecimal("0,5")).toBe(0.5);
    expect(parseDecimal("0.5")).toBe(0.5);
    expect(parseDecimal(" 2 ")).toBe(2);
    expect(parseDecimal("-1")).toBe(-1);
    expect(parseDecimal(",5")).toBe(0.5);
    expect(parseDecimal("1,")).toBe(1);
    for (const junk of ["", "a", "1,5,5", "1.5.5", "1e3", "Infinity", "--1", "1 000"]) {
      expect(parseDecimal(junk)).toBeNull();
    }
  });

  it("fills the cards from start, end and step, typed either way", () => {
    expect(rangeCards({ start: "0", end: "2", step: "0,5" })).toEqual({
      ok: true,
      cards: ["0", "0.5", "1", "1.5", "2"],
    });
    expect(rangeCards({ start: "1.5", end: "3", step: "0.5" })).toEqual({
      ok: true,
      cards: ["1.5", "2", "2.5", "3"],
    });
  });

  it("explains every range code in plain words, in every language", () => {
    const cases: Array<[Record<"start" | "end" | "step", string>, RangeErrorCode, string]> = [
      [
        { start: "a", end: "2", step: "1" },
        "range_not_finite",
        "Type a number in start, end and step, such as 0.5 or 0,5.",
      ],
      [
        { start: "0", end: "2", step: "0" },
        "range_step_not_positive",
        "The step must be more than 0.",
      ],
      [
        { start: "5", end: "2", step: "1" },
        "range_end_before_start",
        "The end must not be smaller than the start.",
      ],
      [
        { start: "0", end: "100", step: "1" },
        "range_too_many_cards",
        "That range gives more than 20 cards. Take a larger step or a shorter range.",
      ],
      [
        { start: "0", end: "1", step: "0.125" },
        "range_label_too_long",
        "Some values would need more than 4 characters, such as 0.125 or 10000. Use fewer decimals or smaller numbers.",
      ],
    ];
    for (const [input, code, words] of cases) {
      expect(rangeCards(input)).toEqual({ ok: false, code });
      expect(rangeProblemMessage(en, code)).toBe(words);
      for (const language of ["fr", "de"] as const) {
        const said = rangeProblemMessage(fixedT(language), code);
        expect(said).not.toBe(words);
        expect(said).not.toMatch(/deckField|\{\{/);
      }
    }
    expect(rangeProblemMessage(fixedT("fr"), "range_label_too_long")).toContain("0,125");
  });
});
