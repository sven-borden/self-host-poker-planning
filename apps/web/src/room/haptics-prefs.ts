import { useSyncExternalStore } from "react";
import { prefersReducedMotion } from "../table/reveal-motion.ts";

// Vibration on the person's vote and on the reveal (#46, ADR-022): on until they turn it off,
// on this device only. Nothing here reaches the server, as with the sound's switch.

export const HAPTICS_STORAGE_KEY = "pp-haptics";

/** Only a saved "off" turns it off: nothing saved, or anything else, leaves it on. */
const read = () => {
  try {
    return window.localStorage.getItem(HAPTICS_STORAGE_KEY) !== "off";
  } catch {
    return true;
  }
};

let current: boolean | null = null;
const listeners = new Set<() => void>();
let watching = false;

/**
 * Listens for another tab's change for the page's life, from the first use on: a tab whose
 * popover was never opened must stop vibrating too when the switch is turned off elsewhere.
 */
function watch() {
  if (watching || typeof window === "undefined") return;
  watching = true;
  window.addEventListener("storage", onStorage);
}

export const hapticsOn = () => {
  watch();
  current ??= read();
  return current;
};

/** Reads the device's preference again, as another tab just changed it. */
export function reloadHapticsOn() {
  watch();
  current = read();
  for (const listener of listeners) listener();
}

/** Changes the preference and saves it. Storage errors are ignored: it lasts for this page. */
export function setHapticsOn(on: boolean) {
  watch();
  current = on;
  try {
    window.localStorage.setItem(HAPTICS_STORAGE_KEY, on ? "on" : "off");
  } catch {
    // Storage blocked: the choice lasts for this page only.
  }
  for (const listener of listeners) listener();
}

function onStorage(event: StorageEvent) {
  // `null` is every key at once: `localStorage.clear()` in another tab.
  if (event.key === HAPTICS_STORAGE_KEY || event.key === null) reloadHapticsOn();
}

function subscribe(listener: () => void) {
  watch();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The preference, following a change here or in another tab of this device. */
export const useHapticsOn = () => useSyncExternalStore(subscribe, hapticsOn, () => true);

/**
 * True where the switch means something. Chromium has `navigator.vibrate` on a desktop too,
 * with no motor behind it, so it needs a touch screen among the pointers (`any-pointer`: a
 * phone with a mouse paired still vibrates, and its switch must not vanish); and under
 * reduced motion nothing vibrates.
 */
export function canVibrate(nav: Pick<Navigator, "vibrate"> | undefined = globalThis.navigator) {
  return (
    typeof nav?.vibrate === "function" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(any-pointer: coarse)").matches &&
    !prefersReducedMotion()
  );
}
