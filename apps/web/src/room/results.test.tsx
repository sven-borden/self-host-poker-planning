import {
  apply,
  type Command,
  computeResults,
  createRoom,
  PRESET_DECK_IDS,
  type PresetDeckId,
  type RoomState,
} from "@pp/domain";
import { type RoomView, toSnapshot } from "@pp/protocol";
import { act, cleanup, render, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { formatNumber } from "../i18n/format.ts";
import { changeLanguage, fixedT, loadLanguage } from "../i18n/i18n.ts";
import { CentreResult, ResultsPanel } from "./results.tsx";
import {
  CONSENSUS_POP_MS,
  CONSENSUS_PULSE_MS,
  consensusPop,
  consensusPulse,
  RISE_MS,
  RISE_STAGGER_MS,
  riseBar,
  riseLabel,
  showAt,
} from "./results-motion.ts";
import {
  type RevealedRound,
  resultsModel,
  revealSummary,
  summarySentence,
} from "./results-view.ts";
import { RevealedCards } from "./revealed-cards.tsx";

// The results (#20) against the domain: for every built-in deck, the numbers the panel
// and the centre show are `computeResults` for the same votes, formatted (AC 1); a deck
// without numbers shows no average (AC 2); the panel reads as real text, and the centre
// says its result in a sentence (AC 3). Anonymous rounds name nobody.

/** The cards played in each deck's round, a special among them where the deck allows. */
const PLAYS: Record<PresetDeckId, string[]> = {
  fib: ["1", "2", "3", "5", "5", "8", "?"],
  mfib: ["½", "1", "2", "3", "3", "13", "☕"],
  tshirt: ["S", "M", "M", "L", "XL", "?"],
  pow2: ["1", "4", "4", "8", "32"],
  seq: ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "?"],
};

/** A revealed round where person `pN` played `cards[N]`, as `viewer` sees it. */
function revealed(
  deck: PresetDeckId,
  cards: readonly string[],
  { anonymous = false, viewer = "p0" } = {},
): RoomView {
  let state: RoomState = createRoom({ ownerId: "p0" });
  const run = (actor: string, command: Command) => {
    const result = apply(state, command, { actor, now: 100 });
    if (!result.ok) throw new Error(`${command.type}: ${result.error}`);
    state = result.state;
  };
  cards.forEach((_, i) => {
    run(`p${i}`, { type: "join", name: `Person ${i}`, role: "voter" });
  });
  run("p0", {
    type: "updateSettings",
    patch: {
      deck: { kind: "preset", id: deck },
      revealNames: !anonymous,
      revealWhenAllVoted: false,
    },
  });
  run("p0", { type: "startRound", subject: { kind: "none" } });
  cards.forEach((card, i) => {
    run(`p${i}`, { type: "castVote", card });
  });
  run("p0", { type: "reveal" });
  return toSnapshot(state, viewer, { code: "abcdefghij", version: 2, now: 100 }).room;
}

const AT_REST = { live: false, settle: 0 };

function panel(room: RoomView, title = "Results") {
  const { container } = render(<ResultsPanel room={room} motion={AT_REST} />);
  const region = within(container).getByRole("region", { name: title });
  const stat = (key: string) => region.querySelector(`[data-stat='${key}'] dd`);
  const spoken = (list: string) =>
    Array.from(
      within(region).getByRole("list", { name: list }).querySelectorAll(":scope > li > .sr-only"),
      (item) => item.textContent,
    );
  return { region, stat, spoken };
}

const one = (value: number) => formatNumber(value, "en-US", { maximumFractionDigits: 1 });
const percent = (value: number) =>
  formatNumber(value, "en-US", { style: "percent", maximumFractionDigits: 0 });
const votes = (count: number) => (count === 1 ? "1 vote" : `${count} votes`);
const SPOKEN: Record<string, string> = { "?": "unsure", "☕": "needs a break" };

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(Element.prototype, "animate");
});

