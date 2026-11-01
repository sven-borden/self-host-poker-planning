import { describe, expect, it } from "vitest";
import { SOUNDS, type SoundName, soundLength } from "./sound-recipes.ts";

const NAMES = Object.keys(SOUNDS) as SoundName[];

describe("the sounds", () => {
  it("are the five the issue names", () => {
    expect(NAMES.sort()).toEqual(["card", "consensus", "flip", "reveal", "tick"]);
  });

  it.each(NAMES)("%s starts softly enough not to click", (name) => {
    for (const voice of SOUNDS[name]) {
      expect(voice.attack).toBeGreaterThanOrEqual(0.002);
      expect(voice.decay).toBeGreaterThan(0.01);
    }
  });

  it.each(NAMES)("%s cannot clip, even with every voice at its peak at once", (name) => {
    const all = SOUNDS[name].reduce((sum, voice) => sum + voice.gain, 0);
    expect(all).toBeLessThan(0.75);
  });

  it("are short: nothing rings over a voice on a call", () => {
    for (const name of NAMES) expect(soundLength(name)).toBeLessThan(1.2);
    expect(soundLength("card")).toBeLessThan(0.15);
    expect(soundLength("flip")).toBeLessThan(0.1);
    expect(soundLength("tick")).toBeLessThan(0.1);
  });

  it("keep the card, the flip and the tick quieter than the two moments that matter", () => {
    const peak = (name: SoundName) => Math.max(...SOUNDS[name].map((voice) => voice.gain));
    expect(peak("tick")).toBeLessThan(peak("reveal"));
    expect(peak("consensus")).toBeLessThanOrEqual(peak("reveal"));
  });
});
