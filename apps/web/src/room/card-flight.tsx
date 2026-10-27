import { useLayoutEffect, useRef } from "react";
import { cn } from "../lib/utils.ts";
import { REDUCED_FADE_SECONDS } from "../motion/motion.tsx";
import { CARD_FACE, CardValue } from "../table/cards.tsx";

// The card's trip between the hand and the viewer's seat (#18; docs/03-design-brief.md,
// "Motion spec"). Decorative only: the hand's pressed card, the seat's voted badge and
// the face-down slot card say the same without motion.
//
// The Web Animations API, not Motion: importing Motion's `m` from a lazy chunk makes
// Vite 8 (rolldown) split shared modules out of the entry chunk, which cost the room
// route 12.8 kB gzipped (measured: 167.0 kB before, 179.8 kB with `m`). A keyframed trip
// needs none of Motion's features, and `Element.animate` is interruptible (`cancel`).

/** A box in viewport pixels, from `getBoundingClientRect`. */
export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface Flight {
  /** A new id per press: a new flight replaces the one in the air. */
  id: number;
  value: string;
  /** `play`: hand to seat, landing face down; `return`: seat back to the hand. */
  kind: "play" | "return";
  /** The hand card, where the ghost is drawn at rest. */
  hand: Box;
  /** The viewer's slot on the table. */
  slot: Box;
}

/** Hand → seat: a 520 ms arc, then a 380 ms drop onto the slot. */
export const TRAVEL_MS = 520;
export const DROP_MS = 380;
/** The arc's midpoint rises this far above the straight line. */
const ARC_PX = 36;
const TILT_DEG = -9;
/** The card hovers this far above the slot before it drops. */
const HOVER_PX = 10;
/** The design brief's easing (`EASE_STANDARD` in motion.tsx). */
const EASE = "cubic-bezier(0.2, 0.8, 0.2, 1)";

const mid = (a: number, b: number) => (a + b) / 2;
const at = (x: number, y: number, rotate: number, sx: number, sy: number) =>
  `translate(${x}px, ${y}px) rotate(${rotate}deg) scale(${sx}, ${sy})`;

export interface FlightKeyframes {
  /** The whole card: its path, tilt and scale (and a fade when it goes back). */
  card: Keyframe[];
  /** The back over the face: the card lands face down. */
  back: Keyframe[];
  duration: number;
}

/**
 * The trip as keyframes, relative to the hand card (the ghost's own box). Under reduced
 * motion nothing travels: the back cross-fades on the slot in 120 ms, in on a vote and
 * out when it is taken back.
 */
export function flightKeyframes(flight: Flight, reduced: boolean): FlightKeyframes {
  const { hand, slot, kind } = flight;
  const dx = slot.left + slot.width / 2 - (hand.left + hand.width / 2);
  const dy = slot.top + slot.height / 2 - (hand.top + hand.height / 2);
  const sx = slot.width / hand.width;
  const sy = slot.height / hand.height;
  const onSlot = at(dx, dy, 0, sx, sy);
  const home = at(0, 0, 0, 1, 1);
  const arc = at(dx / 2, dy / 2 - ARC_PX, TILT_DEG, mid(1, sx), mid(1, sy));

  if (reduced) {
    const fade = kind === "play" ? [0, 1] : [1, 0];
    return {
      card: fade.map((opacity) => ({ transform: onSlot, opacity })),
      back: [{ opacity: 1 }, { opacity: 1 }],
      duration: REDUCED_FADE_SECONDS * 1000,
    };
  }
  if (kind === "play") {
    const total = TRAVEL_MS + DROP_MS;
    const landed = TRAVEL_MS / total;
    return {
      card: [
        { offset: 0, transform: home, easing: EASE },
        { offset: landed / 2, transform: arc, easing: EASE },
        { offset: landed, transform: at(dx, dy - HOVER_PX, 0, sx, sy), easing: EASE },
        { offset: 1, transform: onSlot },
      ],
      // Face down as it reaches the slot, then the drop.
      back: [
        { offset: 0, opacity: 0 },
        { offset: landed * 0.75, opacity: 0 },
        { offset: landed, opacity: 1 },
        { offset: 1, opacity: 1 },
      ],
      duration: total,
    };
  }
  return {
    card: [
      { offset: 0, transform: onSlot, opacity: 1, easing: EASE },
      { offset: 0.5, transform: arc, opacity: 1, easing: EASE },
      { offset: 1, transform: home, opacity: 0 },
    ],
    back: [
      { offset: 0, opacity: 1 },
      { offset: 0.6, opacity: 0 },
      { offset: 1, opacity: 0 },
    ],
    duration: TRAVEL_MS,
  };
}

const prefersReducedMotion = () =>
  typeof window.matchMedia === "function" &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * The ghost card in the air, drawn over the hand card at rest and moved by transforms.
 * Give it a new `key` per flight: unmounting cancels the trip, so a new press interrupts
 * the last one. `onDone` runs once it has landed, or at once without the API.
 */
export function CardFlight({ flight, onDone }: { flight: Flight; onDone: () => void }) {
  const card = useRef<HTMLDivElement>(null);
  const back = useRef<HTMLDivElement>(null);
  const done = useRef(onDone);
  done.current = onDone;

  useLayoutEffect(() => {
    const element = card.current;
    const cover = back.current;
    if (!element || !cover || typeof element.animate !== "function") {
      done.current();
      return;
    }
    const frames = flightKeyframes(flight, prefersReducedMotion());
    const timing: KeyframeAnimationOptions = { duration: frames.duration, fill: "both" };
    const trip = element.animate(frames.card, timing);
    const turn = cover.animate(frames.back, timing);
    trip.onfinish = () => done.current();
    return () => {
      trip.cancel();
      turn.cancel();
    };
  }, [flight]);

  const { hand } = flight;
  return (
    <div
      ref={card}
      aria-hidden="true"
      data-card-flight={flight.kind}
      className="pointer-events-none fixed z-50"
      style={{ left: hand.left, top: hand.top, width: hand.width, height: hand.height }}
    >
      <div
        className={cn(
          CARD_FACE,
          "grid size-full place-items-center rounded-[7px] text-[20px]/none shadow-md",
        )}
      >
        <CardValue value={flight.value} room={1.88} />
      </div>
      <div
        ref={back}
        className="absolute inset-0 rounded-[7px] border border-transparent bg-card-face p-[2px] shadow-md"
      >
        <div className="pp-card-back size-full rounded-[5px]" />
      </div>
    </div>
  );
}