describe("the results panel shows computeResults for every built-in deck (AC 1, AC 2)", () => {
  it.each(PRESET_DECK_IDS)("%s", (deck) => {
    const cards = PLAYS[deck];
    const expected = computeResults(cards, { kind: "preset", id: deck });
    const room = revealed(deck, cards);
    // The server sent the domain's results for these votes.
    if (room.round?.phase !== "revealed") throw new Error("revealed round expected");
    expect(room.round.results).toEqual(expected);

    const { region, stat, spoken } = panel(room);
    if (deck === "tshirt") {
      // No average and no median for T-shirt sizes (AC 2).
      expect(stat("average")).toBeNull();
      expect(stat("median")).toBeNull();
      expect(region.textContent).not.toMatch(/Average|Median/);
      expect(stat("mostVoted")?.textContent).toBe(expected.mode);
    } else {
      expect(stat("average")?.textContent).toBe(one(expected.average ?? Number.NaN));
      expect(stat("median")?.textContent).toBe(one(expected.median ?? Number.NaN));
      expect(stat("mostVoted")).toBeNull();
    }
    expect(stat("agreement")?.textContent).toBe(percent(expected.agreement));
    const [low, high] = expected.spread ?? ["", ""];
    expect(stat("spread")?.querySelector("[aria-hidden]")?.textContent).toBe(`${low}–${high}`);
    expect(stat("spread")?.querySelector(".sr-only")?.textContent).toBe(`${low} to ${high}`);

    // The distribution: a column per counted card in deck order, then the specials.
    const counted = new Set(expected.core);
    const columns = expected.distribution.filter(({ card }) => counted.has(card));
    expect(spoken("Votes per card").map((text) => text?.split(",")[0])).toEqual(
      columns.map(({ card, count }) => `${card}: ${votes(count)}`),
    );
    const specials = expected.distribution.filter(({ card }) => !counted.has(card));
    if (specials.length > 0) {
      expect(spoken("Not counted")).toEqual(
        specials.map(({ card, count }) => `${SPOKEN[card] ?? card}: ${votes(count)}`),
      );
      expect(region.textContent).toContain("Special cards don’t count toward these numbers.");
    }
    // The lowest and highest voters, by name: a named round whose cards differ.
    const lowest = cards.flatMap((card, i) => (card === low ? [`Person ${i}`] : []));
    expect(spoken("Lowest and highest cards")[0]).toMatch(
      new RegExp(`^Lowest card ${low}: ${lowest.join(" and ")}$`),
    );
  });

  it.each(PRESET_DECK_IDS)("%s, in the centre", (deck) => {
    const cards = PLAYS[deck];
    const expected = computeResults(cards, { kind: "preset", id: deck });
    const { container } = render(
      <CentreResult room={revealed(deck, cards)} compact={false} motion={AT_REST} />,
    );
    const sentence = container.querySelector(".sr-only")?.textContent;
    const word = deck === "tshirt" ? "Most voted" : "Suggested";
    expect(sentence).toBe(
      `${word} ${expected.suggested}. Agreement ${percent(expected.agreement)}.`,
    );
    expect(container.querySelector("[data-mini-card]")?.textContent).toBe(expected.suggested);
  });
});

