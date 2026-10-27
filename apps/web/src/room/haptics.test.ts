import { afterEach, describe, expect, it, vi } from "vitest";
import { VOTE_TICK_MS, voteTick } from "./haptics.ts";

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

describe("voteTick", () => {
  afterEach(() => vi.restoreAllMocks());

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
