/**
 * The removals a room remembers (U5): a kick records the person, a `join` takes them out, every
 * write drops what is older than a day, a room keeps at most `MAX_REMOVED`, and an account's
 * deletion or a guest's sign-in carries the entry with the person.
 */
import { describe, expect, it } from "vitest";
import { apply } from "./apply.ts";
import type { Command } from "./commands.ts";
import { MAX_REMOVED, REMOVAL_NOTICE_MS, wasRemoved } from "./removed.ts";
import { createRoom, type RoomState } from "./room.ts";

const T0 = 1_700_000_000_000;

function step(state: RoomState, actor: string, command: Command, now = T0): RoomState {
  const result = apply(state, command, { actor, now });
  if (!result.ok) throw new Error(`refused: ${result.error}`);
  return result.state;
}

/** Ada (PO) and Ben, seated. */
function room(): RoomState {
  let s = createRoom({ ownerId: "ada" });
  s = step(s, "ada", { type: "join", name: "Ada", role: "voter" });
  return step(s, "ben", { type: "join", name: "Ben", role: "voter" });
}

describe("the removals a room remembers (U5)", () => {
  it("records a kicked person with the time, for them alone", () => {
    const kicked = step(room(), "ada", { type: "kick", who: "ben" }, T0 + 5);
    expect(kicked.removed).toEqual({ ben: T0 + 5 });
    expect(wasRemoved(kicked, "ben", T0 + 6)).toBe(true);
    expect(wasRemoved(kicked, "ada", T0 + 6)).toBe(false);
    expect(wasRemoved(kicked, "cy", T0 + 6)).toBe(false);
  });

  it("records nothing for someone who leaves on their own", () => {
    const left = step(room(), "ben", { type: "leave" });
    expect(left.removed).toBeUndefined();
    expect(wasRemoved(left, "ben", T0)).toBe(false);
  });

  it("forgets a person who joins again, so a later reconnect says nothing", () => {
    const kicked = step(room(), "ada", { type: "kick", who: "ben" });
    const back = step(kicked, "ben", { type: "join", name: "Ben", role: "voter" }, T0 + 1);
    expect(back.removed).toBeUndefined();
    expect(wasRemoved(back, "ben", T0 + 2)).toBe(false);
    // Out again on their own: still nothing to tell.
    const left = step(back, "ben", { type: "leave" }, T0 + 3);
    expect(wasRemoved(left, "ben", T0 + 4)).toBe(false);
  });

  it("keeps the others' entries when one person joins again", () => {
    let s = step(room(), "cy", { type: "join", name: "Cy", role: "observer" });
    s = step(s, "ada", { type: "kick", who: "ben" }, T0 + 1);
    s = step(s, "ada", { type: "kick", who: "cy" }, T0 + 2);
    s = step(s, "ben", { type: "join", name: "Ben", role: "voter" }, T0 + 3);
    expect(s.removed).toEqual({ cy: T0 + 2 });
  });

  it("tells nobody once a day has passed, and the next write drops the entry", () => {
    const kicked = step(room(), "ada", { type: "kick", who: "ben" });
    expect(wasRemoved(kicked, "ben", T0 + REMOVAL_NOTICE_MS - 1)).toBe(true);
    expect(wasRemoved(kicked, "ben", T0 + REMOVAL_NOTICE_MS)).toBe(false);
    // Any write prunes: here a rename by the PO.
    const later = step(kicked, "ada", { type: "rename", name: "Ada L" }, T0 + REMOVAL_NOTICE_MS);
    expect(later.removed).toBeUndefined();
    // A command that changes nothing returns the very same state, entry and all.
    const result = apply(kicked, { type: "rename", name: "Ada" }, {
      actor: "ada",
      now: T0 + REMOVAL_NOTICE_MS,
    });
    expect(result.ok && result.state).toBe(kicked);
  });

  it("keeps at most MAX_REMOVED entries, the newest", () => {
    let s = room();
    const kicks = MAX_REMOVED + 5;
    for (let i = 0; i < kicks; i++) {
      s = step(s, `p${i}`, { type: "join", name: `P${i}`, role: "observer" }, T0 + i * 10);
      s = step(s, "ada", { type: "kick", who: `p${i}` }, T0 + i * 10 + 1);
    }
    const kept = Object.keys(s.removed ?? {});
    expect(kept).toHaveLength(MAX_REMOVED);
    expect(kept).toContain(`p${kicks - 1}`);
    expect(kept).not.toContain("p0");
    expect(wasRemoved(s, "p4", T0 + kicks * 10)).toBe(false);
    expect(wasRemoved(s, "p5", T0 + kicks * 10)).toBe(true);
  });

  it("goes with an account that is deleted, even with no seat left (ADR-029)", () => {
    const kicked = step(room(), "ada", { type: "kick", who: "ben" });
    const gone = step(
      kicked,
      ":server",
      { type: "removeAccount", who: "ben", ghost: "g1", vacant: "v1" },
      T0 + 1,
    );
    expect(gone.removed).toBeUndefined();
    expect(JSON.stringify(gone)).not.toContain('"ben"');
  });

  it("moves with a guest who signs in, unless the account has a seat (#48)", () => {
    const kicked = step(room(), "ada", { type: "kick", who: "ben" });
    const moved = step(
      kicked,
      ":server",
      { type: "moveGuest", guest: "ben", account: "acc" },
      T0 + 1,
    );
    expect(moved.removed).toEqual({ acc: T0 });
    const seated = step(kicked, "acc", { type: "join", name: "Acc", role: "voter" }, T0 + 1);
    const merged = step(
      seated,
      ":server",
      { type: "moveGuest", guest: "ben", account: "acc" },
      T0 + 2,
    );
    expect(merged.removed).toBeUndefined();
  });

  it("holds a time and nothing of a vote, in an anonymous round too", () => {
    let s = step(room(), "ada", { type: "updateSettings", patch: { revealNames: false } });
    s = step(s, "ada", { type: "startRound", subject: { kind: "none" } });
    s = step(s, "ben", { type: "castVote", card: "5", round: 1, restart: 0 });
    const kicked = step(s, "ada", { type: "kick", who: "ben" }, T0 + 1);
    expect(kicked.removed).toEqual({ ben: T0 + 1 });
  });
});