describe("the results' edge cases", () => {
  it("says a consensus with a pill, and the spread as one card", () => {
    const room = revealed("fib", ["8", "8", "8"]);
    const { container } = render(<CentreResult room={room} compact motion={AT_REST} />);
    expect(
      container.querySelector("[data-centre-result]")?.getAttribute("data-centre-result"),
    ).toBe("consensus");
    expect(container.querySelector(".sr-only")?.textContent).toBe("Consensus on 8.");
    expect(container.querySelector("[data-pop]")?.textContent).toBe("Consensus");
    cleanup();
    const { stat, region } = panel(room);
    expect(stat("spread")?.textContent).toBe("8");
    expect(stat("agreement")?.textContent).toBe("100%");
    // Everyone agrees: nobody is lowest or highest.
    expect(region.querySelector("[data-extremes], [data-extreme]")).toBeNull();
  });

  it("counts nothing when everyone is unsure: no numbers, the cards listed", () => {
    const room = revealed("fib", ["?", "?", "☕"]);
    const { stat, spoken, region } = panel(room);
    for (const key of ["average", "median", "agreement", "spread"]) {
      expect(stat(key)?.querySelector("[aria-hidden]")?.textContent).toBe("—");
      expect(stat(key)?.querySelector(".sr-only")?.textContent).toBe("no value");
    }
    expect(region.querySelector("[data-distribution]")).toBeNull();
    expect(spoken("Not counted")).toEqual(["unsure: 2 votes", "needs a break: 1 vote"]);
    cleanup();
    const { container } = render(<CentreResult room={room} compact={false} motion={AT_REST} />);
    expect(container.textContent).toBe("Nothing to count.");
  });

  it("shows a single vote as it is, with nobody lowest or highest", () => {
    const { stat, spoken, region } = panel(revealed("fib", ["5", "?"]));
    expect(
      [stat("average"), stat("median"), stat("agreement"), stat("spread")].map(
        (d) => d?.textContent,
      ),
    ).toEqual(["5", "5", "100%", "5"]);
    expect(spoken("Votes per card")).toEqual(["5: 1 vote"]);
    expect(region.querySelector("[data-extremes]")).toBeNull();
  });

  it("names every card of a tie for most voted", () => {
    const { stat } = panel(revealed("tshirt", ["M", "L", "M", "L"]));
    expect(stat("mostVoted")?.querySelector("[aria-hidden]")?.textContent).toBe("M · L");
    expect(stat("mostVoted")?.querySelector(".sr-only")?.textContent).toBe("M and L");
    expect(stat("agreement")?.textContent).toBe("50%");
  });

  it("labels the centre's figure as the team's agreement, even for a card nobody played", () => {
    // 3, 3 and 13: the average 6.3 is nearest 5, which nobody played; 67% is how much the
    // team agrees (two of three on 3), not support for 5.
    const room = revealed("fib", ["3", "3", "13"]);
    const { container } = render(<CentreResult room={room} compact={false} motion={AT_REST} />);
    expect(
      container.querySelector("[data-centre-result]")?.getAttribute("data-centre-result"),
    ).toBe("suggested");
    expect(container.querySelector("[data-mini-card]")?.textContent).toBe("5");
    expect(container.querySelector("[data-centre-caption]")?.textContent).toBe("Agreement 67%");
    expect(container.querySelector(".sr-only")?.textContent).toBe("Suggested 5. Agreement 67%.");
  });

  it("names a tie for most voted in the centre, as the panel does", () => {
    const room = revealed("tshirt", ["M", "L", "M", "L"]);
    const { container } = render(<CentreResult room={room} compact motion={AT_REST} />);
    expect(
      container.querySelector("[data-centre-result]")?.getAttribute("data-centre-result"),
    ).toBe("tie");
    expect(
      Array.from(container.querySelectorAll("[data-mini-card]"), (card) => card.textContent),
    ).toEqual(["M", "L"]);
    expect(container.querySelector("[data-centre-caption]")?.textContent).toBe("Tie");
    expect(container.querySelector(".sr-only")?.textContent).toBe(
      "Tie between M and L. Agreement 50%.",
    );
  });

  it("says the tie and the suggestion in French and German", async () => {
    await Promise.all([loadLanguage("fr"), loadLanguage("de")]);
    const round = (room: RoomView) => room.round as RevealedRound;
    const tie = revealSummary(round(revealed("tshirt", ["XS", "M", "XS", "M", "L", "L"])));
    const suggested = revealSummary(round(revealed("fib", ["3", "3", "13"])));
    const pct = (value: number, locale: string) =>
      formatNumber(value, locale, { style: "percent", maximumFractionDigits: 0 });
    expect(summarySentence(fixedT("fr"), tie)).toBe(
      `Égalité entre XS, M et L. Accord : ${pct(1 / 3, "fr")}.`,
    );
    expect(summarySentence(fixedT("de"), tie)).toBe(
      `Gleichstand zwischen XS, M und L. Einigkeit: ${pct(1 / 3, "de")}.`,
    );
    expect(summarySentence(fixedT("fr"), suggested)).toBe(
      `Carte suggérée : 5. Accord : ${pct(2 / 3, "fr")}.`,
    );
    expect(summarySentence(fixedT("de"), suggested)).toBe(
      `Vorschlag: 5. Einigkeit: ${pct(2 / 3, "de")}.`,
    );
  });

  it("suggests a card on a numeric deck even when most voted is a tie", () => {
    const summary = revealSummary(revealed("fib", ["3", "3", "8", "8"]).round as RevealedRound);
    expect(summary).toEqual({ kind: "suggested", card: "5", agreement: 0.5, mostVoted: false });
  });

  it("marks the lowest or highest card of a vote not at the table, as on a seat", () => {
    const room = revealed("fib", ["1", "5", "8"]);
    // Person 0 played the lowest card, then switched to observer after the reveal.
    const moved = {
      ...room,
      participants: room.participants.map((p) =>
        p.id === "p0" ? { ...p, role: "observer" as const } : p,
      ),
    };
    const { container } = render(<RevealedCards room={moved} />);
    const item = container.querySelector("[data-off-table]");
    expect(item?.getAttribute("data-extreme")).toBe("low");
    expect(item?.querySelector("[data-badge='lowest']")).not.toBeNull();
    expect(item?.querySelector(".sr-only")?.textContent).toMatch(/^Person 0, .*1, lowest card$/);
  });

  it("formats the numbers in the reader's language", async () => {
    await loadLanguage("fr");
    await act(() => changeLanguage("fr"));
    try {
      const { stat } = panel(revealed("fib", ["3", "5", "8"]), "Résultats");
      // "5,3" and "33 %", with the space French puts before the sign.
      expect(stat("average")?.textContent).toBe("5,3");
      expect(stat("agreement")?.textContent).toBe(
        formatNumber(1 / 3, "fr", { style: "percent", maximumFractionDigits: 0 }),
      );
      expect(stat("agreement")?.textContent).toMatch(/^33\s%$/u);
      expect(stat("spread")?.querySelector(".sr-only")?.textContent).toBe("3 à 8");
    } finally {
      await act(() => changeLanguage("en"));
    }
  });
});

