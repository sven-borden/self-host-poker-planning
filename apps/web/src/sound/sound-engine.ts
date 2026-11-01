import { SOUNDS, type SoundName, type Voice } from "./sound-recipes.ts";

// Playing the sounds (#44, ADR-020), with the Web Audio API alone: oscillators and a short
// buffer of noise, so no file, no `media-src` and no worklet for the CSP to allow.
//
// One rule holds everything up: no sound before a gesture. The context is made in a
// gesture's handler (`unlock`), never at load, and `play` drops a sound unless the context
// runs. Nothing waits for a gesture: a reveal missed before the first click stays missed.

/** Where an envelope starts and ends: an exponential ramp cannot reach 0. */
const SILENCE = 0.0001;
const NOISE_SECONDS = 0.25;
/** How long the volume takes to settle, so a slider's steps do not crackle. */
const VOLUME_SMOOTHING = 0.01;

interface Sounding {
  from: number;
  source: AudioScheduledSourceNode;
  envelope: GainNode;
}

let context: AudioContext | null = null;
let master: GainNode | null = null;
let noise: AudioBuffer | null = null;
let volume = 1;
const sounding = new Set<Sounding>();
const listeners = new Set<() => void>();

const notify = () => {
  for (const listener of listeners) listener();
};

/** The slider's middle should sound like the middle: loudness follows the square. */
const level = (value: number) => value * value;

/** Whether sounds can be heard now: the context runs, so a gesture has unlocked it. */
export const soundRunning = () => context?.state === "running";

/** Calls `listener` when the context starts or stops; returns how to stop listening. */
export function subscribeSound(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Starts the sound: only ever from a gesture's handler, in its call stack, as Safari asks.
 * Escape is no gesture to a browser: such a key leaves the page as it was.
 */
export function unlock() {
  if (soundRunning() || typeof AudioContext === "undefined") return;
  if (navigator.userActivation?.hasBeenActive === false) return;
  if (context === null) {
    context = new AudioContext();
    master = context.createGain();
    master.gain.value = level(volume);
    master.connect(context.destination);
    context.addEventListener("statechange", notify);
  }
  // Refused, or a phone call holds the audio: the next gesture asks again.
  context.resume().catch(() => {});
}

/** Plays a sound `afterMs` from now, `detune` cents off its pitch, or drops it. */
export function play(name: SoundName, afterMs = 0, detune = 0) {
  if (context === null || master === null || context.state !== "running") return;
  const start = context.currentTime + afterMs / 1000;
  for (const voice of SOUNDS[name]) sing(context, master, voice, start, detune);
}

/** A person's own test of the sound: played as soon as the context, just unlocked, runs. */
export function preview() {
  unlock();
  context?.resume().then(
    () => play("card"),
    () => {},
  );
}

/** Voices still to come never start; what is ringing rings out, without a click. */
export function hush() {
  if (context === null) return;
  const now = context.currentTime;
  for (const voice of sounding) {
    if (voice.from <= now) continue;
    voice.source.onended = null;
    voice.source.stop();
    voice.envelope.disconnect();
    sounding.delete(voice);
  }
}

export function setVolume(value: number) {
  volume = value;
  if (context !== null && master !== null) {
    master.gain.setTargetAtTime(level(value), context.currentTime, VOLUME_SMOOTHING);
  }
}

/** Ends the sound and gives the audio device back. The next `unlock` makes a new context. */
export function shut() {
  if (context === null) return;
  const closing = context;
  context = null;
  master = null;
  noise = null;
  sounding.clear();
  closing.removeEventListener("statechange", notify);
  closing.close().catch(() => {});
  notify();
}

/** One buffer of white noise per context: each voice starts somewhere else in it. */
function noiseOf(audio: AudioContext) {
  if (noise === null) {
    noise = audio.createBuffer(1, Math.ceil(audio.sampleRate * NOISE_SECONDS), audio.sampleRate);
    const samples = noise.getChannelData(0);
    for (let i = 0; i < samples.length; i += 1) samples[i] = Math.random() * 2 - 1;
  }
  return noise;
}

function tone(audio: AudioContext, voice: Voice, from: number, end: number, detune: number) {
  const oscillator = audio.createOscillator();
  oscillator.frequency.setValueAtTime(voice.frequency, from);
  if (voice.glideTo !== undefined) {
    oscillator.frequency.exponentialRampToValueAtTime(voice.glideTo, end);
  }
  oscillator.detune.value = detune;
  oscillator.start(from);
  return { source: oscillator, out: oscillator };
}

function hiss(audio: AudioContext, voice: Voice, from: number, end: number, detune: number) {
  const band = audio.createBiquadFilter();
  band.type = "bandpass";
  band.frequency.value = voice.frequency;
  band.Q.value = voice.q ?? 1;
  band.detune.value = detune;
  const buffer = audio.createBufferSource();
  buffer.buffer = noiseOf(audio);
  buffer.connect(band);
  buffer.start(from, Math.random() * Math.max(0, NOISE_SECONDS - (end - from)));
  return { source: buffer, out: band };
}

/** One voice, from silence to its peak and back: never a click at either end. */
function sing(audio: AudioContext, out: AudioNode, voice: Voice, start: number, detune: number) {
  const from = start + voice.at;
  const peak = from + voice.attack;
  const end = peak + voice.decay;
  const envelope = audio.createGain();
  envelope.gain.setValueAtTime(SILENCE, from);
  envelope.gain.linearRampToValueAtTime(voice.gain, peak);
  envelope.gain.exponentialRampToValueAtTime(SILENCE, end);
  envelope.connect(out);
  const { source, out: sound } = (voice.wave === "noise" ? hiss : tone)(
    audio,
    voice,
    from,
    end,
    detune,
  );
  sound.connect(envelope);
  source.stop(end);
  const entry: Sounding = { from, source, envelope };
  sounding.add(entry);
  source.onended = () => {
    envelope.disconnect();
    sounding.delete(entry);
  };
}
