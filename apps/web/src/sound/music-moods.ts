import type { Mood } from "./sound-prefs.ts";

// The background music (#45, ADR-021), as data: three original loops, written here note by
// note, with no sample and nothing to license. `music-render.ts` plays each once into a
// buffer. A wait, not a song: slow chords and a few soft notes far apart, every mood in one
// key, nothing that asks to be listened to. Each lasts 48 seconds. This file and
// `music-render.ts` are a chunk of their own, loaded only when someone turns the music on.

/** How one kind of note is made. */
export interface Tone {
  /** How strong each harmonic is, the fundamental first. */
  harmonics: readonly number[];
  /** Two oscillators this many cents apart, beating slowly; 0 for one. */
  spread: number;
  /** Seconds to rise from silence: never 0, or the note starts with a click. */
  attack: number;
  /** Seconds to die away, after its `hold`. */
  release: number;
  /** A low-pass over the whole part, in Hz: keeps it dark, and clear of a voice on a call. */
  cutoff: number;
  /** How much of it goes into the room, from 0 to 1. */
  wet: number;
}

export interface Note {
  /** When it starts, in beats from the top of the loop. */
  at: number;
  /** "F#3": a name, as a musician would read the page. */
  pitch: string;
  /** Beats held at full strength before it dies away; 0 for a struck note. */
  hold: number;
  /** How strong, before the mood's `level`. */
  gain: number;
  /** Left of centre below 0, right above it, from -1 to 1. */
  pan: number;
}

export interface Part {
  tone: Tone;
  notes: readonly Note[];
}

export interface Composition {
  bpm: number;
  /** How long the loop is, in beats. */
  beats: number;
  /**
   * Scales the whole mood. It brings its loudest sample to about 0.095 at full volume, under
   * the quietest sound effect's peak (the tick's 0.11), with `e2e/sound.spec.ts` watching.
   */
  level: number;
  parts: readonly Part[];
}

/** Every loop's length: three moods of one size, a whole number of samples at any rate. */
export const LOOP_SECONDS = 48;

/** A long, soft chord, rising for seconds: the floor of every mood. */
const PAD: Tone = {
  harmonics: [1, 0.32, 0.1, 0.04],
  spread: 6,
  attack: 3,
  release: 6,
  cutoff: 900,
  wet: 0.35,
};

/** Under the chord, felt more than heard. */
const LOW: Tone = {
  harmonics: [1, 0.22],
  spread: 3,
  attack: 3,
  release: 6,
  cutoff: 320,
  wet: 0.15,
};

/** A felt-covered hammer on a low string, a long way off. */
const FELT: Tone = {
  harmonics: [1, 0.42, 0.16, 0.06, 0.02],
  spread: 2,
  attack: 0.025,
  release: 3.6,
  cutoff: 1500,
  wet: 0.55,
};

/** A struck glass, above the swell: little more than its pitch. */
const GLASS: Tone = {
  harmonics: [1, 0, 0.14, 0, 0.04],
  spread: 0,
  attack: 0.04,
  release: 4.5,
  cutoff: 2600,
  wet: 0.8,
};

/** A slower floor, each chord a wave that comes in and goes out. */
const SWELL: Tone = {
  ...PAD,
  harmonics: [1, 0.2, 0.07],
  attack: 5.5,
  release: 8,
  wet: 0.45,
};

/** The notes of a chord spread across the width, the lowest on the left. */
function chord(at: number, hold: number, pitches: readonly string[], gain: number): Note[] {
  const last = Math.max(1, pitches.length - 1);
  return pitches.map((pitch, index) => ({
    at,
    pitch,
    hold,
    gain,
    pan: pitches.length === 1 ? 0 : -0.45 + (0.9 * index) / last,
  }));
}

/** Struck notes, each given as [beat, pitch]; they wander a little across the width. */
function struck(notes: ReadonlyArray<readonly [number, string]>, gain: number): Note[] {
  return notes.map(([at, pitch], index) => ({
    at,
    pitch,
    hold: 0,
    gain: gain * (index % 3 === 1 ? 0.8 : 1),
    pan: [-0.25, 0.3, 0.05, -0.1, 0.2][index % 5] ?? 0,
  }));
}

