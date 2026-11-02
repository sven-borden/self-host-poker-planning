import { describe, expect, it } from "vitest";
import { COMPOSITIONS, frequency, LOOP_SECONDS } from "./music-moods.ts";
import { leadSeconds, placeNotes } from "./music-render.ts";
import { MOODS } from "./sound-prefs.ts";

// The moods as data. What they render to, the seam and the peak included, is checked on the
// real buffers in a real browser: e2e/sound.spec.ts.

const pieces = Object.entries(COMPOSITIONS);

describe("the moods", () => {
  it("has a composition for every mood the panel offers", () => {
    expect(Object.keys(COMPOSITIONS).sort()).toEqual([...MOODS].sort());
  });

  it.each(pieces)("%s lasts the loop, on the beat", (_, piece) => {
    expect((piece.beats * 60) / piece.bpm).toBe(LOOP_SECONDS);
  });

  it.each(pieces)("%s keeps every note inside the loop", (_, piece) => {
    for (const { notes } of piece.parts) {
      for (const note of notes) {
        expect(note.at).toBeGreaterThanOrEqual(0);
        expect(note.at).toBeLessThan(piece.beats);
        expect(Math.abs(note.pan)).toBeLessThanOrEqual(1);
        expect(note.gain).toBeGreaterThan(0);
      }
    }
  });

  it.each(pieces)("%s rises from silence, so that no note clicks", (_, piece) => {
    for (const { tone } of piece.parts) {
      expect(tone.attack).toBeGreaterThan(0);
      expect(tone.release).toBeGreaterThan(0);
    }
  });

  it.each(pieces)("%s strikes nothing on the seam itself", (_, piece) => {
    const first = Math.min(
      ...piece.parts.flatMap(({ tone, notes }) =>
        tone.attack < 1 ? notes.map((note) => note.at) : [],
      ),
    );
    expect(first).toBeGreaterThan(0);
  });
});

describe("frequency", () => {
  it("reads a pitch as a musician does", () => {
    expect(frequency("A4")).toBe(440);
    expect(frequency("A3")).toBe(220);
    expect(frequency("C4")).toBeCloseTo(261.63, 2);
    expect(frequency("F#3")).toBeCloseTo(185, 0);
  });

  it("refuses what is not a pitch", () => {
    expect(() => frequency("H2")).toThrow();
    expect(() => frequency("")).toThrow();
  });
});

describe("the lead-in", () => {
  it.each(pieces)("%s is a whole number of seconds, shorter than the loop", (_, piece) => {
    const lead = leadSeconds(piece);
    expect(Number.isInteger(lead)).toBe(true);
    expect(lead).toBeLessThan(LOOP_SECONDS);
  });

  it.each(pieces)("%s plays every note once in the loop", (_, piece) => {
    const lead = leadSeconds(piece);
    const notes = piece.parts.reduce((sum, { notes }) => sum + notes.length, 0);
    expect(placeNotes(piece).filter(({ from }) => from >= lead)).toHaveLength(notes);
  });

  it.each(pieces)("%s plays again, before the loop, all that rings across its end", (_, piece) => {
    const lead = leadSeconds(piece);
    const beat = 60 / piece.bpm;
    const before = placeNotes(piece).filter(({ from }) => from < lead);
    // A note is copied exactly when it starts within a lead-in of the end, one loop earlier.
    for (const { part } of piece.parts.map((part) => ({ part }))) {
      for (const note of part.notes) {
        const copied = before.some((placed) => placed.note === note);
        expect(copied).toBe(note.at * beat + lead > LOOP_SECONDS);
      }
    }
    for (const { note, from } of before) {
      expect(from).toBeCloseTo(lead + note.at * beat - LOOP_SECONDS, 9);
      expect(from).toBeGreaterThanOrEqual(0);
    }
  });
});
