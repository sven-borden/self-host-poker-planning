import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_VOLUME,
  parseSoundPrefs,
  reloadSoundPrefs,
  SOUND_STORAGE_KEY,
  setSoundPrefs,
  soundPrefs,
} from "./sound-prefs.ts";

describe("parseSoundPrefs", () => {
  it("is muted until someone turned the sound on", () => {
    expect(parseSoundPrefs(null)).toEqual({ on: false, volume: DEFAULT_VOLUME });
    expect(parseSoundPrefs("{}").on).toBe(false);
    expect(parseSoundPrefs('{"on":"yes"}').on).toBe(false);
    expect(parseSoundPrefs('{"on":1}').on).toBe(false);
  });

  it("is muted for anything it cannot read", () => {
    for (const saved of ["not json", "null", "true", "[", "7"]) {
      expect(parseSoundPrefs(saved)).toEqual({ on: false, volume: DEFAULT_VOLUME });
    }
  });

  it("keeps a volume between 0 and 1", () => {
    expect(parseSoundPrefs('{"on":true,"volume":0.35}')).toEqual({ on: true, volume: 0.35 });
    expect(parseSoundPrefs('{"volume":9}').volume).toBe(1);
    expect(parseSoundPrefs('{"volume":-1}').volume).toBe(0);
    expect(parseSoundPrefs('{"volume":"loud"}').volume).toBe(DEFAULT_VOLUME);
  });
});

describe("the device's preference", () => {
  beforeEach(() => {
    window.localStorage.clear();
    reloadSoundPrefs();
  });
  afterEach(() => vi.restoreAllMocks());

  it("starts muted and survives a reload", () => {
    expect(soundPrefs().on).toBe(false);
    setSoundPrefs({ on: true });
    setSoundPrefs({ volume: 0.25 });
    reloadSoundPrefs();
    expect(soundPrefs()).toEqual({ on: true, volume: 0.25 });
    expect(JSON.parse(window.localStorage.getItem(SOUND_STORAGE_KEY) ?? "")).toEqual({
      on: true,
      volume: 0.25,
    });
  });

  it("lasts for the page when storage is blocked", () => {
    const blocked = () => {
      throw new DOMException("denied", "SecurityError");
    };
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(blocked);
    setSoundPrefs({ on: true });
    expect(soundPrefs().on).toBe(true);
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(blocked);
    reloadSoundPrefs();
    expect(soundPrefs().on).toBe(false);
  });
});
