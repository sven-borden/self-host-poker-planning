import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SlotCard } from "./cards.tsx";
import { DROP_MS, landDown, POP_MS, REDUCED_FADE_MS } from "./reveal-motion.ts";
import { SEAT_MS, seatGlide, seatIn, seatOut } from "./seat-motion.ts";
import { TableStage } from "./table-stage.tsx";

// A table that changes hands (#43; docs/03-design-brief.md, "Motion spec"): a seat and its
// slot fade and scale from 0.9 in 220 ms, the others glide to their new places, and whoever
// leaves fades out on the stage as they looked. A vote lands: the card drops on the slot,
// the check pops. Under reduced motion only cross-fades, nothing glides.

describe("the keyframes", () => {
  it("fades a seat in and out, scaled from 0.9", () => {
    expect(seatIn(false)).toMatchObject({
      keyframes: [
        { opacity: 0, scale: "0.9" },
        { opacity: 1, scale: "1" },
      ],
      timing: { duration: SEAT_MS, fill: "backwards" },
    });
    expect(seatOut(false)).toMatchObject({
      keyframes: [
        { opacity: 1, scale: "1" },
        { opacity: 0, scale: "0.9" },
      ],
      timing: { duration: SEAT_MS, fill: "forwards" },
    });
    expect(seatIn(true).timing.duration).toBe(REDUCED_FADE_MS);
    expect(JSON.stringify(seatIn(true))).not.toContain("scale");
    expect(JSON.stringify(seatOut(true))).not.toContain("scale");
  });

  it("adds a glide to the one under way, so a change in mid-glide never jumps", () => {
    expect(seatGlide(12, -4)).toMatchObject({
      keyframes: [{ translate: "12px -4px" }, { translate: "0px 0px" }],
      timing: { duration: SEAT_MS, composite: "add" },
    });
  });

  it("drops a card on its slot, or fades it in", () => {
    expect(landDown(false).timing.duration).toBe(DROP_MS);
    expect(JSON.stringify(landDown(false).keyframes)).toContain("translateY(-10px)");
    expect(landDown(true)).toEqual({
      keyframes: [{ opacity: 0 }, { opacity: 1 }],
      timing: { duration: REDUCED_FADE_MS, fill: "backwards" },
    });
  });
});

describe("on the table", () => {
  const animate = vi.fn();
  const SIZE = { width: 36, height: 50 };
  const person = (id: string, kind: "thinking" | "voted" = "thinking") => ({
    id,
    name: id,
    status: { kind } as const,
  });
  const table = (...ids: string[]) => (
    <TableStage people={ids.map((id) => person(id))} variant="desktop" />
  );
  const played = () =>
    animate.mock.calls.map(([keyframes], i) => ({
      element: animate.mock.contexts[i] as HTMLElement,
      keyframes: JSON.stringify(keyframes),
    }));
  const seatOf = (id: string) => document.querySelector(`[data-seat][data-person="${id}"]`);
  const slotOf = (id: string) => document.querySelector(`[data-slot-card][data-person="${id}"]`);

  beforeEach(() => {
    animate.mockImplementation(() => ({ cancel: vi.fn() }));
    Element.prototype.animate = animate as unknown as Element["animate"];
  });
  afterEach(() => {
    cleanup();
    animate.mockReset();
    Reflect.deleteProperty(Element.prototype, "animate");
    vi.restoreAllMocks();
  });

  it("shows the first people drawn at rest", () => {
    render(table("me", "ana", "ben"));
    expect(animate).not.toHaveBeenCalled();
  });

  it("fades a newcomer in, seat and slot, and glides the others to their new places", () => {
    // jsdom has no layout: the stage needs a size for a move in percent to be one in pixels.
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(800);
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(600);
    const { rerender } = render(table("me", "ana"));
    rerender(table("me", "ana", "ben"));
    const fades = played().filter((call) => call.keyframes.includes("scale"));
    expect(new Set(fades.map((call) => call.element))).toEqual(
      new Set([seatOf("ben"), slotOf("ben")]),
    );
    const glides = played().filter((call) => call.keyframes.includes("translate"));
    expect(glides.length).toBeGreaterThan(0);
    for (const { element } of glides) {
      expect(element.getAttribute("data-person")).not.toBe("ben");
    }
  });

  it("keeps someone who left on the stage, unmarked and out of reach, until they have faded", () => {
    const { rerender } = render(table("me", "ana", "ben"));
    const seat = seatOf("ben");
    const stage = document.querySelector("[data-stage]");
    rerender(table("me", "ana"));
    expect(seatOf("ben")).toBeNull();
    const out = animate.mock.results[played().findIndex((call) => call.element === seat)]?.value;
    expect(seat?.parentElement).toBe(stage);
    expect(seat?.getAttribute("aria-hidden")).toBe("true");
    expect(seat?.hasAttribute("inert")).toBe(true);
    expect(seat?.querySelector("[data-person-trigger]")).toBeNull();
    expect(document.querySelectorAll("[data-seat]")).toHaveLength(2);
    out.onfinish();
    expect(seat?.isConnected).toBe(false);
  });

  it("removes a departed seat at once when the browser cannot animate it", () => {
    const { rerender } = render(table("me", "ana"));
    const seat = seatOf("ana");
    Reflect.deleteProperty(Element.prototype, "animate");
    rerender(table("me"));
    expect(seat?.isConnected).toBe(false);
  });

  it("only cross-fades under reduced motion: nobody glides", () => {
    vi.spyOn(window, "matchMedia").mockImplementation(
      (query) => ({ matches: query.includes("reduce"), media: query }) as MediaQueryList,
    );
    const { rerender } = render(table("me", "ana"));
    rerender(table("me", "ana", "ben"));
    rerender(table("me", "ben"));
    expect(played().filter((call) => call.keyframes.match(/translate|scale/))).toEqual([]);
    expect(animate).toHaveBeenCalled();
  });

  it("moves nobody when the table is redrawn for another width", () => {
    const { rerender } = render(<TableStage people={[person("me")]} variant="desktop" />);
    rerender(<TableStage people={[person("me"), person("ana")]} variant="phone" />);
    expect(animate).not.toHaveBeenCalled();
  });

  it("pops the check and lands the card when a vote arrives, but not on a reload", () => {
    render(<TableStage people={[person("me", "voted")]} variant="desktop" />);
    expect(animate).not.toHaveBeenCalled();
    cleanup();
    const { rerender } = render(<TableStage people={[person("me")]} variant="desktop" />);
    rerender(<TableStage people={[person("me", "voted")]} variant="desktop" />);
    const check = played().findIndex((call) => call.element.dataset.badge === "voted");
    expect(animate.mock.calls[check]?.[1]).toMatchObject({ duration: POP_MS, delay: 0 });
    expect(played().some((call) => call.element.dataset.face === "down")).toBe(true);
  });

  it("lands only a card that arrives on an empty slot", () => {
    const { rerender } = render(<SlotCard face="empty" size={SIZE} />);
    rerender(<SlotCard face="down" size={SIZE} />);
    expect(animate).toHaveBeenCalledTimes(1);
    animate.mockClear();
    rerender(<SlotCard face="down" size={SIZE} />);
    rerender(<SlotCard face="empty" size={SIZE} />);
    expect(animate).not.toHaveBeenCalled();
  });
});
