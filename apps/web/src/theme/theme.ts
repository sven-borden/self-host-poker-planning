// Theme modes: "light" and "dark" force a theme through `data-theme` on <html>; "system"
// removes the attribute and lets `prefers-color-scheme` decide (see src/tokens.css).
// public/theme-init.js applies the saved mode before first paint with the same key.

export const THEME_MODES = ["light", "dark", "system"] as const;
export type ThemeMode = (typeof THEME_MODES)[number];

export const THEME_STORAGE_KEY = "pp-theme";

export function isThemeMode(value: unknown): value is ThemeMode {
  return typeof value === "string" && (THEME_MODES as readonly string[]).includes(value);
}

/** The saved mode, or "system" when nothing valid is saved or storage is unavailable. */
export function readThemeMode(): ThemeMode {
  try {
    const saved = window.localStorage.getItem(THEME_STORAGE_KEY);
    return isThemeMode(saved) ? saved : "system";
  } catch {
    return "system";
  }
}

/** Saves the mode; "system" clears the entry. Storage errors are ignored. */
export function writeThemeMode(mode: ThemeMode): void {
  try {
    if (mode === "system") {
      window.localStorage.removeItem(THEME_STORAGE_KEY);
    } else {
      window.localStorage.setItem(THEME_STORAGE_KEY, mode);
    }
  } catch {
    // Storage blocked: the choice lasts for this page only.
  }
}

export function applyThemeMode(
  mode: ThemeMode,
  root: HTMLElement = document.documentElement,
): void {
  if (mode === "system") {
    root.removeAttribute("data-theme");
  } else {
    root.setAttribute("data-theme", mode);
  }
}
