import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { audioContext, FakeAudioContext, fakeAudio } from "./fake-audio.ts";
import {
  hush,
  play,
  preview,
  setVolume,
  shut,
  soundRunning,
  subscribeSound,
  unlock,
} from "./sound-engine.ts";
import { SOUNDS } from "./sound-recipes.ts";

/** Lets a `resume` promise settle. */
const settled = () => new Promise((resolve) => setTimeout(resolve));

async function running() {
  unlock();
  await settled();
  return audioContext();
}

describe("the sound engine", () => {
  beforeEach(() => {
    fakeAudio();
    setVolume(1);
  });
  afterEach(() => {
    shut();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("makes no context before a gesture, and playing makes none", () => {
    play("reveal");
    expect(FakeAudioContext.made).toEqual([]);
    expect(soundRunning()).toBe(false);
  });

  it("drops a sound while the context waits, and never plays it later", async () => {
    FakeAudioContext.refuse = true;
    unlock();
    await settled();
    const audio = audioContext();
    expect(audio.state).toBe("suspended");
    play("reveal");
    expect(audio.sources).toEqual([]);

    FakeAudioContext.refuse = false;
    unlock();
    await settled();
    expect(soundRunning()).toBe(true);
    expect(audio.sources).toEqual([]);
  });

  it("does not take a key a browser does not count for a gesture", () => {
    vi.stubGlobal("navigator", { userActivation: { hasBeenActive: false } });
    unlock();
    expect(FakeAudioContext.made).toEqual([]);
    vi.stubGlobal("navigator", { userActivation: { hasBeenActive: true } });
    unlock();
    expect(FakeAudioContext.made).toHaveLength(1);
  });

  it("schedules each voice from silence, on the audio clock", async () => {
    const audio = await running();
    audio.currentTime = 20;
    play("tick", 1500, 300);
    const [source] = audio.sources;
    expect(source?.start).toHaveBeenCalledWith(21.5);
    expect(source?.detune.value).toBe(300);
    // The first gain is the master's, the next the voice's envelope.
    const envelope = audio.gains[1]?.gain;
    expect(envelope?.setValueAtTime).toHaveBeenCalledWith(0.0001, 21.5);
    const voice = SOUNDS.tick[0];
    expect(envelope?.linearRampToValueAtTime).toHaveBeenCalledWith(voice?.gain, 21.502);
    expect(envelope?.exponentialRampToValueAtTime.mock.calls[0]?.[0]).toBe(0.0001);
    expect(source?.stop.mock.calls[0]?.[0]).toBeCloseTo(21.552);
  });

  it("makes one buffer of noise for a whole riffle", async () => {
    const audio = await running();
    for (let i = 0; i < 16; i += 1) play("flip", i * 90);
    expect(audio.buffers).toBe(1);
    expect(audio.sources).toHaveLength(16);
  });

  it("takes back the voices to come and lets a ringing one finish", async () => {
    const audio = await running();
    play("tick");
    play("tick", 2000);
    audio.currentTime += 0.01;
    const [ringing, coming] = audio.sources;
    hush();
    expect(coming?.stop).toHaveBeenCalledWith();
    expect(ringing?.stop).toHaveBeenCalledTimes(1);
    expect(ringing?.disconnect).not.toHaveBeenCalled();
  });

  it("frees a voice once it has ended", async () => {
    const audio = await running();
    play("tick", 1000);
    audio.sources[0]?.onended?.();
    audio.currentTime = 0;
    hush();
    expect(audio.sources[0]?.stop).toHaveBeenCalledTimes(1);
    expect(audio.gains[1]?.disconnect).toHaveBeenCalledTimes(1);
  });

  it("follows the volume's square, smoothly", async () => {
    setVolume(0.5);
    const audio = await running();
    expect(audio.gains[0]?.gain.value).toBe(0.25);
    setVolume(0.2);
    expect(audio.gains[0]?.gain.setTargetAtTime.mock.calls[0]?.[0]).toBeCloseTo(0.04);
  });

  it("previews as soon as the context runs, inside the gesture that started it", async () => {
    preview();
    const audio = audioContext();
    await settled();
    expect(audio.sources.length).toBe(SOUNDS.card.length);
  });

  it("tells its listeners when it starts and when it shuts", async () => {
    const heard = vi.fn();
    const stop = subscribeSound(heard);
    await running();
    expect(heard).toHaveBeenCalledTimes(1);
    shut();
    expect(heard).toHaveBeenCalledTimes(2);
    stop();
  });

  it("gives the device back when it shuts, and starts afresh", async () => {
    const first = await running();
    shut();
    expect(first.closed).toBe(true);
    expect(soundRunning()).toBe(false);
    const second = await running();
    expect(second).not.toBe(first);
    expect(soundRunning()).toBe(true);
  });

  it("does nothing where there is no Web Audio", () => {
    vi.stubGlobal("AudioContext", undefined);
    expect(() => unlock()).not.toThrow();
    expect(soundRunning()).toBe(false);
  });
});
