/**
 * Who holds the right to delete a room (#49, ADR-027). The PO role moves by a hand-over or a
 * claim; the right moves only by the keeper's own hand-over, or with the keeper's sign-in. The
 * cases are written out, and a property holds the rule over random sequences.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { apply } from "./apply.ts";
import type { Command } from "./commands.ts";
import { createRoom, keeperOf, OWNER_CLAIM_AFTER_MS, type RoomState } from "./room.ts";

const SERVER = ":server";
const T0 = 1_700_000_000_000;
const PEOPLE = ["ana", "ben", "cleo"] as const;

function act(state: RoomState, actor: string, command: Command, now = T0): RoomState {
  const result = apply(state, command, { actor, now });
  if (!result.ok) throw new Error(`refused: ${result.error}`);
  return result.state;
}

/** Everyone in the room, Ana its creator and PO. */
function room(): RoomState {
  let state = createRoom({ ownerId: "ana" });
  for (const who of PEOPLE) state = act(state, who, { type: "join", name: who, role: "voter" });
  return state;
}

const leave = (state: RoomState, who: string) => act(state, who, { type: "leave" });
const away = (state: RoomState, who: string, now = T0) =>
  act(state, SERVER, { type: "presence", who, connected: false }, now);
const claim = (state: RoomState, who: string, now = T0) =>
  act(state, who, { type: "claimOwner" }, now);
const handOver = (state: RoomState, from: string, to: string) =>
  act(state, from, { type: "transferOwner", to });

/** A room as stored before `keeperId`. */
function stored(state: RoomState): RoomState {
  const { keeperId: _, ...rest } = state;
  return rest;
}

describe("who holds the right to delete a room", () => {
  it("is the owner of a new room", () => {
    const state = createRoom({ ownerId: "ana" });
    expect(state.keeperId).toBe("ana");
    expect(keeperOf(state)).toBe("ana");
  });

  it("stays put when the role is claimed from an owner who has no seat", () => {
    const state = claim(leave(room(), "ana"), "ben");
    expect(state.ownerId).toBe("ben");
    expect(state.keeperId).toBe("ana");
  });

  it("stays put when the role is claimed after two minutes away", () => {
    const state = claim(away(room(), "ana"), "ben", T0 + OWNER_CLAIM_AFTER_MS);
    expect(state.ownerId).toBe("ben");
    expect(state.keeperId).toBe("ana");
  });

  it("moves with a hand-over by the keeper", () => {
    const state = handOver(room(), "ana", "ben");
    expect(state.ownerId).toBe("ben");
    expect(state.keeperId).toBe("ben");
  });

  it("does not move with a hand-over by someone who claimed the role", () => {
    const state = handOver(claim(leave(room(), "ana"), "ben"), "ben", "cleo");
    expect(state.ownerId).toBe("cleo");
    expect(state.keeperId).toBe("ana");
  });

  it("is the keeper's again, with the role, when the keeper claims it back", () => {
    const claimed = claim(away(room(), "ana"), "ben", T0 + OWNER_CLAIM_AFTER_MS);
    const later = T0 + 2 * OWNER_CLAIM_AFTER_MS;
    const back = act(away(claimed, "ben", later), SERVER, {
      type: "presence",
      who: "ana",
      connected: true,
    });
    const state = claim(back, "ana", later + OWNER_CLAIM_AFTER_MS);
    expect(state.ownerId).toBe("ana");
    expect(state.keeperId).toBe("ana");
  });

  it("goes on being the keeper's when someone who claimed the role hands it back", () => {
    const claimed = claim(away(room(), "ana"), "ben", T0 + OWNER_CLAIM_AFTER_MS);
    const back = act(claimed, SERVER, { type: "presence", who: "ana", connected: true });
    const state = handOver(back, "ben", "ana");
    expect(state.ownerId).toBe("ana");
    expect(state.keeperId).toBe("ana");
  });

  it("stays through a kick, a leave and a rename", () => {
    const claimed = claim(leave(room(), "ana"), "ben");
    const kicked = act(claimed, "ben", { type: "kick", who: "cleo" });
    const left = act(act(kicked, "ben", { type: "renameRoom", name: "New" }), "ben", {
      type: "leave",
    });
    expect(left.keeperId).toBe("ana");
  });
});