describe("an anonymous round's results", () => {
  it("show the same numbers and name nobody", () => {
    const cards = PLAYS.fib;
    const room = revealed("fib", cards, { anonymous: true, viewer: "p3" });
    const named = resultsModel(revealed("fib", cards));
    const model = resultsModel(room);
    expect(model?.columns).toEqual(named?.columns.map(({ card, count }) => ({ card, count })));
    expect(model?.extremes).toEqual([]);
    const { region } = panel(room);
    expect(region.getAttribute("data-results-panel")).toBe("anonymous");
    const html = region.outerHTML;
    for (const leak of ["Person", "p3", "data-extreme", "data-badge", "Lowest", "Highest"]) {
      expect(html).not.toContain(leak);
    }
  });
});

describe("the results' motion", () => {
  it("raises the columns 500 ms long, 60 ms apart, from when the cards are settled", () => {
    expect(riseBar(0, 1280, false).timing).toMatchObject({ duration: RISE_MS, delay: 1280 });
    expect(riseBar(3, 1280, false).timing.delay).toBe(1280 + 3 * RISE_STAGGER_MS);
    expect(riseBar(3, 1280, false).keyframes[0]).toEqual({ transform: "scaleY(0)" });
    expect(riseLabel(2, 350, false).timing.delay).toBe(350 + 2 * RISE_STAGGER_MS);
    expect(consensusPop(900, false).timing).toMatchObject({
      duration: CONSENSUS_POP_MS,
      delay: 900,
    });
    expect(consensusPulse(900, false)?.timing).toMatchObject({
      duration: CONSENSUS_PULSE_MS,
      delay: 900 + CONSENSUS_POP_MS,
    });
  });

  it("cross-fades in 120 ms at once under reduced motion, and never pulses", () => {
    const fade = {
      keyframes: [{ opacity: 0 }, { opacity: 1 }],
      timing: { duration: 120, fill: "backwards" },
    };
    for (const motion of [
      riseBar(3, 900, true),
      riseLabel(3, 900, true),
      showAt(900, true),
      consensusPop(900, true),
    ]) {
      expect(motion).toEqual(fade);
    }
    expect(consensusPulse(900, true)).toBeNull();
  });

  it("plays only when the reveal happens on screen, starting when the cards are settled", () => {
    const animate = vi.fn(() => ({ cancel: vi.fn() }));
    Element.prototype.animate = animate as unknown as Element["animate"];
    const room = revealed("fib", ["3", "5", "5", "8"]);
    render(<ResultsPanel room={room} motion={AT_REST} />);
    expect(animate).not.toHaveBeenCalled();
    cleanup();
    render(<ResultsPanel room={room} motion={{ live: true, settle: 920 }} />);
    const delays = animate.mock.calls.map((call) => (call as unknown[])[1] as { delay?: number });
    // Three columns rise, bar and count, 60 ms apart after 920 ms.
    expect(delays.filter((timing) => timing.delay !== 920).map((timing) => timing.delay)).toEqual([
      980, 980, 1040, 1040,
    ]);
    expect(delays.every((timing) => (timing.delay ?? 0) >= 920)).toBe(true);
  });
});
