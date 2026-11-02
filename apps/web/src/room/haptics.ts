import { prefersReducedMotion } from "../table/reveal-motion.ts";
import { hapticsOn } from "./haptics-prefs.ts";

/** How long the vote's tick lasts, in milliseconds: felt, not heard. */
export const VOTE_TICK_MS = 12;
/** The reveal's two beats, a short one and a longer one, so it is not taken for a vote. */
export const REVEAL_PATTERN = [20, 70, 35];

const REVEAL_MS = REVEAL_PATTERN.reduce((total, part) => total + part);

type Vibrator = Pick<Navigator, "vibrate"> | undefined;

/** When the last reveal's beats started: a later call would cut them short. */
let revealedAt = Number.NEGATIVE_INFINITY;

/**
 * Where the browser can vibrate (Android; Safari on iOS has no `navigator.vibrate`, so
 * nothing happens there and nothing fails) and the person has not turned it off (#46). Never
 * under reduced motion, and never the only feedback: the screen and the live region say it
 * all. Returns whether a vibration was asked for.
 */
function buzz(pattern: number | number[], nav: Vibrator) {
  if (typeof nav?.vibrate !== "function" || !hapticsOn() || prefersReducedMotion()) return false;
  try {
    // Refused without a tap on the page first, or by a browser setting: no tick, no error.
    return nav.vibrate(pattern);
  } catch {
    return false;
  }
}

/**
 * A short tick under the finger once the server confirmed the viewer's vote (#22). The vote
 * that ends a round can be confirmed just after its reveal arrives: the reveal's beats, which
 * a new vibration would stop, then say it for both.
 */
export function voteTick(nav: Vibrator = globalThis.navigator) {
  if (performance.now() - revealedAt < REVEAL_MS) return false;
  return buzz(VOTE_TICK_MS, nav);
}

/**
 * The reveal, for everyone (#46), called once per reveal by `LiveAnnouncer`. In the snapshot's
 * own task, and that is fine here: one call, which only hands the pattern to the browser.
 */
export function revealTick(nav: Vibrator = globalThis.navigator) {
  const asked = buzz(REVEAL_PATTERN, nav);
  if (asked) revealedAt = performance.now();
  return asked;
}
