import { apply, type Command, createRoom, type RoomState } from "@pp/domain";
import { toSnapshot } from "@pp/protocol";
import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Database, openDatabase } from "../database.ts";
import { collectLogs } from "../test-support.ts";
import { T0 } from "./fixtures.ts";
import { createTestDatabase, type TestDatabase } from "./test-db.ts";

// Persisting must be invisible: a room stored as jsonb and loaded back between every
// command behaves exactly like one that never left memory. jsonb reorders object keys,
// drops undefined fields and normalises numbers, so anything that depends on key order or
// does not survive JSON shows up here as a snapshot that differs.

const USERS = ["u1", "u2", "u3", "u4"];
const VIEWERS = [...USERS, "nobody"];
const user = fc.constantFrom(...USERS);
// The PO (u1) acts more often: most round commands are theirs.
const actor = fc.oneof({ weight: 3, arbitrary: fc.constant("u1") }, { weight: 4, arbitrary: user });
const name = fc.constantFrom("Ada", "Zoë", "李雷", "Ünï 🙂", "b");
const role = fc.constantFrom("voter", "observer");
const card = fc.constantFrom("0", "1", "2", "3", "5", "8", "13", "?", "☕", "∞", "XL", "M");
const seconds = fc.integer({ min: 5, max: 90 });
const subject = fc.constantFrom(
  { kind: "none" },
  { kind: "title", text: "Login page" },
  { kind: "link", url: "https://dev.example.com/browse/ABC-12" },
);
const patch = fc.oneof(
  fc.record({ revealNames: fc.boolean() }),
  fc.record({ revealWhenAllVoted: fc.boolean() }),
  fc.record({ allowChangeAfterReveal: fc.boolean() }),
  fc.record({ poVotes: fc.boolean() }),
  fc.record({ observersCount: fc.boolean() }),
  fc.record({ whoCanReveal: fc.constantFrom("po", "anyone") }),
  fc.record({
    timer: fc.record({ seconds: fc.constantFrom(null, 30), revealAtEnd: fc.boolean() }),
  }),
  fc.record({
    deck: fc.constantFrom(
      { kind: "preset", id: "fib" },
      { kind: "preset", id: "tshirt" },
      { kind: "custom", cards: ["XL", "M", "1"] },
    ),
  }),
  fc.record({ specials: fc.subarray(["?", "☕", "∞"]) }),
);
const of = <T>(type: string, rest: fc.Arbitrary<T> = fc.constant({} as T)) =>
  rest.map((fields) => ({ type, ...fields }));

const command = fc.oneof(
  { weight: 1, arbitrary: of("join", fc.record({ name, role })) },
  { weight: 1, arbitrary: of("leave") },
  { weight: 1, arbitrary: of("rename", fc.record({ name })) },
  { weight: 1, arbitrary: of("setRole", fc.record({ role })) },
  { weight: 1, arbitrary: of("kick", fc.record({ who: user })) },
  { weight: 3, arbitrary: of("startRound", fc.record({ subject })) },
  { weight: 6, arbitrary: of("castVote", fc.record({ card })) },
  { weight: 1, arbitrary: of("retractVote") },
  { weight: 2, arbitrary: of("reveal") },
  { weight: 1, arbitrary: of("setFinal", fc.record({ card })) },
  { weight: 1, arbitrary: of("revote") },
  { weight: 1, arbitrary: of("startTimer", fc.record({ seconds })) },
  { weight: 1, arbitrary: of("stopTimer") },
  { weight: 1, arbitrary: of("extendTimer", fc.record({ seconds })) },
  { weight: 1, arbitrary: of("timeUp") },
  { weight: 2, arbitrary: of("updateSettings", fc.record({ patch })) },
  { weight: 1, arbitrary: of("transferOwner", fc.record({ to: user })) },
  { weight: 1, arbitrary: of("claimOwner") },
) as unknown as fc.Arbitrary<Command>;

const steps = fc.array(fc.record({ actor, command, wait: fc.integer({ min: 0, max: 40_000 }) }), {
  minLength: 5,
  maxLength: 30,
  size: "max",
});

let t: TestDatabase;
let database: Database;
let codes = 0;
/** How much the generated sequences really do; asserted so a weak generator fails loudly. */
const seen = { changed: 0, reveals: 0, anonymousReveals: 0, timers: 0 };

beforeAll(async () => {
  t = await createTestDatabase();
  database = await openDatabase(t.url, collectLogs().logger, { max: 2 });
});
afterAll(async () => {
  await database?.close();
  await t?.drop();
});

function snapshots(state: RoomState, code: string, now: number, causes: readonly unknown[]) {
  const meta = { code, version: 0, now, causes: causes as never };
  return VIEWERS.map((viewer) => JSON.stringify(toSnapshot(state, viewer, meta)));
}

describe("a room stored and reloaded between commands", () => {
  it("gives every viewer the same snapshots as a room kept in memory", async () => {
    await fc.assert(
      fc.asyncProperty(fc.boolean(), steps, async (anonymous, sequence) => {
        const code = `P${String(++codes).padStart(9, "0")}`;
        // u1 (the PO), u2 and u3 are in the room, voting on round 1, anonymous or not;
        // u4 may join.
        let memory = createRoom({ ownerId: "u1" });
        for (const [who, name] of [
          ["u1", "Ada"],
          ["u2", "Bob"],
          ["u3", "Cy"],
        ] as const) {
          memory = apply(
            memory,
            { type: "join", name, role: "voter" },
            { actor: who, now: T0 },
          ).state;
        }
        for (const cmd of [
          { type: "updateSettings", patch: { revealNames: !anonymous } },
          { type: "startRound", subject: { kind: "none" } },
        ] as const) {
          memory = apply(memory, cmd, { actor: "u1", now: T0 }).state;
        }
        await database.store.insertRoom({ code, name: null, state: memory });
        let now = T0;
        for (const { actor, command: cmd, wait } of sequence) {
          now += wait;
          const inMemory = apply(memory, cmd, { actor, now });
          memory = inMemory.state;
          const outcome = await database.runner.run(code, (state) =>
            apply(state, cmd, { actor, now }),
          );
          if (!outcome.ok) throw new Error(`runner: ${outcome.error}`);
          if (outcome.changed) seen.changed++;
          if (memory.round?.phase === "revealed" && outcome.changed) {
            seen.reveals++;
            if (memory.round.anonymous) seen.anonymousReveals++;
          }
          if (memory.round?.deadlineAt !== undefined) seen.timers++;
          const stored = outcome.result;
          expect(stored.ok ? "ok" : stored.error).toBe(inMemory.ok ? "ok" : inMemory.error);
          const loaded = await database.store.loadRoom(code);
          if (!loaded) throw new Error("room vanished");
          expect(loaded.state).toEqual(memory);
          expect(snapshots(loaded.state, code, now, stored.causes)).toEqual(
            snapshots(memory, code, now, inMemory.causes),
          );
        }
      }),
      { numRuns: 200 },
    );
    expect(seen.changed).toBeGreaterThan(500);
    expect(seen.reveals).toBeGreaterThan(100);
    expect(seen.anonymousReveals).toBeGreaterThan(40);
    expect(seen.timers).toBeGreaterThan(40);
  }, 180_000);
});
