import { useSyncExternalStore } from "react";

// The person's sound effects (#44, ADR-020): on or off, and how loud, on this device only.
// Off until they turn it on. Nothing here reaches the server: a preference of the device,
// like the theme, not of the person's account or of the room.

export const SOUND_STORAGE_KEY = "pp-sound";
export const DEFAULT_VOLUME = 0.6;

export interface SoundPrefs {
  on: boolean;
  /** How loud, from 0 to 1. */
  volume: number;
}

const MUTED: SoundPrefs = { on: false, volume: DEFAULT_VOLUME };

/** What is saved, or muted when nothing valid is: only `true` turns the sound on. */
export function parseSoundPrefs(saved: string | null): SoundPrefs {
  if (saved === null) return MUTED;
  try {
    const value: unknown = JSON.parse(saved);
    if (typeof value !== "object" || value === null) return MUTED;
    const { on, volume } = value as Partial<Record<keyof SoundPrefs, unknown>>;
    return {
      on: on === true,
      volume:
        typeof volume === "number" && Number.isFinite(volume)
          ? Math.min(1, Math.max(0, volume))
          : DEFAULT_VOLUME,
    };
  } catch {
    return MUTED;
  }
}

function read(): SoundPrefs {
  try {
    return parseSoundPrefs(window.localStorage.getItem(SOUND_STORAGE_KEY));
  } catch {
    return MUTED;
  }
}

let current: SoundPrefs | null = null;
const listeners = new Set<() => void>();

export const soundPrefs = () => {
  current ??= read();
  return current;
};

/** Reads the device's preference again, as another tab just changed it. */
export function reloadSoundPrefs() {
  current = read();
  for (const listener of listeners) listener();
}

/** Changes the preference and saves it. Storage errors are ignored: it lasts for this page. */
export function setSoundPrefs(change: Partial<SoundPrefs>) {
  current = { ...soundPrefs(), ...change };
  try {
    window.localStorage.setItem(SOUND_STORAGE_KEY, JSON.stringify(current));
  } catch {
    // Storage blocked: the choice lasts for this page only.
  }
  for (const listener of listeners) listener();
}

function onStorage(event: StorageEvent) {
  // `null` is every key at once: `localStorage.clear()` in another tab.
  if (event.key === SOUND_STORAGE_KEY || event.key === null) reloadSoundPrefs();
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
export const useSoundPrefs = () => useSyncExternalStore(subscribe, soundPrefs, () => MUTED);
