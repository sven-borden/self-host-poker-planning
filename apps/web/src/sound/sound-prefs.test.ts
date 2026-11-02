import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_MOOD,
  DEFAULT_VOLUME,
  parseSoundPrefs,
  reloadSoundPrefs,
  SOUND_STORAGE_KEY,
  setSoundPrefs,
  soundPrefs,
} from "./sound-prefs.ts";

const SILENT = { on: false, volume: DEFAULT_VOLUME, music: false, mood: DEFAULT_MOOD };

describe("parseSoundPrefs", () => {
  it("is muted until someone turned the sound on", () => {
    expect(parseSoundPrefs(null)).toEqual(SILENT);
    expect(parseSoundPrefs("{}").on).toBe(false);
    expect(parseSoundPrefs('{"on":"yes"}').on).toBe(false);
    expect(parseSoundPrefs('{"on":1}').on).toBe(false);
  });

  it("is muted for anything it cannot read", () => {
    for (const saved of ["not json", "null", "true", "[", "7"]) {
      expect(parseSoundPrefs(saved)).toEqual(SILENT);
    }
  });

  it("keeps a volume between 0 and 1", () => {
    expect(parseSoundPrefs('{"on":true,"volume":0.35}')).toMatchObject({ on: true, volume: 0.35 });
    expect(parseSoundPrefs('{"volume":9}').volume).toBe(1);
    expect(parseSoundPrefs('{"volume":-1}').volume).toBe(0);
    expect(parseSoundPrefs('{"volume":"loud"}').volume).toBe(DEFAULT_VOLUME);
  });

  it("reads what was saved before there was music as music off", () => {
    expect(parseSoundPrefs('{"on":true,"volume":0.35}')).toEqual({
      on: true,
      volume: 0.35,
      music: false,
      mood: DEFAULT_MOOD,
    });
  });

  it("turns the music on only for `true`, and keeps only a mood it knows", () => {
    expect(parseSoundPrefs('{"music":true,"mood":"tide"}')).toMatchObject({
      music: true,
      mood: "tide",
    });
    expect(parseSoundPrefs('{"music":"yes"}').music).toBe(false);
    expect(parseSoundPrefs('{"music":1}').music).toBe(false);
    expect(parseSoundPrefs('{"mood":"opera"}').mood).toBe(DEFAULT_MOOD);
    expect(parseSoundPrefs('{"mood":7}').mood).toBe(DEFAULT_MOOD);
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
    expect(soundPrefs()).toEqual({ ...SILENT, on: true, volume: 0.25 });
    expect(JSON.parse(window.localStorage.getItem(SOUND_STORAGE_KEY) ?? "")).toEqual({
      ...SILENT,
      on: true,
      volume: 0.25,
    });
  });

  it("keeps the music and its mood beside the effects", () => {
    setSoundPrefs({ music: true, mood: "embers" });
    reloadSoundPrefs();
    expect(soundPrefs()).toEqual({ ...SILENT, music: true, mood: "embers" });
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
