import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  canVibrate,
  HAPTICS_STORAGE_KEY,
  hapticsOn,
  reloadHapticsOn,
  setHapticsOn,
} from "./haptics-prefs.ts";

const media = (matching: (query: string) => boolean) =>
  vi.spyOn(window, "matchMedia").mockImplementation(
    (query: string) =>
      ({
        matches: matching(query),
        media: query,
        addEventListener: () => {},
        removeEventListener: () => {},
      }) as unknown as MediaQueryList,
  );

describe("the vibration's preference", () => {
  beforeEach(() => {
    localStorage.clear();
    reloadHapticsOn();
  });
  afterEach(() => vi.restoreAllMocks());

  it("is on until someone turns it off", () => {
    expect(hapticsOn()).toBe(true);
  });

  it("stays on for anything but a saved off", () => {
    for (const saved of ["on", "true", "", "OFF", '{"on":false}', "0"]) {
      localStorage.setItem(HAPTICS_STORAGE_KEY, saved);
      reloadHapticsOn();
      expect(hapticsOn(), saved).toBe(true);
    }
  });

  it("is saved on the device and comes back after a reload", () => {
    setHapticsOn(false);
    expect(localStorage.getItem(HAPTICS_STORAGE_KEY)).toBe("off");
    reloadHapticsOn();
    expect(hapticsOn()).toBe(false);
    setHapticsOn(true);
    reloadHapticsOn();
    expect(hapticsOn()).toBe(true);
  });

  it("follows another tab", () => {
    localStorage.setItem(HAPTICS_STORAGE_KEY, "off");
    reloadHapticsOn();
    expect(hapticsOn()).toBe(false);
  });

  it("lasts for the page when storage is blocked", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    reloadHapticsOn();
    expect(hapticsOn()).toBe(true);
    setHapticsOn(false);
    expect(hapticsOn()).toBe(false);
  });
});

describe("canVibrate", () => {
  afterEach(() => vi.restoreAllMocks());
  const nav = { vibrate: () => true };

  it("needs the call and a finger", () => {
    media((query) => query.includes("coarse"));
    expect(canVibrate(nav)).toBe(true);
    expect(canVibrate({} as typeof nav)).toBe(false);
    expect(canVibrate(undefined)).toBe(false);
  });

  it("asks about any pointer, as a phone with a mouse paired still vibrates", () => {
    const query = media((q) => q.includes("coarse"));
    canVibrate(nav);
    expect(query).toHaveBeenCalledWith("(any-pointer: coarse)");
    media((q) => q === "(pointer: coarse)");
    expect(canVibrate(nav)).toBe(false);
  });

  it("is false with a mouse, where Chromium has the call and no motor", () => {
    media(() => false);
    expect(canVibrate(nav)).toBe(false);
  });

  it("is false under reduced motion, which keeps a phone still", () => {
    media(() => true);
    expect(canVibrate(nav)).toBe(false);
  });
});
