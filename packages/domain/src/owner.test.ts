/**
 * Exactly one product owner at any time (#30, AC 1), as a property over random sequences
 * of the commands that move the role or the people: `transferOwner`, `claimOwner`,
 * `kick`, `leave`, `join` and the server's `presence`, with time running on by up to
 * three minutes a step, so claims meet both sides of the two minutes.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { apply } from "./apply.ts";
import type { Command } from "./commands.ts";
import { createRoom, OWNER_CLAIM_AFTER_MS, type RoomState } from "./room.ts";

const PEOPLE = ["ua", "ub", "uc", "ud"] as const;
const SERVER = ":server";
const T0 = 1_700_000_000_000;

const personArb = fc.constantFrom(...PEOPLE);
const commandArb: fc.Arbitrary<Command> = fc.oneof(
  fc.record({ type: fc.constant("transferOwner" as const), to: personArb }),
  fc.constant({ type: "claimOwner" as const }),
  fc.record({ type: fc.constant("kick" as const), who: personArb }),
  fc.constant({ type: "leave" as const }),
  fc.record({
    type: fc.constant("join" as const),
    name: fc.constantFrom("Ana", "Ben"),
    role: fc.constantFrom("voter" as const, "observer" as const),
  }),
  fc.record({ type: fc.constant("presence" as const), who: personArb, connected: fc.boolean() }),
);
const stepArb = fc.record({
  actor: personArb,
  command: commandArb,
  dt: fc.constantFrom(0, 1_000, 60_000, OWNER_CLAIM_AFTER_MS - 1, OWNER_CLAIM_AFTER_MS, 180_000),
});

/** The owner as `state` holds them: in the room or not, and since when away. */
function ownerOf(state: RoomState) {
  return Object.hasOwn(state.participants, state.ownerId)
    ? state.participants[state.ownerId]
    : undefined;
}

describe("the product owner (#30)", () => {
  it("is exactly one person at any time, and changes only by a hand-over or a fair claim", () => {
    fc.assert(
      fc.property(fc.array(stepArb, { maxLength: 60 }), (steps) => {
        let state = createRoom({ ownerId: "ua" });
        let now = T0;
        for (const { actor, command, dt } of steps) {
          now += dt;
          const sender = command.type === "presence" ? SERVER : actor;
          const before = state;
          const result = apply(before, command, { actor: sender, now });
          state = result.state;
          // One id, always one of the people: never empty, never two.
          expect(PEOPLE).toContain(state.ownerId);
          const changes = result.causes.filter((c) => c.type === "ownerChanged");
          if (state.ownerId === before.ownerId) {
            expect(changes).toEqual([]);
            continue;
          }
          // A change is said once and names the new owner, who is in the room.
          expect(changes).toEqual([
            {
              type: "ownerChanged",
              by: command.type === "claimOwner" ? "claim" : "transfer",
              to: state.ownerId,
            },
          ]);
          expect(ownerOf(state)).toBeDefined();
          if (command.type === "transferOwner") {
            // Handed over by the owner, to someone here (not away).
            expect(actor).toBe(before.ownerId);
            expect(ownerOf(state)?.awaySince).toBeUndefined();
            expect(state.ownerId).toBe(command.to);
          } else {
            // A claim: the old owner had left, or had been away for two minutes.
            expect(command.type).toBe("claimOwner");
            expect(state.ownerId).toBe(actor);
            const old = ownerOf(before);
            if (old !== undefined) {
              expect(old.awaySince).toBeDefined();
              expect(now - (old.awaySince ?? now)).toBeGreaterThanOrEqual(OWNER_CLAIM_AFTER_MS);
            }
          }
        }
      }),
      { numRuns: 400 },
    );
  });
});
