import { apply, type Command, createRoom, type RoomState } from "@pp/domain";
import { type Snapshot, toSnapshot } from "@pp/protocol";
import { describe, expect, it } from "vitest";
import {
  FADE_AWAY_MS,
  FLIP_MS,
  FLIP_STAGGER_MS,
  revealSettleMs,
  TRAVEL_MS,
} from "../table/reveal-motion.ts";
import { type Cue, LAST_SECONDS, soundCues, timerCues } from "./sound-cues.ts";

const CODE = "abcdefghij";

/** A room run through `apply`; each step gives the snapshot `me` gets, and the one before. */
function story() {
  let state: RoomState = createRoom({ ownerId: "me" });
  let version = 1;
  let last: Snapshot | null = null;
  const run = (actor: string, command: Command) => {
    const result = apply(state, command, { actor, now: 1000 + version });
    if (!result.ok) throw new Error(result.error);
    state = result.state;
    version += 1;
    const previous = last;
    last = toSnapshot(state, "me", { code: CODE, version, now: 0, causes: result.causes });
    return { next: last, previous };
  };
  /** The step's cues. */
  const cues = (actor: string, command: Command, reduced = false) => {
    const { next, previous } = run(actor, command);
    return soundCues(next.room, next.causes, previous?.room ?? null, reduced);
  };
  return { run, cues };
}

/** Me, Ana and Ben at the table, a round on. */
function seated() {
  const room = story();
  room.run("me", { type: "join", name: "Me", role: "voter" });
  room.run("ana", { type: "join", name: "Ana", role: "voter" });
  room.run("ben", { type: "join", name: "Ben", role: "voter" });
  room.run("me", { type: "updateSettings", patch: { revealWhenAllVoted: false } });
  room.run("me", { type: "startRound", subject: { kind: "none" } });
  return room;
}

const named = (cues: Cue[]) => cues.map((cue) => cue.sound);
const flips = (cues: Cue[]) => cues.filter((cue) => cue.sound === "flip");

