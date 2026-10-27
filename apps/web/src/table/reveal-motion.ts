// The reveal's motion (#19; docs/03-design-brief.md, "Motion spec"): a slot card turns
// face up, or after an anonymous reveal fades from its seat while the cards deal into the
// row under the table. Decorative only: the seats' labels, the faces at rest and the live
// region say the same without motion.
//
// The Web Animations API, not Motion, as for the card's flight (#18, ADR-008 amended):
// keyframes need none of Motion's features, `Element.animate` costs no bytes, and
// `cancel` interrupts. Everything here runs from the `seated` chunk, which the room route
// loads lazily.

/** Duration of the cross-fade that replaces any travel under reduced motion. */
export const REDUCED_FADE_MS = 120;
/** A card turns over in this long… */
export const FLIP_MS = 650;
/** …one after the other, in seat order from the viewer. */
export const FLIP_STAGGER_MS = 90;
/** After an anonymous reveal, a seat's card shrinks and fades in this long… */
export const FADE_AWAY_MS = 350;
/** …to this scale. */
const FADE_AWAY_SCALE = 0.6;
/** The cards then deal into the row under the table, this far apart… */
export const DEAL_STAGGER_MS = 70;
/** …each falling into place in this long. */
export const DEAL_MS = 320;
/** The design brief's easing (`EASE_STANDARD` in motion.tsx). */
const EASE = "cubic-bezier(0.2, 0.8, 0.2, 1)";

export interface Motion {
  keyframes: Keyframe[];
  timing: KeyframeAnimationOptions;
}

export const prefersReducedMotion = () =>
  typeof window.matchMedia === "function" &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * A slot card turning face up after `delay` ms. The face (the slot's own element) turns
 * from 0 to 90° with the back drawn over it, then comes back from −90° bare: the same as
 * a two-sided card turning 180°, with no 3D context and no transform at rest. The back
 * (`cover`) shows until the card is edge-on. Under reduced motion nothing turns and
 * nothing waits: the back fades off the face in 120 ms.
 */
export function turnUp(
  delay: number,
  reduced: boolean,
  perspective: number,
): { face: Motion | null; cover: Motion } {
  if (reduced) {
    return {
      face: null,
      cover: {
        keyframes: [{ opacity: 1 }, { opacity: 0 }],
        timing: { duration: REDUCED_FADE_MS, fill: "backwards" },
      },
    };
  }
  const turn = (deg: number) => `perspective(${perspective}px) rotateY(${deg}deg)`;
  // One easing for the whole turn, shared by both: the keyframe offsets are in eased
  // progress, so the face and its back reach the edge-on midpoint at the same moment.
  const timing: KeyframeAnimationOptions = {
    duration: FLIP_MS,
    delay,
    easing: EASE,
    fill: "backwards",
  };
  return {
    face: {
      keyframes: [
        { offset: 0, transform: turn(0) },
        { offset: 0.5, transform: turn(90) },
        { offset: 0.5, transform: turn(-90) },
        { offset: 1, transform: turn(0) },
      ],
      timing,
    },
    cover: {
      keyframes: [
        { offset: 0, opacity: 1 },
        { offset: 0.5, opacity: 1 },
        { offset: 0.5, opacity: 0 },
        { offset: 1, opacity: 0 },
      ],
      timing,
    },
  };
}

/** After an anonymous reveal: the seat's face-down card shrinks to 0.6 and fades. */
export function fadeAway(reduced: boolean): Motion {
  return reduced
    ? {
        keyframes: [{ opacity: 1 }, { opacity: 0 }],
        timing: { duration: REDUCED_FADE_MS, fill: "backwards" },
      }
    : {
        keyframes: [
          { opacity: 1, transform: "scale(1)" },
          { opacity: 0, transform: `scale(${FADE_AWAY_SCALE})` },
        ],
        timing: { duration: FADE_AWAY_MS, easing: EASE, fill: "backwards" },
      };
}

/**
 * The `index`th card of the row under the table, dealt face up once the seats' cards
 * have faded: it drops 12 px into place and fades in, 70 ms after the one before. Under
 * reduced motion every card fades in together, in 120 ms.
 */
export function dealIn(index: number, reduced: boolean): Motion {
  return reduced
    ? {
        keyframes: [{ opacity: 0 }, { opacity: 1 }],
        timing: { duration: REDUCED_FADE_MS, fill: "backwards" },
      }
    : {
        keyframes: [
          { opacity: 0, transform: "translateY(-12px) scale(0.9)" },
          { opacity: 1, transform: "none" },
        ],
        timing: {
          duration: DEAL_MS,
          delay: FADE_AWAY_MS + index * DEAL_STAGGER_MS,
          easing: EASE,
          fill: "backwards",
        },
      };
}

/** Runs `motion` on `element` when the browser can; the animation, to cancel, or null. */
export function play(element: Element | null, motion: Motion | null): Animation | null {
  if (!element || !motion || typeof element.animate !== "function") return null;
  return element.animate(motion.keyframes, motion.timing);
}

/** Cancels what `play` started: an interrupted reveal jumps to its end state at once. */
export function cancelAll(animations: ReadonlyArray<Animation | null>): void {
  for (const animation of animations) animation?.cancel();
}
