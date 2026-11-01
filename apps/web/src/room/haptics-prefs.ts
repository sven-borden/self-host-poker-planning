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

export const hapticsOn = () => {
  current ??= read();
  return current;
};

/** Reads the device's preference again, as another tab just changed it. */
export function reloadHapticsOn() {
  current = read();
  for (const listener of listeners) listener();
}

/** Changes the preference and saves it. Storage errors are ignored: it lasts for this page. */
export function setHapticsOn(on: boolean) {
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
  if (listeners.size === 0) window.addEventListener("storage", onStorage);
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) window.removeEventListener("storage", onStorage);
  };
}

/** The preference, following a change here or in another tab of this device. */
export const useHapticsOn = () => useSyncExternalStore(subscribe, hapticsOn, () => true);

/**
 * True where the switch means something. Chromium has `navigator.vibrate` on a desktop too,
 * with no motor behind it, so a mouse rules it out; and under reduced motion nothing vibrates.
 */
export function canVibrate(nav: Pick<Navigator, "vibrate"> | undefined = globalThis.navigator) {
  return (
    typeof nav?.vibrate === "function" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(pointer: coarse)").matches &&
    !prefersReducedMotion()
  );
}
