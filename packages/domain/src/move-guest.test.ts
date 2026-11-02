/**
 * `moveGuest` (#48, ADR-025): a guest who signs in, in one room, as a pure step. The merge rules
 * are written here case by case, and a property holds what must stay true in any room: nobody
 * is lost, nothing reveals, and running it twice changes nothing more.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { apply } from "./apply.ts";
import type { Command } from "./commands.ts";
import { createRoom, type RoomState } from "./room.ts";

const SERVER = ":server";
const T0 = 1_700_000_000_000;
const GUEST = "guest";
const ACCOUNT = "account";

function act(state: RoomState, actor: string, command: Command, now = T0): RoomState {
  const result = apply(state, command, { actor, now });
  if (!result.ok) throw new Error(`refused: ${result.error}`);
  return result.state;
}

const move = (state: RoomState, now = T0) =>
  apply(state, { type: "moveGuest", guest: GUEST, account: ACCOUNT }, { actor: SERVER, now });

/** A room with these people in it, the first one its PO; each joins a ms after the last. */
function room(people: readonly string[], settings: Partial<RoomState["settings"]> = {}): RoomState {
  let state = createRoom({ ownerId: people[0] ?? "nobody" });
  state = { ...state, settings: { ...state.settings, revealWhenAllVoted: false, ...settings } };
  people.forEach((who, i) => {
    state = act(state, who, { type: "join", name: `Name of ${who}`, role: "voter" }, T0 + i);
  });
  return state;
}

function voting(state: RoomState): RoomState {
  return act(state, state.ownerId, { type: "startRound", subject: { kind: "none" } });
}

const vote = (state: RoomState, who: string, card: string) =>
  act(state, who, { type: "castVote", card });

const reveal = (state: RoomState) => act(state, state.ownerId, { type: "reveal" });

describe("a guest alone in the room", () => {
  it("keeps the seat as it is, under the account's id", () => {
    const before = room([GUEST, "ben"]);
    const { state, causes } = move(before);
    expect(state.participants[ACCOUNT]).toEqual(before.participants[GUEST]);
    expect(Object.keys(state.participants).sort()).toEqual([ACCOUNT, "ben"].sort());
    expect(causes).toEqual([]);
  });

  it("keeps the PO role, the avatar, the role, a shown name and being away", () => {
    let before = room([GUEST, "ben"]);
    before = act(before, GUEST, { type: "rename", name: "Chosen name" });
    before = act(before, GUEST, { type: "setAvatar", avatar: "fox" });
    before = act(before, GUEST, { type: "setRole", role: "observer" });
    before = act(before, SERVER, { type: "presence", who: GUEST, connected: false }, T0 + 5);
    const { state } = move(before);
    expect(state.ownerId).toBe(ACCOUNT);
    expect(state.participants[ACCOUNT]).toMatchObject({
      name: "Chosen name",
      avatar: "fox",
      role: "observer",
      connected: false,
      awaySince: T0 + 5,
    });
  });

  it("keeps the vote of the round on the table, unrevealed", () => {
    const { state } = move(vote(voting(room(["ben", GUEST])), GUEST, "5"));
    expect(state.round?.votes).toEqual({ [ACCOUNT]: { card: "5" } });
    expect(state.round?.phase).toBe("voting");
  });

  it("keeps a card changed after a named reveal, with its mark", () => {
    let before = reveal(
      vote(voting(room(["ben", GUEST], { allowChangeAfterReveal: true })), GUEST, "5"),
    );
    before = vote(before, GUEST, "8");
    const { state } = move(before);
    expect(state.round?.votes).toEqual({ [ACCOUNT]: { card: "8", changedAfterReveal: true } });
  });

  it("takes the card of a guest who left after a named reveal, with the name kept", () => {
    const before = act(reveal(vote(voting(room(["ben", GUEST])), GUEST, "5")), GUEST, {
      type: "leave",
    });
    const { state } = move(before);
    expect(state.round?.votes).toEqual({ [ACCOUNT]: { card: "5", name: `Name of ${GUEST}` } });
    expect(state.participants).not.toHaveProperty(ACCOUNT);
  });

  it("takes a room the guest owns but left", () => {
    const before = act(room([GUEST, "ben"]), GUEST, { type: "leave" });
    const { state } = move(before);
    expect(state.ownerId).toBe(ACCOUNT);
    expect(state.participants).not.toHaveProperty(ACCOUNT);
  });
});

