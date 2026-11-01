import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { audioContext, FakeAudioContext, fakeAudio } from "./fake-audio.ts";
import {
  endLoop,
  hush,
  LOOP_FALL,
  play,
  preview,
  release,
  setVolume,
  shut,
  soundRunning,
  startLoop,
  subscribeSound,
  unlock,
} from "./sound-engine.ts";
import { SOUNDS } from "./sound-recipes.ts";

/** A loop of 48 seconds, as far as the engine can tell. */
const buffer = () => ({ duration: 48 }) as AudioBuffer;

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

  describe("the music's loop", () => {
    /** The first gain is the master's; each loop adds its fade. */
    const fadeOf = (audio: FakeAudioContext, nth = 0) => audio.gains[nth + 1]?.gain;

    it("drops a loop unless the context runs", async () => {
      startLoop(buffer());
      expect(FakeAudioContext.made).toEqual([]);

      FakeAudioContext.refuse = true;
      unlock();
      await settled();
      startLoop(buffer());
      expect(audioContext().sources).toEqual([]);
    });

    it("loops the buffer and rises from nothing", async () => {
      const audio = await running();
      audio.currentTime = 20;
      const loop = buffer();
      startLoop(loop);
      const [source] = audio.sources;
      expect(source?.buffer).toBe(loop);
      expect(source?.loop).toBe(true);
      expect(source?.start).toHaveBeenCalledWith(20, 0);
      const fade = fadeOf(audio);
      expect(fade?.setValueAtTime).toHaveBeenCalledWith(0, 20);
      expect(fade?.setTargetAtTime).toHaveBeenCalledWith(1, 20, 0.5);
    });

    it("leaves a loop that is already playing alone", async () => {
      const audio = await running();
      const loop = buffer();
      startLoop(loop);
      startLoop(loop);
      expect(audio.sources).toHaveLength(1);
    });

    it("falls away and only then stops, never at once", async () => {
      const audio = await running();
      startLoop(buffer());
      audio.currentTime = 30;
      endLoop();
      const [source] = audio.sources;
      expect(fadeOf(audio)?.setTargetAtTime).toHaveBeenLastCalledWith(0, 30, LOOP_FALL / 4);
      expect(source?.stop).toHaveBeenCalledTimes(1);
      expect(source?.stop.mock.calls[0]?.[0]).toBeCloseTo(30 + 2 * LOOP_FALL);
      expect(source?.disconnect).not.toHaveBeenCalled();
      source?.onended?.();
      expect(audio.gains[1]?.disconnect).toHaveBeenCalledTimes(1);
    });

    it("goes on where it stopped, around the loop", async () => {
      const audio = await running();
      const loop = buffer();
      startLoop(loop);
      audio.currentTime += 50;
      endLoop();
      audio.currentTime += 5;
      startLoop(loop);
      const [, second] = audio.sources;
      expect(second?.start.mock.calls[0]?.[1]).toBeCloseTo(2);
    });

    it("fades one loop under the next", async () => {
      const audio = await running();
      startLoop(buffer());
      startLoop(buffer());
      const [first, second] = audio.sources;
      expect(first?.stop).toHaveBeenCalledTimes(1);
      expect(second?.stop).not.toHaveBeenCalled();
      expect(fadeOf(audio, 1)?.setValueAtTime).toHaveBeenCalledWith(0, audio.currentTime);
    });

    it("is out of a hush's reach", async () => {
      const audio = await running();
      startLoop(buffer());
      hush();
      expect(audio.sources[0]?.stop).not.toHaveBeenCalled();
    });

    it("keeps the context until the music has fallen away", async () => {
      const audio = await running();
      startLoop(buffer());
      release();
      expect(audio.closed).toBe(false);
      audio.sources[0]?.onended?.();
      expect(audio.closed).toBe(true);
    });

    it("waits for every loop still falling away", async () => {
      const audio = await running();
      startLoop(buffer());
      startLoop(buffer());
      release();
      audio.sources[1]?.onended?.();
      expect(audio.closed).toBe(false);
      audio.sources[0]?.onended?.();
      expect(audio.closed).toBe(true);
    });

    it("stays when the sound is wanted again before the music has fallen away", async () => {
      const audio = await running();
      startLoop(buffer());
      release();
      unlock();
      audio.sources[0]?.onended?.();
      expect(audio.closed).toBe(false);
      expect(soundRunning()).toBe(true);
    });

    it("shuts at once with no music to wait for", async () => {
      const audio = await running();
      release();
      expect(audio.closed).toBe(true);
    });

    it("does not wait on a suspended context, which ends nothing", async () => {
      const audio = await running();
      startLoop(buffer());
      audio.state = "suspended";
      release();
      expect(audio.closed).toBe(true);
    });
  });

  it("does nothing where there is no Web Audio", () => {
    vi.stubGlobal("AudioContext", undefined);
    expect(() => unlock()).not.toThrow();
    expect(soundRunning()).toBe(false);
  });
});
