import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SlotCard } from "./cards.tsx";
import {
  DEAL_MS,
  DEAL_STAGGER_MS,
  dealIn,
  FADE_AWAY_MS,
  FLIP_MS,
  fadeAway,
  REDUCED_FADE_MS,
  turnUp,
} from "./reveal-motion.ts";
import { TableStage } from "./table-stage.tsx";

// The reveal's motion (#19; docs/03-design-brief.md, "Motion spec"): a 650 ms turn,
// 90 ms apart in seat order from the viewer; after an anonymous reveal the seats' cards
// shrink to 0.6 and fade in 350 ms while the row deals in 70 ms apart; under reduced
// motion a 120 ms cross-fade and no travel.

const transforms = (keyframes: Keyframe[]) => keyframes.map((k) => k.transform);

describe("turnUp", () => {
  it("turns the face to its edge with the back over it, then back bare", () => {
    const { face, cover } = turnUp(180, false, 216);
    expect(face?.timing).toMatchObject({ duration: FLIP_MS, delay: 180, fill: "backwards" });
    expect(transforms(face?.keyframes ?? [])).toEqual([
      "perspective(216px) rotateY(0deg)",
      "perspective(216px) rotateY(90deg)",
      "perspective(216px) rotateY(-90deg)",
      "perspective(216px) rotateY(0deg)",
    ]);
    // The back hides the face until the card is edge-on, on the same eased timeline.
    expect(cover.timing).toEqual(face?.timing);
    expect(cover.keyframes.map((k) => [k.offset, k.opacity])).toEqual([
      [0, 1],
      [0.5, 1],
      [0.5, 0],
      [1, 0],
    ]);
  });

  it("cross-fades under reduced motion: nothing turns and nothing waits", () => {
    const { face, cover } = turnUp(630, true, 216);
    expect(face).toBeNull();
    expect(cover.timing).toEqual({ duration: REDUCED_FADE_MS, fill: "backwards" });
    expect(JSON.stringify(cover.keyframes)).not.toMatch(/rotate|transform/);
  });
});

describe("the anonymous reveal", () => {
  it("shrinks a seat's card to 0.6 as it fades, or only fades", () => {
    expect(fadeAway(false)).toMatchObject({
      keyframes: [
        { opacity: 1, transform: "scale(1)" },
        { opacity: 0, transform: "scale(0.6)" },
      ],
      timing: { duration: FADE_AWAY_MS },
    });
    expect(fadeAway(true).keyframes).toEqual([{ opacity: 1 }, { opacity: 0 }]);
  });

  it("deals the row 70 ms apart once the seats' cards have gone, or fades it in at once", () => {
    expect(dealIn(0, false).timing).toMatchObject({ duration: DEAL_MS, delay: FADE_AWAY_MS });
    expect(dealIn(3, false).timing.delay).toBe(FADE_AWAY_MS + 3 * DEAL_STAGGER_MS);
    expect(dealIn(3, true)).toEqual({
      keyframes: [{ opacity: 0 }, { opacity: 1 }],
      timing: { duration: REDUCED_FADE_MS, fill: "backwards" },
    });
  });
});