describe("soundCues", () => {
  it("says nothing for a first snapshot: nothing happened on this page", () => {
    const room = seated();
    room.run("me", { type: "reveal" });
    const { next } = room.run("cleo", { type: "join", name: "Cleo", role: "voter" });
    expect(soundCues(next.room, next.causes, null, false)).toEqual([]);
  });

  it("places someone's first card as it lands, and never a changed one", () => {
    const room = seated();
    expect(room.cues("ana", { type: "castVote", card: "8" })).toEqual([
      { sound: "card", afterMs: 150, detune: 0 },
    ]);
    // Heard by others, a changed card would hint that something changed.
    expect(room.cues("ana", { type: "castVote", card: "13" })).toEqual([]);
  });

  it("places the viewer's own card at the end of its flight, each new card too", () => {
    const room = seated();
    expect(room.cues("me", { type: "castVote", card: "5" })).toEqual([
      { sound: "card", afterMs: TRAVEL_MS + 150, detune: 0 },
    ]);
    expect(named(room.cues("me", { type: "castVote", card: "8" }))).toEqual(["card"]);
  });

  it("places nothing when a card is taken back", () => {
    const room = seated();
    room.run("me", { type: "castVote", card: "5" });
    expect(room.cues("me", { type: "retractVote" })).toEqual([]);
  });

  it("does not wait for a flight or a drop under reduced motion", () => {
    const room = seated();
    expect(room.cues("me", { type: "castVote", card: "5" }, true)[0]?.afterMs).toBe(0);
    expect(room.cues("ana", { type: "castVote", card: "5" }, true)[0]?.afterMs).toBe(0);
  });

  it("turns each card in its place in the stagger, after the reveal's two notes", () => {
    const room = seated();
    room.run("me", { type: "castVote", card: "5" });
    room.run("ana", { type: "castVote", card: "8" });
    const cues = room.cues("me", { type: "reveal" });
    expect(cues[0]).toEqual({ sound: "reveal", afterMs: 0, detune: 0 });
    expect(flips(cues).map((cue) => cue.afterMs)).toEqual([85, 85 + FLIP_STAGGER_MS]);
    expect(new Set(flips(cues).map((cue) => cue.detune)).size).toBe(2);
    expect(named(cues)).not.toContain("consensus");
  });

  it("rings a consensus when the cards have settled, as the pill pops", () => {
    const room = seated();
    room.run("me", { type: "castVote", card: "5" });
    room.run("ana", { type: "castVote", card: "5" });
    room.run("ben", { type: "castVote", card: "5" });
    const cues = room.cues("me", { type: "reveal" });
    expect(cues.at(-1)).toEqual({
      sound: "consensus",
      afterMs: revealSettleMs(3, false),
      detune: 0,
    });
    expect(revealSettleMs(3, false)).toBe(FLIP_MS + 2 * FLIP_STAGGER_MS);
  });

  it("deals an anonymous round's cards once the seats' cards are gone", () => {
    const room = seated();
    room.run("me", { type: "updateSettings", patch: { revealNames: false } });
    room.run("me", { type: "startRound", subject: { kind: "none" } });
    room.run("me", { type: "castVote", card: "5" });
    room.run("ana", { type: "castVote", card: "5" });
    room.run("ben", { type: "castVote", card: "5" });
    const cues = room.cues("me", { type: "reveal" });
    expect(flips(cues).map((cue) => cue.afterMs)).toEqual([
      FADE_AWAY_MS,
      FADE_AWAY_MS + 70,
      FADE_AWAY_MS + 140,
    ]);
    expect(cues.at(-1)).toMatchObject({ sound: "consensus", afterMs: FADE_AWAY_MS });
  });

  it("turns nothing under reduced motion, and lets the two notes finish first", () => {
    const room = seated();
    room.run("me", { type: "castVote", card: "5" });
    room.run("ana", { type: "castVote", card: "5" });
    room.run("ben", { type: "castVote", card: "5" });
    const cues = room.cues("me", { type: "reveal" }, true);
    expect(named(cues)).toEqual(["reveal", "consensus"]);
    expect(cues[1]?.afterMs).toBe(FLIP_MS);
  });

  it("hears only the reveal of a vote that came with it", () => {
    const room = story();
    room.run("me", { type: "join", name: "Me", role: "voter" });
    room.run("ana", { type: "join", name: "Ana", role: "voter" });
    room.run("me", { type: "updateSettings", patch: { revealWhenAllVoted: true } });
    room.run("me", { type: "startRound", subject: { kind: "none" } });
    room.run("me", { type: "castVote", card: "5" });
    const cues = room.cues("ana", { type: "castVote", card: "8" });
    expect(named(cues)).not.toContain("card");
    expect(named(cues)[0]).toBe("reveal");
  });

  it("turns a card changed after the reveal, the viewer's own too", () => {
    const room = seated();
    room.run("me", { type: "updateSettings", patch: { allowChangeAfterReveal: true } });
    room.run("me", { type: "castVote", card: "5" });
    room.run("ana", { type: "castVote", card: "8" });
    room.run("ben", { type: "castVote", card: "13" });
    room.run("me", { type: "reveal" });
    expect(room.cues("ana", { type: "castVote", card: "13" })).toEqual([
      { sound: "flip", afterMs: 85, detune: 0 },
    ]);
    expect(named(room.cues("me", { type: "castVote", card: "8" }))).toEqual(["flip"]);
  });

  it("rings a consensus that a change made, after the card has turned", () => {
    const room = seated();
    room.run("me", { type: "updateSettings", patch: { allowChangeAfterReveal: true } });
    room.run("me", { type: "castVote", card: "5" });
    room.run("ana", { type: "castVote", card: "8" });
    room.run("ben", { type: "castVote", card: "5" });
    room.run("me", { type: "reveal" });
    expect(room.cues("ana", { type: "castVote", card: "5" })).toEqual([
      { sound: "flip", afterMs: 85, detune: 0 },
      { sound: "consensus", afterMs: FLIP_MS, detune: 0 },
    ]);
  });

  it("is silent for what the issue does not name: joins, a new round, a timer", () => {
    const room = seated();
    expect(room.cues("cleo", { type: "join", name: "Cleo", role: "voter" })).toEqual([]);
    expect(room.cues("me", { type: "startTimer", seconds: 60 })).toEqual([]);
    room.run("me", { type: "reveal" });
    expect(room.cues("me", { type: "startRound", subject: { kind: "none" } })).toEqual([]);
  });
});

describe("timerCues", () => {
  it("ticks as 0:05 to 0:01 show, rising a semitone each", () => {
    const cues = timerCues(100_000, 40_000);
    expect(cues).toHaveLength(LAST_SECONDS);
    expect(cues.map((cue) => cue.afterMs)).toEqual([55_000, 56_000, 57_000, 58_000, 59_000]);
    expect(cues.map((cue) => cue.detune)).toEqual([0, 100, 200, 300, 400]);
  });

  it("starts at the second it is in when a page sees the deadline late", () => {
    expect(timerCues(100_000, 97_500).map((cue) => cue.afterMs)).toEqual([500, 1500]);
  });

  it("has nothing left after the last second", () => {
    expect(timerCues(100_000, 99_500)).toEqual([]);
    expect(timerCues(100_000, 120_000)).toEqual([]);
  });
});
