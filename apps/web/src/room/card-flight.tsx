import { type HTMLMotionProps, m } from "motion/react";
import { cn } from "../lib/utils.ts";
import {
  EASE_STANDARD,
  MotionFeatures,
  REDUCED_FADE_SECONDS,
  usePrefersReducedMotion,
} from "../motion/motion.tsx";
import { CARD_FACE, CardValue } from "../table/cards.tsx";

// The card's trip between the hand and the viewer's seat (#18; docs/03-design-brief.md,
// "Motion spec"). A chunk of its own, loaded beside the hand, so Motion's `m` stays out of
// the room route. Decorative only: the hand's pressed card, the seat's voted badge and the
// face-down slot card say the same without motion.

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
const TRAVEL_SECONDS = 0.52;
const DROP_SECONDS = 0.38;
/** The arc's midpoint rises this far above the straight line. */
const ARC_PX = 36;
const TILT_DEG = -9;
/** The card hovers this far above the slot before it drops. */
const HOVER_PX = 10;

type Animation = Pick<HTMLMotionProps<"div">, "initial" | "animate" | "transition">;

const mid = (a: number, b: number) => (a + b) / 2;

export default function CardFlight({
  flight,
  onDone,
}: {
  flight: Flight | null;
  onDone: () => void;
}) {
  if (flight === null) return null;
  return (
    <MotionFeatures>
      <Ghost key={flight.id} flight={flight} onDone={onDone} />
    </MotionFeatures>
  );
}

function Ghost({ flight, onDone }: { flight: Flight; onDone: () => void }) {
  const reduced = usePrefersReducedMotion();
  const { hand, slot, kind } = flight;
  const dx = slot.left + slot.width / 2 - (hand.left + hand.width / 2);
  const dy = slot.top + slot.height / 2 - (hand.top + hand.height / 2);
  const sx = slot.width / hand.width;
  const sy = slot.height / hand.height;
  const atSlot = { x: dx, y: dy, scaleX: sx, scaleY: sy, rotate: 0 };

  let motion: Animation;
  let back: Animation;
  if (reduced) {
    // A 120 ms cross-fade on the slot: the back fades in (play) or out (return).
    motion = {
      initial: { ...atSlot, opacity: kind === "play" ? 0 : 1 },
      animate: { opacity: kind === "play" ? 1 : 0 },
      transition: { duration: REDUCED_FADE_SECONDS, ease: "linear" },
    };
    back = { initial: { opacity: 1 } };
  } else if (kind === "play") {
    const total = TRAVEL_SECONDS + DROP_SECONDS;
    const landed = TRAVEL_SECONDS / total;
    motion = {
      initial: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotate: 0, opacity: 1 },
      animate: {
        x: [0, dx / 2, dx, dx],
        y: [0, dy / 2 - ARC_PX, dy - HOVER_PX, dy],
        rotate: [0, TILT_DEG, 0, 0],
        scaleX: [1, mid(1, sx), sx, sx],
        scaleY: [1, mid(1, sy), sy, sy],
      },
      transition: {
        duration: total,
        times: [0, landed / 2, landed, 1],
        ease: [EASE_STANDARD, EASE_STANDARD, EASE_STANDARD],
      },
    };
    // The card turns face down as it reaches the slot, then drops.
    back = {
      initial: { opacity: 0 },
      animate: { opacity: [0, 0, 1, 1] },
      transition: { duration: total, times: [0, landed * 0.75, landed, 1] },
    };
  } else {
    motion = {
      initial: { ...atSlot, opacity: 1 },
      animate: {
        x: [dx, dx / 2, 0],
        y: [dy, dy / 2 - ARC_PX, 0],
        rotate: [0, TILT_DEG, 0],
        scaleX: [sx, mid(1, sx), 1],
        scaleY: [sy, mid(1, sy), 1],
        opacity: [1, 1, 0],
      },
      transition: { duration: TRAVEL_SECONDS, times: [0, 0.5, 1], ease: EASE_STANDARD },
    };
    back = {
      initial: { opacity: 1 },
      animate: { opacity: [1, 0, 0] },
      transition: { duration: TRAVEL_SECONDS, times: [0, 0.6, 1] },
    };
  }

  return (
    <m.div
      aria-hidden="true"
      data-card-flight={kind}
      className="pointer-events-none fixed z-50"
      style={{ left: hand.left, top: hand.top, width: hand.width, height: hand.height }}
      {...motion}
      onAnimationComplete={onDone}
    >
      <div
        className={cn(
          CARD_FACE,
          "grid size-full place-items-center rounded-[7px] text-[20px]/none shadow-md",
        )}
      >
        <CardValue value={flight.value} room={1.88} />
      </div>
      <m.div
        className="absolute inset-0 rounded-[7px] border border-transparent bg-card-face p-[2px] shadow-md"
        {...back}
      >
        <div className="pp-card-back size-full rounded-[5px]" />
      </m.div>
    </m.div>
  );
}
