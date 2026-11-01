import { type Motion, play, prefersReducedMotion } from "../table/reveal-motion.ts";

// The avatars' idle life (#42). One gesture at a time, somewhere at the table, a couple of
// seconds apart: a blink or a small bob. Calm, like the rest of the room, and cheap: between
// gestures nothing runs. A CSS loop per avatar would restyle 16 seats on every frame, for
// good; the timer's ring found that out (#27). Decorative only, so nothing is lost without
// it: reduced motion gets still avatars, and a hidden tab skips its gestures.

/** The wait between two gestures, in ms, drawn anew each time. */
export const IDLE_GAP = { min: 1500, max: 3500 } as const;
/** How many gestures are blinks; the others are bobs. */
export const BLINK_SHARE = 0.7;

const BLINK: Motion = {
  keyframes: [{ transform: "scaleY(1)" }, { transform: "scaleY(0.1)" }, { transform: "scaleY(1)" }],
  timing: { duration: 180, easing: "ease-in-out" },
};

/** 6 % of the avatar: 2 px on a seat. The drawings keep that much off the disc's edge. */
const BOB: Motion = {
  keyframes: [
    { transform: "translateY(0)" },
    { transform: "translateY(-6%)" },
    { transform: "translateY(0)" },
  ],
  timing: { duration: 800, easing: "ease-in-out" },
};

function gesture(): void {
  if (document.hidden || prefersReducedMotion()) return;
  const avatars = document.querySelectorAll('[data-avatar-art="idle"]');
  const avatar = avatars[Math.floor(Math.random() * avatars.length)];
  if (!avatar) return;
  if (Math.random() < BLINK_SHARE) play(avatar.querySelector("[data-avatar-eyes]"), BLINK);
  else play(avatar, BOB);
}

let holders = 0;
let timer: ReturnType<typeof setTimeout> | undefined;

function next(): void {
  const gap = IDLE_GAP.min + Math.random() * (IDLE_GAP.max - IDLE_GAP.min);
  timer = setTimeout(() => {
    gesture();
    next();
  }, gap);
}

/** An idle avatar is on screen: the gestures run until the last one calls what this returns. */
export function holdIdle(): () => void {
  holders += 1;
  if (holders === 1) next();
  return () => {
    holders -= 1;
    if (holders === 0) clearTimeout(timer);
  };
}
