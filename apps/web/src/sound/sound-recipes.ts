// The five sounds (#44; docs/03-design-brief.md, "Sound"), as data: no samples, no files,
// nothing to license. Each is a few short voices that `sound-engine.ts` plays with the Web
// Audio API. Felt and wood, as the table looks: nothing here rings for long or fights a
// voice on a call. `sound-recipes.test.ts` keeps them from clicking or clipping.

export type SoundName = "card" | "flip" | "reveal" | "consensus" | "tick";

export interface Voice {
  /** A tone, or noise through a band around `frequency`. */
  wave: "sine" | "noise";
  /** When it starts, in seconds after the sound does. */
  at: number;
  /** The tone's pitch, or the centre of the noise's band, in Hz. */
  frequency: number;
  /** A tone falls to this pitch as it dies away: a thud rather than a note. */
  glideTo?: number;
  /** How narrow the noise's band is. */
  q?: number;
  /** How loud at its peak, from 0 to 1, at full volume. */
  gain: number;
  /** Seconds to reach the peak: never 0, or the voice starts with a click. */
  attack: number;
  /** Seconds to die away from the peak. */
  decay: number;
}

/** A soft mallet: the note, and its fourth harmonic, the strike, gone almost at once. */
const mallet = (at: number, frequency: number, gain: number, decay: number): Voice[] => [
  { wave: "sine", at, frequency, gain, attack: 0.004, decay },
  { wave: "sine", at, frequency: frequency * 4, gain: gain * 0.2, attack: 0.002, decay: 0.07 },
];

export const SOUNDS: Record<SoundName, readonly Voice[]> = {
  /** A card put down on felt: a low thud and a little of the card's edge. */
  card: [
    { wave: "sine", at: 0, frequency: 170, glideTo: 100, gain: 0.26, attack: 0.002, decay: 0.09 },
    { wave: "noise", at: 0, frequency: 1800, q: 0.8, gain: 0.22, attack: 0.002, decay: 0.05 },
  ],
  /** A card turning over: air, no pitch, so sixteen of them are a riffle and not a tune. */
  flip: [{ wave: "noise", at: 0, frequency: 3400, q: 1, gain: 0.24, attack: 0.004, decay: 0.05 }],
  /** The reveal: two notes rising, A and E, so a person looking elsewhere looks back. */
  reveal: [...mallet(0, 440, 0.2, 0.5), ...mallet(0.11, 659.25, 0.18, 0.6)],
  /** Everyone agreed: the reveal's question answered, a C major chord broken upwards. */
  consensus: [
    ...mallet(0, 523.25, 0.14, 0.6),
    ...mallet(0.09, 659.25, 0.13, 0.6),
    ...mallet(0.18, 783.99, 0.12, 0.7),
    ...mallet(0.27, 1046.5, 0.11, 0.9),
  ],
  /** One of the timer's last seconds: a wood block, far from the mallets' pitch. */
  tick: [{ wave: "sine", at: 0, frequency: 1040, gain: 0.11, attack: 0.002, decay: 0.05 }],
};

/** How long a sound lasts, in seconds. */
export const soundLength = (name: SoundName) =>
  Math.max(...SOUNDS[name].map((voice) => voice.at + voice.attack + voice.decay));
