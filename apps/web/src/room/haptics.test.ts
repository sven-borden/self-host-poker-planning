import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { REVEAL_PATTERN, revealTick, VOTE_TICK_MS, voteTick } from "./haptics.ts";
import { HAPTICS_STORAGE_KEY, reloadHapticsOn, setHapticsOn } from "./haptics-prefs.ts";

const reducedMotion = (reduce: boolean) =>
  vi.spyOn(window, "matchMedia").mockImplementation(
    (query: string) =>
      ({
        matches: reduce && query.includes("prefers-reduced-motion"),
        media: query,
        addEventListener: () => {},
        removeEventListener: () => {},
      }) as unknown as MediaQueryList,
  );

beforeEach(() => {
  localStorage.removeItem(HAPTICS_STORAGE_KEY);
  reloadHapticsOn();
});
afterEach(() => vi.restoreAllMocks());

describe("voteTick", () => {
  it("ticks once, briefly, where the browser can vibrate", () => {
    reducedMotion(false);
    const vibrate = vi.fn(() => true);
    expect(voteTick({ vibrate })).toBe(true);
    expect(vibrate).toHaveBeenCalledExactlyOnceWith(VOTE_TICK_MS);
  });

  it("does nothing under reduced motion", () => {
    reducedMotion(true);
    const vibrate = vi.fn(() => true);
    expect(voteTick({ vibrate })).toBe(false);
    expect(vibrate).not.toHaveBeenCalled();
  });

  it("does nothing, and throws nothing, without vibrate (Safari on iOS)", () => {
    reducedMotion(false);
    expect(voteTick({} as Pick<Navigator, "vibrate">)).toBe(false);
    expect(voteTick(undefined)).toBe(false);
  });

  it("swallows a browser that refuses or throws", () => {
    reducedMotion(false);
    expect(voteTick({ vibrate: () => false })).toBe(false);
    expect(
      voteTick({
        vibrate: () => {
          throw new Error("blocked");
        },
      }),
    ).toBe(false);
  });
});

describe("revealTick", () => {
  it("beats twice, unlike a vote's tick", () => {
    reducedMotion(false);
    const vibrate = vi.fn(() => true);
    expect(revealTick({ vibrate })).toBe(true);
    expect(vibrate).toHaveBeenCalledExactlyOnceWith(REVEAL_PATTERN);
    expect(REVEAL_PATTERN).toHaveLength(3);
  });

  it("does nothing under reduced motion, without the call, or when refused", () => {
    reducedMotion(true);
    const vibrate = vi.fn(() => true);
    expect(revealTick({ vibrate })).toBe(false);
    expect(vibrate).not.toHaveBeenCalled();
    reducedMotion(false);
    expect(revealTick(undefined)).toBe(false);
    expect(revealTick({ vibrate: () => false })).toBe(false);
  });

  it("is not cut short by the vote that ended the round", () => {
    reducedMotion(false);
    const now = vi.spyOn(performance, "now").mockReturnValue(10_000);
    const vibrate = vi.fn(() => true);
    revealTick({ vibrate });
    now.mockReturnValue(10_050);
    expect(voteTick({ vibrate })).toBe(false);
    expect(vibrate).toHaveBeenCalledOnce();
    // A card changed after the reveal (#29) is a vote of its own again.
    now.mockReturnValue(11_000);
    expect(voteTick({ vibrate })).toBe(true);
  });
});

describe("the switch", () => {
  it("silences both", () => {
    reducedMotion(false);
    setHapticsOn(false);
    const vibrate = vi.fn(() => true);
    expect(voteTick({ vibrate })).toBe(false);
    expect(revealTick({ vibrate })).toBe(false);
    expect(vibrate).not.toHaveBeenCalled();
  });
});
