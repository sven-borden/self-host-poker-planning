import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CardFlight, DROP_MS, type Flight, flightKeyframes, TRAVEL_MS } from "./card-flight.tsx";

// The hand-to-seat trip (docs/03-design-brief.md, "Motion spec"): a 520 ms arc whose
// midpoint rises 36 px with a -9° tilt, scaled to the slot, then a 380 ms drop; under
// reduced motion a 120 ms cross-fade on the slot and no travel.

const flight = (kind: Flight["kind"]): Flight => ({
  id: 1,
  value: "5",
  kind,
  // A 50 × 72 hand card, and a 36 × 50 slot 100 px right and 300 px up (centre to centre).
  hand: { left: 0, top: 400, width: 50, height: 72 },
  slot: { left: 107, top: 111, width: 36, height: 50 },
});

describe("flightKeyframes", () => {
  it("plays: an arc 36 px above the line, tilted, scaled to the slot, then a drop", () => {
    const frames = flightKeyframes(flight("play"), false);
    expect(frames.duration).toBe(TRAVEL_MS + DROP_MS);
    expect(frames.card.map((k) => k.transform)).toEqual([
      "translate(0px, 0px) rotate(0deg) scale(1, 1)",
      `translate(50px, ${-150 - 36}px) rotate(-9deg) scale(${(1 + 0.72) / 2}, ${(1 + 50 / 72) / 2})`,
      `translate(100px, ${-300 - 10}px) rotate(0deg) scale(0.72, ${50 / 72})`,
      `translate(100px, -300px) rotate(0deg) scale(0.72, ${50 / 72})`,
    ]);
    const landed = TRAVEL_MS / (TRAVEL_MS + DROP_MS);
    expect(frames.card.map((k) => k.offset)).toEqual([0, landed / 2, landed, 1]);
    // Face down by the time it lands.
    expect(frames.back.find((k) => k.offset === landed)?.opacity).toBe(1);
    expect(frames.back[0]?.opacity).toBe(0);
  });

  it("returns: from the slot back to the hand, fading over the hand card", () => {
    const frames = flightKeyframes(flight("return"), false);
    expect(frames.duration).toBe(TRAVEL_MS);
    expect(frames.card[0]?.transform).toBe(
      `translate(100px, -300px) rotate(0deg) scale(0.72, ${50 / 72})`,
    );
    expect(frames.card.at(-1)).toMatchObject({
      transform: "translate(0px, 0px) rotate(0deg) scale(1, 1)",
      opacity: 0,
    });
  });

  it("cross-fades on the slot under reduced motion, without travel", () => {
    for (const kind of ["play", "return"] as const) {
      const frames = flightKeyframes(flight(kind), true);
      expect(frames.duration).toBe(120);
      expect(new Set(frames.card.map((k) => k.transform)).size).toBe(1);
      expect(frames.card.map((k) => k.opacity)).toEqual(kind === "play" ? [0, 1] : [1, 0]);
    }
  });
});

describe("CardFlight", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    Reflect.deleteProperty(HTMLElement.prototype, "animate");
  });

  it("lands without the Web Animations API at once", () => {
    const onDone = vi.fn();
    render(<CardFlight flight={flight("play")} onDone={onDone} />);
    expect(onDone).toHaveBeenCalledOnce();
  });

  it("reports the landing, and a new flight cancels the one in the air", () => {
    const trips: Array<{ cancel: () => void; onfinish: (() => void) | null }> = [];
    Object.defineProperty(HTMLElement.prototype, "animate", {
      configurable: true,
      value: vi.fn(() => {
        const trip = { cancel: vi.fn(), onfinish: null };
        trips.push(trip);
        return trip;
      }),
    });
    const onDone = vi.fn();
    const { rerender } = render(<CardFlight key={1} flight={flight("play")} onDone={onDone} />);
    expect(trips).toHaveLength(2);
    expect(onDone).not.toHaveBeenCalled();
    rerender(<CardFlight key={2} flight={{ ...flight("return"), id: 2 }} onDone={onDone} />);
    expect(trips[0]?.cancel).toHaveBeenCalled();
    expect(trips[1]?.cancel).toHaveBeenCalled();
    trips[2]?.onfinish?.();
    expect(onDone).toHaveBeenCalledOnce();
    expect(document.querySelector("[data-card-flight]")?.getAttribute("data-card-flight")).toBe(
      "return",
    );
  });
});
