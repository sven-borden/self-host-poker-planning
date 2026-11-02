/** `renameRoom` (#49, ADR-027): the room's name, the PO's alone, by the rules of creating one. */
import { describe, expect, it } from "vitest";
import { apply } from "./apply.ts";
import { createRoom, type RoomState } from "./room.ts";

const T0 = 1_700_000_000_000;
const rename = (state: RoomState, name: string, actor = "po") =>
  apply(state, { type: "renameRoom", name }, { actor, now: T0 });

describe("renameRoom", () => {
  it("names the room, for its PO, from outside the room too", () => {
    const state = createRoom({ ownerId: "po" });
    expect(rename(state, "  Sprint  12 ")).toMatchObject({
      ok: true,
      state: { name: "Sprint 12" },
      causes: [{ type: "roomRenamed" }],
    });
  });

  it("refuses anyone else", () => {
    const state = createRoom({ ownerId: "po" });
    expect(rename(state, "Mine", "someone")).toMatchObject({ ok: false, error: "not_owner" });
  });

  it("holds a name to the rules of a new room", () => {
    const state = createRoom({ ownerId: "po" });
    for (const name of ["", "   ", "x".repeat(61), "a​b"]) {
      const result = rename(state, name);
      expect(result).toMatchObject({ ok: false, error: "bad_room_name" });
      expect(result.state).toBe(state);
    }
  });

  it("changes nothing for the name it already has", () => {
    const state = { ...createRoom({ ownerId: "po" }), name: "Same" };
    const result = rename(state, " Same ");
    expect(result).toMatchObject({ ok: true, causes: [] });
    expect(result.state).toBe(state);
  });

  it("resolves an elapsed deadline first, like any command", () => {
    const state: RoomState = {
      ...createRoom({ ownerId: "po" }),
      round: {
        number: 1,
        subject: { kind: "none" },
        phase: "voting",
        deck: { kind: "preset", id: "fib" },
        specials: [],
        anonymous: false,
        votes: {},
        startedAt: T0 - 2,
        deadlineAt: T0 - 1,
        timerStartedAt: T0 - 2,
      },
    };
    const result = rename(state, "Later");
    expect(result.ok && result.state.round?.phase).toBe("revealed");
  });
});
