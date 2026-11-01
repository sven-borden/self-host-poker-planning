import { type RefObject, useLayoutEffect, useRef } from "react";
import type { Point } from "./layout.ts";
import { EASE, type Motion, play, prefersReducedMotion, REDUCED_FADE_MS } from "./reveal-motion.ts";

// People coming to the table and leaving it (#43; docs/03-design-brief.md, "Motion spec"):
// a seat and its slot fade and scale from 0.9 in 220 ms, and everyone else glides to their
// new place in the same time, since the table spreads its seats by how many there are.
// Decorative only: the seat's label and the live region say who came and went.
//
// The separate `scale` and `translate` properties, so a seat that glides while it fades in
// needs no cancelling. A glide adds to the one before it (`composite: "add"`): a new join
// in mid-glide carries on from where the seat is, with nothing to read from the page and
// nothing that jumps. Under reduced motion nothing glides; seats only cross-fade.

/** A seat joins or leaves in this long, and the others glide. */
export const SEAT_MS = 220;
/** A seat starts from, or leaves towards, this scale. */
const SEAT_SCALE = 0.9;

export function seatIn(reduced: boolean): Motion {
  return reduced
    ? {
        keyframes: [{ opacity: 0 }, { opacity: 1 }],
        timing: { duration: REDUCED_FADE_MS, fill: "backwards" },
      }
    : {
        keyframes: [
          { opacity: 0, scale: String(SEAT_SCALE) },
          { opacity: 1, scale: "1" },
        ],
        timing: { duration: SEAT_MS, easing: EASE, fill: "backwards" },
      };
}

export function seatOut(reduced: boolean): Motion {
  return reduced
    ? {
        keyframes: [{ opacity: 1 }, { opacity: 0 }],
        timing: { duration: REDUCED_FADE_MS, fill: "forwards" },
      }
    : {
        keyframes: [
          { opacity: 1, scale: "1" },
          { opacity: 0, scale: String(SEAT_SCALE) },
        ],
        timing: { duration: SEAT_MS, easing: EASE, fill: "forwards" },
      };
}

/** From `x`, `y` pixels away back to the seat's place, on top of any glide under way. */
export function seatGlide(x: number, y: number): Motion {
  return {
    keyframes: [{ translate: `${x}px ${y}px` }, { translate: "0px 0px" }],
    timing: { duration: SEAT_MS, easing: EASE, composite: "add" },
  };
}

/** One person's places on the table, in percent of the stage. */
export interface SeatSpot {
  id: string;
  seat: Point;
  slot: Point;
}

type Part = "seat" | "slot";
type Drawn = Map<string, Partial<Record<Part, Element>>>;

/** The elements of everyone at the table: each seat and its slot name their person. */
function drawn(stage: Element): Drawn {
  const found: Drawn = new Map();
  for (const element of stage.querySelectorAll("[data-person]")) {
    const id = element.getAttribute("data-person") ?? "";
    const part: Part = element.hasAttribute("data-seat") ? "seat" : "slot";
    found.set(id, { ...found.get(id), [part]: element });
  }
  return found;
}

/**
 * React has dropped a departed seat's element: it goes back on the stage for its way out,
 * as it looked (never anything new), hidden from assistive technology and the keyboard,
 * and without the marks that make it someone at the table, or a target for the page.
 */
function leave(element: Element, stage: Element, reduced: boolean) {
  for (const node of [element, ...element.querySelectorAll("*")]) {
    for (const name of node.getAttributeNames()) {
      if (name.startsWith("data-")) node.removeAttribute(name);
    }
  }
  element.setAttribute("aria-hidden", "true");
  element.toggleAttribute("inert", true);
  stage.append(element);
  const out = play(element, seatOut(reduced));
  if (out === null) {
    element.remove();
    return;
  }
  out.onfinish = () => element.remove();
  out.oncancel = () => element.remove();
}

/**
 * Plays the table's joins and leaves as they happen on screen. The first people drawn show
 * at rest (a reload, entering the room), and so does a table redrawn for another width. No
 * cleanup: a change in mid-motion lets the last one run out (the glides add up), and the
 * elements go with the table.
 */
export function useSeatMotion(
  stage: RefObject<HTMLElement | null>,
  spots: readonly SeatSpot[],
  variant: string,
) {
  const last = useRef<{ spots: Map<string, SeatSpot>; parts: Drawn; variant: string } | null>(null);
  const seated = spots.map((spot) => spot.id).join();

  // biome-ignore lint/correctness/useExhaustiveDependencies: only a change of who sits here moves anyone.
  useLayoutEffect(() => {
    const root = stage.current;
    if (!root) return;
    const before = last.current;
    const now = { spots: new Map(spots.map((s) => [s.id, s])), parts: drawn(root), variant };
    last.current = now;
    if (before === null || before.variant !== variant) return;
    const reduced = prefersReducedMotion();
    const width = root.clientWidth / 100;
    const height = root.clientHeight / 100;
    for (const [id, parts] of before.parts) {
      if (now.spots.has(id)) continue;
      for (const part of Object.values(parts)) leave(part, root, reduced);
    }
    for (const spot of spots) {
      const parts = now.parts.get(spot.id);
      const was = before.spots.get(spot.id);
      if (!was) {
        for (const part of Object.values(parts ?? {})) play(part, seatIn(reduced));
        continue;
      }
      if (reduced) continue;
      for (const part of ["seat", "slot"] as const) {
        const x = (was[part].x - spot[part].x) * width;
        const y = (was[part].y - spot[part].y) * height;
        if (x !== 0 || y !== 0) play(parts?.[part] ?? null, seatGlide(x, y));
      }
    }
  }, [seated, variant, stage]);
}