/** Dusk: D major, a chord every twelve seconds, and a line that hardly moves. */
const DUSK: Composition = {
  bpm: 60,
  beats: 48,
  level: 0.086,
  parts: [
    {
      tone: PAD,
      notes: [
        ...chord(0, 8, ["A2", "F#3", "C#4", "E4"], 0.3),
        ...chord(12, 8, ["F#2", "D3", "A3", "C#4"], 0.3),
        ...chord(24, 8, ["D3", "F#3", "B3", "E4"], 0.3),
        ...chord(36, 8, ["E3", "G3", "B3", "D4"], 0.3),
      ],
    },
    {
      tone: LOW,
      notes: [
        ...chord(0, 8, ["D2"], 0.5),
        ...chord(12, 8, ["B1"], 0.5),
        ...chord(24, 8, ["G1"], 0.5),
        ...chord(36, 8, ["A1"], 0.5),
      ],
    },
    {
      tone: FELT,
      notes: struck(
        [
          [3, "E5"],
          [6.5, "C#5"],
          [9, "A4"],
          [15, "D5"],
          [18, "F#4"],
          [19.5, "A4"],
          [27, "B4"],
          [30, "D5"],
          [33, "E5"],
          [39, "D5"],
          [42.5, "B4"],
          [45, "A4"],
        ],
        0.34,
      ),
    },
  ],
};

/** Tide: F with a raised fourth, open chords that swell, and glass above the water. */
const TIDE: Composition = {
  bpm: 40,
  beats: 32,
  level: 0.084,
  parts: [
    {
      tone: SWELL,
      notes: [
        ...chord(0, 3, ["F2", "C3", "G3", "A3"], 0.32),
        ...chord(8, 3, ["F2", "D3", "G3", "B3"], 0.32),
        ...chord(16, 3, ["E2", "C3", "G3", "A3"], 0.32),
        ...chord(24, 3, ["G2", "D3", "G3", "C4"], 0.32),
      ],
    },
    {
      tone: LOW,
      notes: [
        ...chord(0, 3, ["F1"], 0.42),
        ...chord(16, 3, ["E1"], 0.42),
        ...chord(24, 3, ["G1"], 0.42),
      ],
    },
    {
      tone: GLASS,
      notes: struck(
        [
          [2, "A5"],
          [5.5, "G5"],
          [10, "B5"],
          [13, "D5"],
          [18, "C6"],
          [21.5, "A5"],
          [26, "D6"],
          [29.5, "G5"],
        ],
        0.2,
      ),
    },
  ],
};

/** Embers: A with a raised sixth, the same three-note figure turning, over a low hum. */
const EMBERS: Composition = {
  bpm: 50,
  beats: 40,
  level: 0.112,
  parts: [
    {
      tone: LOW,
      notes: [...chord(0, 13, ["A1", "E2"], 0.34), ...chord(20, 13, ["D2", "A2"], 0.34)],
    },
    {
      tone: PAD,
      notes: [
        ...chord(2, 6, ["E3", "A3"], 0.14),
        ...chord(12, 6, ["D3", "F#3"], 0.14),
        ...chord(22, 6, ["E3", "G3"], 0.14),
        ...chord(32, 6, ["D3", "A3"], 0.14),
      ],
    },
    {
      tone: FELT,
      notes: struck(
        [
          [0.5, "A3"],
          [1.5, "E4"],
          [3, "C5"],
          [5.5, "G3"],
          [6.5, "D4"],
          [8, "B4"],
          [10.5, "F#3"],
          [11.5, "D4"],
          [13, "A4"],
          [15.5, "E3"],
          [16.5, "B3"],
          [18, "G4"],
          [20.5, "A3"],
          [21.5, "E4"],
          [23, "C5"],
          [24.5, "E5"],
          [25.5, "G3"],
          [26.5, "D4"],
          [28, "A4"],
          [30.5, "D3"],
          [31.5, "A3"],
          [33, "F#4"],
          [35.5, "E3"],
          [36.5, "B3"],
          [38, "D4"],
        ],
        0.34,
      ),
    },
  ],
};

export const COMPOSITIONS: Record<Mood, Composition> = { dusk: DUSK, tide: TIDE, embers: EMBERS };

const SEMITONES: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

/** "A4" is 440 Hz, "F#3" 185 Hz. */
export function frequency(pitch: string) {
  const [, name = "", sharp, octave = ""] = /^([A-G])(#?)(\d)$/.exec(pitch) ?? [];
  const semitone = SEMITONES[name];
  if (semitone === undefined) throw new Error(`not a pitch: ${pitch}`);
  const fromA4 = semitone + (sharp ? 1 : 0) + (Number(octave) - 4) * 12 - 9;
  return 440 * 2 ** (fromA4 / 12);
}