describe("SlotCard and the table at a reveal", () => {
  const animate = vi.fn();
  const cancel = vi.fn();
  const SIZE = { width: 36, height: 50 };

  beforeEach(() => {
    animate.mockImplementation(() => ({ cancel }));
    Element.prototype.animate = animate as unknown as Element["animate"];
  });
  afterEach(() => {
    cleanup();
    animate.mockReset();
    cancel.mockReset();
    Reflect.deleteProperty(Element.prototype, "animate");
    vi.restoreAllMocks();
  });

  /** The elements animated, by what they are, with their delays. */
  const calls = () =>
    animate.mock.calls.map(([keyframes, timing], i) => {
      const element = animate.mock.contexts[i] as HTMLElement;
      return {
        what: element.hasAttribute("data-cover") ? "cover" : element.dataset.face,
        turns: JSON.stringify(keyframes).includes("rotateY"),
        delay: (timing as KeyframeAnimationOptions).delay ?? 0,
      };
    });

  it("keeps the back mounted over a face-up card, hidden at rest", () => {
    render(<SlotCard face="up" value="8" size={SIZE} />);
    const face = document.querySelector("[data-face='up']");
    expect(face?.querySelector("[data-card-value]")?.textContent).toBe("8");
    expect(face?.querySelector("[data-cover] .pp-card-back")).not.toBeNull();
    expect(face?.querySelector<HTMLElement>("[data-cover]")?.className).toContain("opacity-0");
    // Mounted face up (a reload, a late joiner): no motion.
    expect(animate).not.toHaveBeenCalled();
  });

  it("turns a card seen face down, and cancels the turn when the face changes again", () => {
    const { rerender } = render(<SlotCard face="down" size={SIZE} />);
    rerender(<SlotCard face="up" value="8" size={SIZE} turnDelay={90} />);
    expect(calls()).toEqual([
      { what: "up", turns: true, delay: 90 },
      { what: "cover", turns: false, delay: 90 },
    ]);
    rerender(<SlotCard face="empty" size={SIZE} />);
    expect(cancel).toHaveBeenCalledTimes(2);
  });

  it("turns the last vote's card from an empty slot, its back showing while it waits", () => {
    // The last vote came with the reveal: on this screen the slot was still empty.
    const { rerender } = render(<SlotCard face="empty" size={SIZE} />);
    rerender(<SlotCard face="up" value="8" size={SIZE} turnDelay={180} />);
    expect(calls()).toEqual([
      { what: "up", turns: true, delay: 180 },
      { what: "cover", turns: false, delay: 180 },
    ]);
    // `fill: backwards`: during the delay the first keyframe holds, the back drawn over.
    const [, timing] = animate.mock.calls[1] ?? [];
    expect((timing as KeyframeAnimationOptions).fill).toBe("backwards");
    expect(JSON.stringify(animate.mock.calls[1]?.[0])).toMatch(/^\[\{"offset":0,"opacity":1\}/);
    // An empty slot that stays empty, or is gone (anonymous), has nothing to move.
    animate.mockClear();
    rerender(<SlotCard face="empty" size={SIZE} />);
    rerender(<SlotCard face="gone" size={SIZE} />);
    expect(animate).not.toHaveBeenCalled();
  });

  it("only fades the back off the face under reduced motion", () => {
    vi.spyOn(window, "matchMedia").mockImplementation(
      (query) => ({ matches: query.includes("reduce"), media: query }) as MediaQueryList,
    );
    const { rerender } = render(<SlotCard face="down" size={SIZE} />);
    rerender(<SlotCard face="up" value="8" size={SIZE} turnDelay={90} />);
    expect(calls()).toEqual([{ what: "cover", turns: false, delay: 0 }]);
  });

  it("lets an anonymous round's card go from its seat", () => {
    const { rerender } = render(<SlotCard face="down" size={SIZE} />);
    rerender(<SlotCard face="gone" size={SIZE} />);
    expect(document.querySelector("[data-face='gone']")).not.toBeNull();
    expect(calls()).toEqual([{ what: "cover", turns: false, delay: 0 }]);
  });

  it("turns the cards 90 ms apart in seat order from the viewer, skipping empty seats", () => {
    // Ana never votes; Cy's vote is the last one, which arrives with the reveal.
    const before = { me: "voted", ana: "thinking", ben: "voted", cy: "thinking" } as const;
    const people = (revealed: boolean) =>
      (["me", "ana", "ben", "cy"] as const).map((id, i) => ({
        id,
        name: id,
        status: !revealed
          ? ({ kind: before[id] } as const)
          : ({ kind: "revealed", card: id === "ana" ? null : String(i + 1) } as const),
      }));
    const { rerender } = render(<TableStage people={people(false)} variant="desktop" />);
    rerender(<TableStage people={people(true)} variant="desktop" />);
    const turned = animate.mock.contexts
      .map((element, i) => ({ element: element as HTMLElement, i }))
      .filter(({ element }) => element.dataset.face === "up")
      .map(({ element, i }) => ({
        value: element.querySelector("[data-card-value]")?.textContent,
        delay: (animate.mock.calls[i]?.[1] as KeyframeAnimationOptions).delay,
      }));
    expect(turned).toEqual([
      { value: "1", delay: 0 },
      { value: "3", delay: 90 },
      { value: "4", delay: 180 },
    ]);
  });
});