describe("a room stored before the field", () => {
  it("reads its PO as the keeper", () => {
    expect(keeperOf(stored(room()))).toBe("ana");
  });

  it("writes the PO it replaces as the keeper at a claim, so no claimer ever reads as one", () => {
    const state = claim(leave(stored(room()), "ana"), "ben");
    expect(state.ownerId).toBe("ben");
    expect(state.keeperId).toBe("ana");
  });

  it("gives the right with the PO's own hand-over", () => {
    expect(handOver(stored(room()), "ana", "ben").keeperId).toBe("ben");
  });

  it("gains nothing from a command that does not move the role", () => {
    const state = act(stored(room()), "ana", { type: "renameRoom", name: "New" });
    expect(state.keeperId).toBeUndefined();
  });
});

describe("a guest who signs in (ADR-025)", () => {
  const move = (state: RoomState, guest: string) =>
    apply(state, { type: "moveGuest", guest, account: "account" }, { actor: SERVER, now: T0 });

  it("takes the right with the role", () => {
    const { state } = move(room(), "ana");
    expect(state.ownerId).toBe("account");
    expect(state.keeperId).toBe("account");
  });

  it("takes the right alone, seat or no seat, from a room whose role was claimed", () => {
    const seated = claim(away(room(), "ana"), "ben", T0 + OWNER_CLAIM_AFTER_MS);
    expect(move(seated, "ana").state).toMatchObject({ ownerId: "ben", keeperId: "account" });

    const noSeat = claim(leave(room(), "ana"), "ben");
    const result = move(noSeat, "ana");
    expect(result.state).toMatchObject({ ownerId: "ben", keeperId: "account" });
    expect(result.state).not.toBe(noSeat);
  });

  it("who claimed the role takes the role and no right", () => {
    const claimed = claim(leave(room(), "ana"), "ben");
    expect(move(claimed, "ben").state).toMatchObject({ ownerId: "account", keeperId: "ana" });
  });

  it("carries the role of a room stored before the field, and so its right", () => {
    const { state } = move(stored(room()), "ana");
    expect(state.ownerId).toBe("account");
    expect(keeperOf(state)).toBe("account");
  });

  it("changes nothing the second time", () => {
    const { state } = move(claim(leave(room(), "ana"), "ben"), "ana");
    expect(move(state, "ana").state).toBe(state);
  });
});

describe("over any sequence of commands", () => {
  const personArb = fc.constantFrom(...PEOPLE);
  const commandArb: fc.Arbitrary<Command> = fc.oneof(
    fc.record({ type: fc.constant("transferOwner" as const), to: personArb }),
    fc.constant({ type: "claimOwner" as const }),
    fc.record({ type: fc.constant("kick" as const), who: personArb }),
    fc.constant({ type: "leave" as const }),
    fc.record({
      type: fc.constant("join" as const),
      name: fc.constant("Ana"),
      role: fc.constant("voter" as const),
    }),
    fc.record({ type: fc.constant("presence" as const), who: personArb, connected: fc.boolean() }),
    fc.constant({ type: "renameRoom" as const, name: "A name" }),
  );
  const stepArb = fc.record({
    actor: personArb,
    command: commandArb,
    dt: fc.constantFrom(0, 60_000, OWNER_CLAIM_AFTER_MS),
  });

  it("the right moves only by the keeper's own hand-over", () => {
    fc.assert(
      fc.property(fc.array(stepArb, { minLength: 10, maxLength: 60, size: "max" }), (steps) => {
        let state = room();
        let now = T0;
        for (const { actor, command, dt } of steps) {
          now += dt;
          const sender = command.type === "presence" ? SERVER : actor;
          const before = state;
          state = apply(before, command, { actor: sender, now }).state;
          if (state.keeperId === before.keeperId) continue;
          expect(command.type).toBe("transferOwner");
          expect(actor).toBe(before.keeperId);
          expect(state.keeperId).toBe(state.ownerId);
        }
      }),
    );
  });
});
