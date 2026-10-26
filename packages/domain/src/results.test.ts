import { describe, expect, it } from "vitest";
import type { Card, DeckSpec } from "./decks.ts";
import { computeResults, type Results } from "./results.ts";

const fib: DeckSpec = { kind: "preset", id: "fib" };
const mfib: DeckSpec = { kind: "preset", id: "mfib" };
const tshirt: DeckSpec = { kind: "preset", id: "tshirt" };
const custom = (...cards: Card[]): DeckSpec => ({ kind: "custom", cards });

const none: Results = {
  distribution: [],
  core: [],
  mode: null,
  agreement: 0,
  spread: null,
  consensus: false,
  average: null,
  median: null,
  suggested: null,
};

describe("computeResults", () => {
  it.each<[string, Card[], DeckSpec, Results]>([
    ["no votes", [], fib, none],
    ["no votes on a T-shirt deck", [], tshirt, none],
    [
      "only special cards",
      ["?", "☕", "?", "∞"],
      fib,
      {
        ...none,
        distribution: [
          { card: "?", count: 2 },
          { card: "☕", count: 1 },
          { card: "∞", count: 1 },
        ],
      },
    ],
    [
      "the prototype's mixed round",
      ["8", "5", "?", "3", "5"],
      fib,
      {
        distribution: [
          { card: "3", count: 1 },
          { card: "5", count: 2 },
          { card: "8", count: 1 },
          { card: "?", count: 1 },
        ],
        core: ["3", "5", "5", "8"],
        mode: "5",
        agreement: 0.5,
        spread: ["3", "8"],
        consensus: false,
        average: 5.25,
        median: 5,
        suggested: "5",
      },
    ],
    [
      "a tie for the mode goes to the earlier card, a tie for the suggestion to the lower",
      ["5", "3", "5", "3"],
      fib,
      {
        distribution: [
          { card: "3", count: 2 },
          { card: "5", count: 2 },
        ],
        core: ["3", "3", "5", "5"],
        mode: "3",
        agreement: 0.5,
        spread: ["3", "5"],
        consensus: false,
        average: 4,
        median: 4,
        suggested: "3",
      },
    ],
    [
      "half",
      ["½", "1", "½"],
      mfib,
      {
        distribution: [
          { card: "½", count: 2 },
          { card: "1", count: 1 },
        ],
        core: ["½", "½", "1"],
        mode: "½",
        agreement: 2 / 3,
        spread: ["½", "1"],
        consensus: false,
        average: 2 / 3,
        median: 0.5,
        suggested: "½",
      },
    ],
    [
      "decimals",
      ["1.5", "0.5", "2"],
      custom("0", "0.5", "1", "1.5", "2"),
      {
        distribution: [
          { card: "0.5", count: 1 },
          { card: "1.5", count: 1 },
          { card: "2", count: 1 },
        ],
        core: ["0.5", "1.5", "2"],
        mode: "0.5",
        agreement: 1 / 3,
        spread: ["0.5", "2"],
        consensus: false,
        average: 4 / 3,
        median: 1.5,
        suggested: "1.5",
      },
    ],
    [
      "T-shirt: no average or median, the suggestion is the mode",
      ["M", "L", "M", "XS", "☕"],
      tshirt,
      {
        distribution: [
          { card: "XS", count: 1 },
          { card: "M", count: 2 },
          { card: "L", count: 1 },
          { card: "☕", count: 1 },
        ],
        core: ["XS", "M", "M", "L"],
        mode: "M",
        agreement: 0.5,
        spread: ["XS", "L"],
        consensus: false,
        average: null,
        median: null,
        suggested: "M",
      },
    ],
    [
      "spread follows the deck, not string order",
      ["13", "2", "8"],
      fib,
      {
        distribution: [
          { card: "2", count: 1 },
          { card: "8", count: 1 },
          { card: "13", count: 1 },
        ],
        core: ["2", "8", "13"],
        mode: "2",
        agreement: 1 / 3,
        spread: ["2", "13"],
        consensus: false,
        average: 23 / 3,
        median: 8,
        suggested: "8",
      },
    ],
    [
      "an unsorted custom deck: spread by deck order, suggestion tie to the lower value",
      ["2", "1"],
      custom("2", "1"),
      {
        distribution: [
          { card: "2", count: 1 },
          { card: "1", count: 1 },
        ],
        core: ["2", "1"],
        mode: "2",
        agreement: 0.5,
        spread: ["2", "1"],
        consensus: false,
        average: 1.5,
        median: 1.5,
        suggested: "1",
      },
    ],
    [
      "a vote outside the deck shows last in the distribution and counts nowhere",
      ["4", "5"],
      fib,
      {
        distribution: [
          { card: "5", count: 1 },
          { card: "4", count: 1 },
        ],
        core: ["5"],
        mode: "5",
        agreement: 1,
        spread: ["5", "5"],
        consensus: false,
        average: 5,
        median: 5,
        suggested: "5",
      },
    ],
  ])("%s", (_, votes, deck, expected) => {
    expect(computeResults(votes, deck)).toEqual(expected);
  });

  it.each<[Card[], boolean]>([
    [["5"], false],
    [["5", "5"], false],
    [["5", "5", "5"], true],
    [["5", "5", "5", "?", "☕"], true],
    [["5", "5", "8"], false],
    [["5", "5", "?"], false],
  ])("consensus for %j is %s", (votes, consensus) => {
    expect(computeResults(votes, fib).consensus).toBe(consensus);
  });

  it.each<[Card[], number]>([
    [["1", "2", "8"], 2],
    [["1", "2", "3", "5"], 2.5],
    [["21"], 21],
  ])("median of %j is %s", (votes, median) => {
    expect(computeResults(votes, fib).median).toBe(median);
  });

  it.each<[DeckSpec, Card[], Card]>([
    [fib, ["1", "2"], "1"],
    [fib, ["8", "13", "21"], "13"],
    [fib, ["0", "21"], "8"],
    [mfib, ["20", "40"], "20"],
    [custom("0.1", "0.2", "0.3"), ["0.1", "0.2"], "0.1"],
    [custom("8", "1", "3"), ["8", "1"], "3"],
  ])("on %j the suggestion for %j is %s", (deck, votes, suggested) => {
    expect(computeResults(votes, deck).suggested).toBe(suggested);
  });

  it("counts a duplicate label in a stored custom deck once", () => {
    const results = computeResults(["3", "3"], custom("3", "5", "3"));
    expect(results.core).toEqual(["3", "3"]);
    expect(results.distribution).toEqual([{ card: "3", count: 2 }]);
  });
});