describe("both the guest and the account in the room", () => {
  it("leaves one seat, the account's, with the name the room knows it by", () => {
    let before = room(["ben", ACCOUNT, GUEST]);
    before = act(before, GUEST, { type: "setAvatar", avatar: "fox" });
    const { state } = move(before);
    expect(Object.keys(state.participants).sort()).toEqual([ACCOUNT, "ben"].sort());
    expect(state.participants[ACCOUNT]).toEqual(before.participants[ACCOUNT]);
  });

  it("gives the seat the guest's PO role", () => {
    const { state } = move(room([GUEST, ACCOUNT, "ben"]));
    expect(state.ownerId).toBe(ACCOUNT);
    expect(state.participants).not.toHaveProperty(GUEST);
  });

  it("leaves an account that is PO the PO", () => {
    expect(move(room([ACCOUNT, GUEST, "ben"])).state.ownerId).toBe(ACCOUNT);
  });

  it("keeps the account's card when both voted", () => {
    const before = vote(vote(voting(room(["ben", ACCOUNT, GUEST])), GUEST, "5"), ACCOUNT, "8");
    expect(move(before).state.round?.votes).toEqual({ [ACCOUNT]: { card: "8" } });
  });

  it("keeps the only card when only the guest voted", () => {
    const before = vote(voting(room(["ben", ACCOUNT, GUEST])), GUEST, "5");
    expect(move(before).state.round?.votes).toEqual({ [ACCOUNT]: { card: "5" } });
  });

  it("keeps the only card when only the account voted", () => {
    const before = vote(voting(room(["ben", ACCOUNT, GUEST])), ACCOUNT, "8");
    expect(move(before).state.round?.votes).toEqual({ [ACCOUNT]: { card: "8" } });
  });

  it("makes an observing account a voter when the guest's card is the one that stands", () => {
    let before = room(["ben", ACCOUNT, GUEST]);
    before = act(before, ACCOUNT, { type: "setRole", role: "observer" });
    before = vote(voting(before), GUEST, "5");
    const { state, causes } = move(before);
    expect(state.participants[ACCOUNT]?.role).toBe("voter");
    expect(state.round?.votes).toEqual({ [ACCOUNT]: { card: "5" } });
    expect(causes).toEqual([]);
  });

  it("leaves an observing account an observer when the guest has no card", () => {
    let before = room(["ben", ACCOUNT, GUEST]);
    before = act(before, ACCOUNT, { type: "setRole", role: "observer" });
    expect(move(voting(before)).state.participants[ACCOUNT]?.role).toBe("observer");
  });

  it("drops a card of the seat that becomes a PO who does not vote, as a hand-over does", () => {
    const before = vote(voting(room([GUEST, ACCOUNT, "ben"], { poVotes: false })), ACCOUNT, "8");
    const { state, causes } = move(before);
    expect(state.ownerId).toBe(ACCOUNT);
    expect(state.round?.votes).toEqual({});
    expect(causes).toEqual([{ type: "voteRetracted", who: ACCOUNT }]);
  });

  it("keeps the account's card after a named reveal and takes the guest's off", () => {
    const before = reveal(
      vote(vote(voting(room(["ben", ACCOUNT, GUEST])), GUEST, "5"), ACCOUNT, "8"),
    );
    expect(move(before).state.round?.votes).toEqual({ [ACCOUNT]: { card: "8" } });
  });

  it("leaves both cards of an anonymous reveal, which ties neither to a seat", () => {
    const before = reveal(
      vote(
        vote(voting(room(["ben", ACCOUNT, GUEST], { revealNames: false })), GUEST, "5"),
        ACCOUNT,
        "8",
      ),
    );
    const once = move(before).state;
    expect(once.round?.votes).toEqual(before.round?.votes);
    expect(once.participants).not.toHaveProperty(GUEST);
    expect(move(once).state).toBe(once);
  });

  it("drops the guest's card of an anonymous round still voting: nobody has seen it", () => {
    const before = vote(
      vote(voting(room(["ben", ACCOUNT, GUEST], { revealNames: false })), GUEST, "5"),
      ACCOUNT,
      "8",
    );
    expect(move(before).state.round?.votes).toEqual({ [ACCOUNT]: { card: "8" } });
  });
});

