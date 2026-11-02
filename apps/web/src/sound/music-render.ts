import {
  COMPOSITIONS,
  type Composition,
  frequency,
  LOOP_SECONDS,
  type Note,
  type Part,
  type Tone,
} from "./music-moods.ts";
import type { Mood } from "./sound-prefs.ts";

// Rendering a mood once into a buffer (#45, ADR-021), which then only has to be read back in
// a circle: a sample-exact loop and next to no work while it plays. `OfflineAudioContext`
// does the rendering on a thread of its own, faster than real time, and it makes no sound,
// so the gesture rule does not reach it.
//
// A loop's seam is the whole difficulty. What rings past the end must also sound at the
// start, or the music drops there; what is in the room at the end must be there at the
// start, or it clicks. So the render starts with a lead-in, as long as anything can ring:
// the loop's own last bars, played before it begins. Everything that rings across the
// seam is then already ringing when the kept part starts, in the same state as at its end.
//
// The rendering itself is off the main thread; setting it up is not, and the first gesture
// after a reload may be the one that reveals. So the set-up hands the thread back as it goes
// (ADR-019): no stretch of it may reach 50 ms on a mid-range phone.

/**
 * The rate every loop is rendered at, whatever the device runs at: half the time to wait and
 * half the memory of 48 kHz, for music with nothing above 6 kHz, and the same numbers for
 * everyone. The source node converts it as it plays.
 */
const LOOP_RATE = 24_000;
/** Where an envelope starts and ends: an exponential ramp cannot reach 0. */
const SILENCE = 0.0001;
/** How long the room rings, in seconds: down by 60 dB at its end. */
const ROOM_SECONDS = 3.2;
/** How much of the room's noise each sample takes: lower is darker. */
const ROOM_BRIGHTNESS = 0.16;
const ROOM_DECAY = Math.log(1000);
/** How many of the room's samples to work out between two looks at the clock. */
const ROOM_BLOCK = 4096;
/** How long the set-up holds the main thread before it lets the page go on, in ms. */
const SLICE_MS = 8;

const beatSeconds = (piece: Composition) => 60 / piece.bpm;

/** How long a note sounds, from its first sample to its last, in seconds. */
const noteSeconds = (piece: Composition, tone: Tone, note: Note) =>
  tone.attack + note.hold * beatSeconds(piece) + tone.release;

/** How long the lead-in is: the longest a note can ring, and the room after it. */
export function leadSeconds(piece: Composition) {
  const longest = piece.parts.flatMap(({ tone, notes }) =>
    notes.map((note) => noteSeconds(piece, tone, note)),
  );
  return Math.ceil(Math.max(...longest) + ROOM_SECONDS);
}

export interface Placed {
  part: Part;
  note: Note;
  /** When it starts, in seconds from the start of the render. */
  from: number;
}

/** Every note once, after the lead-in, and the ones that may ring across the seam also in it. */
export function placeNotes(piece: Composition): Placed[] {
  const lead = leadSeconds(piece);
  const beat = beatSeconds(piece);
  return piece.parts.flatMap((part) =>
    part.notes.flatMap((note) => {
      const start = note.at * beat;
      const placed = { part, note, from: lead + start };
      if (start + lead <= LOOP_SECONDS) return [placed];
      return [placed, { part, note, from: lead + start - LOOP_SECONDS }];
    }),
  );
}

/** Lets the page go on. A message rather than a timer: a hidden tab holds its timers back. */
const nextTask = () =>
  new Promise<void>((resolve) => {
    const { port1, port2 } = new MessageChannel();
    port1.onmessage = () => {
      port1.close();
      resolve();
    };
    port2.postMessage(null);
  });

/** Runs `work` on each item, letting the page go on each time a slice is spent. */
async function inSlices<T>(items: readonly T[], work: (item: T) => void) {
  await nextTask();
  let began = performance.now();
  for (const item of items) {
    work(item);
    if (performance.now() - began < SLICE_MS) continue;
    await nextTask();
    began = performance.now();
  }
}

/** A small random generator with a seed, so that a mood renders the same for everyone. */
function noise(seed: number) {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return (((mixed ^ (mixed >>> 14)) >>> 0) / 2 ** 32) * 2 - 1;
  };
}

