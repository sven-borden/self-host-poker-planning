// The results' motion (#20; docs/03-design-brief.md, "Motion spec"): once the cards are
// settled (`revealSettleMs`), the distribution's columns rise 500 ms, 60 ms apart, the
// numbers fade in and a consensus pops with one soft ring pulse. Under reduced motion each
// is a 120 ms cross-fade, at once. Decorative only: the panel's text and the live region
// say everything without it. The Web Animations API, as for the reveal (ADR-008 amended):
// it lives in the results chunk and costs the room route nothing.
import { EASE, type Motion, REDUCED_FADE_MS } from "../table/reveal-motion.ts";

/** A column rises in this long… */
export const RISE_MS = 500;
/** …this long after the one before it. */
export const RISE_STAGGER_MS = 60;
/** The numbers and the centre's result fade in this long. */
export const SHOW_MS = 300;
/** The consensus pill pops in this long… */
export const CONSENSUS_POP_MS = 400;
/** …then its ring pulses once, this long. */
export const CONSENSUS_PULSE_MS = 900;

const crossFade = (): Motion => ({
  keyframes: [{ opacity: 0 }, { opacity: 1 }],
  timing: { duration: REDUCED_FADE_MS, fill: "backwards" },
});

/** The `index`th column's bar grows from the baseline, `start` ms after the reveal. */
export function riseBar(index: number, start: number, reduced: boolean): Motion {
  if (reduced) return crossFade();
  return {
    keyframes: [{ transform: "scaleY(0)" }, { transform: "none" }],
    timing: {
      duration: RISE_MS,
      delay: start + index * RISE_STAGGER_MS,
      easing: EASE,
      fill: "backwards",
    },
  };
}

/** The `index`th column's count and card, with its bar: they drop 8 px and fade in. */
export function riseLabel(index: number, start: number, reduced: boolean): Motion {
  if (reduced) return crossFade();
  return {
    keyframes: [
      { opacity: 0, transform: "translateY(-8px)" },
      { opacity: 1, transform: "none" },
    ],
    timing: {
      duration: RISE_MS,
      delay: start + index * RISE_STAGGER_MS,
      easing: EASE,
      fill: "backwards",
    },
  };
}

/** The numbers, or the centre's result, fading in at `start`. */
export function showAt(start: number, reduced: boolean): Motion {
  if (reduced) return crossFade();
  return {
    keyframes: [{ opacity: 0 }, { opacity: 1 }],
    timing: { duration: SHOW_MS, delay: start, easing: EASE, fill: "backwards" },
  };
}

/** The consensus pill pops at `start`, with a slight overshoot. */
export function consensusPop(start: number, reduced: boolean): Motion {
  if (reduced) return crossFade();
  return {
    keyframes: [
      { offset: 0, opacity: 0, transform: "scale(0.6)" },
      { offset: 0.6, opacity: 1, transform: "scale(1.08)" },
      { offset: 1, opacity: 1, transform: "none" },
    ],
    timing: { duration: CONSENSUS_POP_MS, delay: start, easing: EASE, fill: "backwards" },
  };
}

/** One soft ring pulse around the pill once it has popped; none under reduced motion. */
export function consensusPulse(start: number, reduced: boolean): Motion | null {
  if (reduced) return null;
  return {
    keyframes: [
      { opacity: 0.7, transform: "scale(1)" },
      { opacity: 0, transform: "scale(1.6)" },
    ],
    timing: {
      duration: CONSENSUS_PULSE_MS,
      delay: start + CONSENSUS_POP_MS,
      easing: "ease-out",
      fill: "none",
    },
  };
}