describe("what the move never does", () => {
  it("does not reveal when the seat that goes was the last one waited for", () => {
    let before = room(["ben", ACCOUNT, GUEST], { revealWhenAllVoted: true });
    before = vote(vote(voting(before), "ben", "3"), ACCOUNT, "8");
    expect(before.round?.phase).toBe("voting");
    const { state, causes } = move(before);
    expect(state.round?.phase).toBe("voting");
    expect(causes).toEqual([]);
  });

  it("lets a deadline that passed reveal, as any command does, and exactly once", () => {
    let before = room(["ben", GUEST], { timer: { seconds: 30, revealAtEnd: true } });
    before = vote(voting(before), GUEST, "5");
    const { state, causes } = move(before, T0 + 31_000);
    expect(state.round?.phase).toBe("revealed");
    expect(causes).toEqual([{ type: "revealed", by: "timer" }]);
    expect(state.round?.votes).toEqual({ [ACCOUNT]: { card: "5" } });
  });

  it("returns the same state when the guest holds nothing here", () => {
    const before = room(["ben", "cleo"]);
    expect(move(before).state).toBe(before);
    expect(
      apply(before, { type: "moveGuest", guest: "ben", account: "ben" }, { actor: SERVER, now: T0 })
        .state,
    ).toBe(before);
  });

  it("takes ids such as constructor for ids, not for what Object has", () => {
    const before = room(["ben"]);
    const result = apply(
      before,
      { type: "moveGuest", guest: "constructor", account: "toString" },
      { actor: SERVER, now: T0 },
    );
    expect(result.state).toBe(before);
  });

  it("holds in any room: nobody lost, no reveal, and a second run changes nothing", () => {
    const person = fc.constantFrom(GUEST, ACCOUNT, "ben", "cleo");
    const step = fc.oneof(
      fc.record({
        who: person,
        command: fc.oneof(
          fc.record({
            type: fc.constant("join" as const),
            name: fc.constant("Ana"),
            role: fc.constantFrom("voter" as const, "observer" as const),
          }),
          fc.record({
            type: fc.constant("castVote" as const),
            card: fc.constantFrom("3", "5", "8"),
          }),
          fc.constant({ type: "leave" as const }),
          fc.constant({ type: "retractVote" as const }),
          fc.record({
            type: fc.constant("setRole" as const),
            role: fc.constantFrom("voter" as const, "observer" as const),
          }),
        ),
      }),
      fc.constant({ who: "owner", command: { type: "reveal" } as Command }),
    );
    const settings = fc.record({
      revealNames: fc.boolean(),
      poVotes: fc.boolean(),
      revealWhenAllVoted: fc.boolean(),
    });
    fc.assert(
      fc.property(fc.array(step, { maxLength: 24 }), settings, (steps, chosen) => {
        let state = voting(room(["ben", GUEST, ACCOUNT], chosen));
        for (const { who, command } of steps) {
          const actor = who === "owner" ? state.ownerId : who;
          state = apply(state, command, { actor, now: T0 }).state;
        }
        const others = Object.keys(state.participants).filter((id) => id !== GUEST);
        const seated = others.includes(ACCOUNT) || Object.hasOwn(state.participants, GUEST);
        const phase = state.round?.phase;
        const cards = Object.values(state.round?.votes ?? {}).map((v) => v.card);
        const { state: moved, causes } = move(state);

        expect(moved.participants).not.toHaveProperty(GUEST);
        expect(moved.ownerId).not.toBe(GUEST);
        for (const id of others) expect(moved.participants).toHaveProperty(id);
        if (seated) expect(moved.participants).toHaveProperty(ACCOUNT);
        expect(moved.round?.phase).toBe(phase);
        expect(causes.filter((cause) => cause.type === "revealed")).toEqual([]);
        // An anonymous reveal keeps every card on the table, whoever leaves it.
        if (phase === "revealed" && moved.round?.anonymous) {
          const after = Object.values(moved.round.votes).map((v) => v.card);
          expect(after.sort()).toEqual(cards.sort());
        }
        expect(move(moved).state).toBe(moved);
      }),
      { numRuns: 300 },
    );
  });
});
