import { prefersReducedMotion } from "../table/reveal-motion.ts";

/** How long the vote's tick lasts, in milliseconds: felt, not heard. */
export const VOTE_TICK_MS = 12;

/**
 * A short tick under the finger once the server confirmed the viewer's vote (#22), where
 * the browser can vibrate (Android; Safari on iOS has no `navigator.vibrate`, so nothing
 * happens there and nothing fails). Never under reduced motion, and never the only
 * feedback: the card lifts, the seat turns and the hand's live region says the vote.
 * Returns whether a tick was asked for.
 */
export function voteTick(nav: Pick<Navigator, "vibrate"> | undefined = globalThis.navigator) {
  if (typeof nav?.vibrate !== "function" || prefersReducedMotion()) return false;
  try {
    // Refused without a tap on the page first, or by a browser setting: no tick, no error.
    return nav.vibrate(VOTE_TICK_MS);
  } catch {
    return false;
  }
}