/** A soft, dark room: darkened noise dying away, different in each ear. */
async function roomOf(offline: OfflineAudioContext, out: AudioNode) {
  const { sampleRate } = offline;
  const impulse = offline.createBuffer(2, Math.ceil(ROOM_SECONDS * sampleRate), sampleRate);
  const blocks = Array.from({ length: Math.ceil(impulse.length / ROOM_BLOCK) }, (_, i) => i);
  for (let channel = 0; channel < 2; channel += 1) {
    const samples = impulse.getChannelData(channel);
    const random = noise(45 + channel);
    let dark = 0;
    await inSlices(blocks, (block) => {
      const end = Math.min((block + 1) * ROOM_BLOCK, samples.length);
      for (let i = block * ROOM_BLOCK; i < end; i += 1) {
        dark += (random() - dark) * ROOM_BRIGHTNESS;
        samples[i] = dark * Math.exp((-ROOM_DECAY * i) / samples.length);
      }
    });
  }
  // The one step that cannot be cut: it prepares the convolution, so it has a task to itself.
  await nextTask();
  const convolver = offline.createConvolver();
  convolver.buffer = impulse;
  convolver.connect(out);
  return convolver;
}

function waveOf(offline: OfflineAudioContext, tone: Tone) {
  const strengths = [0, ...tone.harmonics];
  return offline.createPeriodicWave(
    new Float32Array(strengths.length),
    Float32Array.from(strengths),
  );
}

/** One note, from silence to its peak and back: never a click at either end. */
function sing(
  offline: OfflineAudioContext,
  { from, note, part: { tone } }: Placed,
  wave: PeriodicWave,
  beat: number,
  out: AudioNode,
) {
  const peak = from + tone.attack;
  const falls = peak + note.hold * beat;
  const end = falls + tone.release;
  const envelope = offline.createGain();
  envelope.gain.setValueAtTime(SILENCE, from);
  envelope.gain.linearRampToValueAtTime(note.gain, peak);
  if (note.hold > 0) {
    // In a straight line, so that a chord dying under the next one leaves no hole.
    envelope.gain.setValueAtTime(note.gain, falls);
    envelope.gain.linearRampToValueAtTime(SILENCE, end);
  } else {
    envelope.gain.exponentialRampToValueAtTime(SILENCE, end);
  }
  const panner = offline.createStereoPanner();
  panner.pan.value = note.pan;
  envelope.connect(panner).connect(out);
  const voices = tone.spread === 0 ? [0] : [-tone.spread / 2, tone.spread / 2];
  for (const detune of voices) {
    const oscillator = offline.createOscillator();
    oscillator.setPeriodicWave(wave);
    oscillator.frequency.value = frequency(note.pitch);
    oscillator.detune.value = detune;
    const strength = offline.createGain();
    strength.gain.value = 1 / voices.length;
    oscillator.connect(strength).connect(envelope);
    oscillator.start(from);
    oscillator.stop(end);
  }
}

/** A mood's loop as a buffer, as long as the loop to the sample. */
export async function renderLoop(mood: Mood) {
  const piece = COMPOSITIONS[mood];
  const lead = leadSeconds(piece) * LOOP_RATE;
  const frames = LOOP_SECONDS * LOOP_RATE;
  const offline = new OfflineAudioContext(2, lead + frames, LOOP_RATE);

  const out = offline.createGain();
  out.gain.value = piece.level;
  out.connect(offline.destination);
  const room = await roomOf(offline, out);

  const inputs = new Map<Part, { lowpass: BiquadFilterNode; wave: PeriodicWave }>();
  await inSlices(piece.parts, (part) => {
    const lowpass = offline.createBiquadFilter();
    lowpass.type = "lowpass";
    lowpass.frequency.value = part.tone.cutoff;
    lowpass.Q.value = 0.3;
    const dry = offline.createGain();
    dry.gain.value = 1 - part.tone.wet;
    const wet = offline.createGain();
    wet.gain.value = part.tone.wet;
    lowpass.connect(dry).connect(out);
    lowpass.connect(wet).connect(room);
    inputs.set(part, { lowpass, wave: waveOf(offline, part.tone) });
  });
  await inSlices(placeNotes(piece), (placed) => {
    const input = inputs.get(placed.part);
    if (input) sing(offline, placed, input.wave, beatSeconds(piece), input.lowpass);
  });

  await nextTask();
  const rendered = await offline.startRendering();
  const loop = offline.createBuffer(2, frames, LOOP_RATE);
  for (let channel = 0; channel < 2; channel += 1) {
    loop.copyToChannel(rendered.getChannelData(channel).subarray(lead, lead + frames), channel);
  }
  return loop;
}
