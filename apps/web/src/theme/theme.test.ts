import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import themeInitSource from "../../public/theme-init.js?raw";
import {
  applyThemeMode,
  readThemeMode,
  THEME_STORAGE_KEY,
  type ThemeMode,
  writeThemeMode,
} from "./theme.ts";
import { useThemeStore } from "./use-theme-mode.ts";

const root = document.documentElement;

/** Runs public/theme-init.js the way the browser does before first paint. */
function runThemeInit(): void {
  new Function(themeInitSource)();
}

beforeEach(() => {
  localStorage.clear();
  root.removeAttribute("data-theme");
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("theme storage", () => {
  it("defaults to system", () => {
    expect(readThemeMode()).toBe("system");
  });

  it.each(["light", "dark"] as const)("round-trips %s", (mode) => {
    writeThemeMode(mode);
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe(mode);
    expect(readThemeMode()).toBe(mode);
  });

  it("clears the entry for system", () => {
    writeThemeMode("dark");
    writeThemeMode("system");
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBeNull();
  });

  it("ignores a value it does not know", () => {
    localStorage.setItem(THEME_STORAGE_KEY, "sepia");
    expect(readThemeMode()).toBe("system");
  });

  it("survives storage that throws", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("blocked", "SecurityError");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("blocked", "SecurityError");
    });
    expect(readThemeMode()).toBe("system");
    expect(() => writeThemeMode("dark")).not.toThrow();
    expect(runThemeInit).not.toThrow();
    expect(root.hasAttribute("data-theme")).toBe(false);
  });
});

describe("applyThemeMode", () => {
  it.each([
    ["light", "light"],
    ["dark", "dark"],
    ["system", null],
  ] as [ThemeMode, string | null][])("%s sets data-theme to %s", (mode, attribute) => {
    applyThemeMode("dark");
    applyThemeMode(mode);
    expect(root.getAttribute("data-theme")).toBe(attribute);
  });
});

describe("public/theme-init.js", () => {
  it.each(["light", "dark"] as const)("applies a saved %s theme", (mode) => {
    writeThemeMode(mode);
    runThemeInit();
    expect(root.getAttribute("data-theme")).toBe(mode);
  });

  it("leaves system and unknown values to the media query", () => {
    runThemeInit();
    expect(root.hasAttribute("data-theme")).toBe(false);
    localStorage.setItem(THEME_STORAGE_KEY, "sepia");
    runThemeInit();
    expect(root.hasAttribute("data-theme")).toBe(false);
  });

  it("uses the same storage key as the app", () => {
    expect(themeInitSource).toContain(`"${THEME_STORAGE_KEY}"`);
  });
});

describe("theme store", () => {
  it("saves and applies the chosen mode", () => {
    useThemeStore.getState().setMode("dark");
    expect(useThemeStore.getState().mode).toBe("dark");
    expect(root.getAttribute("data-theme")).toBe("dark");
    expect(readThemeMode()).toBe("dark");

    useThemeStore.getState().setMode("system");
    expect(root.hasAttribute("data-theme")).toBe(false);
    expect(readThemeMode()).toBe("system");
  });
});
