/**
 * `removeAccount` (#51, ADR-029): an account that goes, in one room, as a pure step. Each kind of
 * room is written out case by case, and a property holds what must stay true in any room: the id
 * is gone from the whole state, every revealed card stays, and a second run changes nothing.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { apply } from "./apply.ts";
import type { Command } from "./commands.ts";
import { AUTO_ADVANCE_MS, createRoom, heirsOf, keeperOf, type RoomState } from "./room.ts";

const SERVER = ":server";
const T0 = 1_700_000_000_000;
const WHO = "leaving-person";
const GHOST = "ghost-id";
const VACANT = "vacant-id";

function act(state: RoomState, actor: string, command: Command, now = T0): RoomState {
  const result = apply(state, command, { actor, now });
  if (!result.ok) throw new Error(`refused: ${result.error}`);
  return result.state;
}

const remove = (state: RoomState, heir?: string, now = T0, mayTake?: readonly string[]) =>
  apply(
    state,
    {
      type: "removeAccount",
      who: WHO,
      ghost: GHOST,
      vacant: VACANT,
      ...(heir !== undefined && { heir }),
      ...(mayTake !== undefined && { mayTake }),
    },
    { actor: SERVER, now },
  );

const away = (state: RoomState, who: string, now = T0) =>
  act(state, SERVER, { type: "presence", who, connected: false }, now);

/** A room with these people, the first its PO and keeper; each joins a ms after the last. */
function room(people: readonly string[], settings: Partial<RoomState["settings"]> = {}): RoomState {
  let state = createRoom({ ownerId: people[0] ?? "nobody" });
  state = { ...state, settings: { ...state.settings, revealWhenAllVoted: false, ...settings } };
  people.forEach((who, i) => {
    state = act(state, who, { type: "join", name: `Name of ${who}`, role: "voter" }, T0 + i);
  });
  return state;
}

const started = (state: RoomState) =>
  act(state, state.ownerId, { type: "startRound", subject: { kind: "none" } });

const vote = (state: RoomState, who: string, card: string) =>
  act(state, who, { type: "castVote", card });

const revealed = (state: RoomState) => act(state, state.ownerId, { type: "reveal" });

describe("who is next in line", () => {
  const seat = (joinedAt: number, connected = true) => ({ joinedAt, connected });
  const ids = (heirs: readonly { id: string }[]) => heirs.map(({ id }) => id);

  it("reads the person chosen, the PO who is here, the people here, the people away", () => {
    const participants = {
      [WHO]: seat(0),
      po: seat(5),
      early: seat(3),
      late: seat(4),
      gone: seat(1, false),
      chosen: seat(9, false),
    };
    expect(heirsOf({ ownerId: "po", participants }, WHO, { chosen: "chosen" })).toEqual([
      { id: "chosen", why: "chosen" },
      { id: "po", why: "runsTheRoom" },
      { id: "early", why: "here" },
      { id: "late", why: "here" },
      { id: "gone", why: "away" },
    ]);
  });

  it("does not put a PO who is away first", () => {
    const participants = { po: seat(5, false), ann: seat(7), ben: seat(1, false) };
    expect(heirsOf({ ownerId: "po", participants }, WHO)).toEqual([
      { id: "ann", why: "here" },
      { id: "ben", why: "away" },
      { id: "po", why: "away" },
    ]);
  });

  it("takes nobody a rule refuses, not even the person chosen or the PO", () => {
    const participants = { po: seat(1), ann: seat(2), ben: seat(3) };
    const allowed = { chosen: "ann", mayTake: ["ben"] };
    expect(ids(heirsOf({ ownerId: "po", participants }, WHO, allowed))).toEqual(["ben"]);
    expect(heirsOf({ ownerId: "po", participants }, WHO, { mayTake: [] })).toEqual([]);
  });

  it("never names the person going, chosen or not", () => {
    const participants = { [WHO]: seat(0), ann: seat(1) };
    expect(ids(heirsOf({ ownerId: WHO, participants }, WHO, { chosen: WHO }))).toEqual(["ann"]);
  });

  it("breaks a tie by id", () => {
    const participants = { zed: seat(1), amy: seat(1) };
    expect(ids(heirsOf({ ownerId: WHO, participants }, WHO))).toEqual(["amy", "zed"]);
  });
});

describe("a room the person keeps", () => {
  it("goes to whoever sat here longest, role and right, when the person chose nobody", () => {
    const result = remove(room([WHO, "ann", "ben"]));
    expect(result.ok).toBe(true);
    expect(result.state.ownerId).toBe("ann");
    expect(result.state.keeperId).toBe("ann");
    expect(Object.keys(result.state.participants)).toEqual(["ann", "ben"]);
    expect(result.causes).toEqual([
      { type: "ownerChanged", by: "transfer", to: "ann" },
      { type: "left", who: WHO },
    ]);
  });

  it("goes to the person chosen, while that person is still seated", () => {
    const state = room([WHO, "ann", "ben"]);
    expect(remove(state, "ben").state.keeperId).toBe("ben");
    expect(remove(state, "ben").state.ownerId).toBe("ben");
  });

  it("breaks a tie on when people sat down by id, the same on every instance", () => {
    let state = createRoom({ ownerId: WHO });
    for (const who of ["zed", "amy"]) {
      state = act(state, who, { type: "join", name: who, role: "voter" });
    }
    expect(remove(state).state.keeperId).toBe("amy");
  });

  it("falls back on the longest seated when the chosen person has left", () => {
    expect(remove(room([WHO, "ann", "ben"]), "cleo").state.keeperId).toBe("ann");
    expect(remove(room([WHO, "ann", "ben"]), WHO).state.keeperId).toBe("ann");
  });

  it("names the two rights in a room from before `keeperId`", () => {
    const { keeperId: _, ...old } = room([WHO, "ann"]);
    const result = remove(old);
    expect(result.state.ownerId).toBe("ann");
    expect(result.state.keeperId).toBe("ann");
  });

  it("leaves a room with whoever runs it, who now holds the right too", () => {
    let state = room([WHO, "ann", "ben"]);
    state = away(state, WHO);
    state = act(state, "ben", { type: "claimOwner" }, T0 + 200_000);
    expect(keeperOf(state)).toBe(WHO);
    const result = remove(state);
    expect(result.state.ownerId).toBe("ben");
    expect(result.state.keeperId).toBe("ben");
    expect(result.causes).toEqual([{ type: "left", who: WHO }]);
  });

  it("gives a person chosen both, over whoever runs the room", () => {
    let state = room([WHO, "ann", "ben"]);
    state = away(state, WHO);
    state = act(state, "ben", { type: "claimOwner" }, T0 + 200_000);
    const result = remove(state, "ann");
    expect(result.state.ownerId).toBe("ann");
    expect(result.state.keeperId).toBe("ann");
    expect(result.causes[0]).toEqual({ type: "ownerChanged", by: "transfer", to: "ann" });
  });

  it("does not leave it with a claimer who is away: someone here goes first", () => {
    let state = room([WHO, "ann", "ben"]);
    state = away(state, WHO);
    state = act(state, "ben", { type: "claimOwner" }, T0 + 200_000);
    state = away(state, "ben", T0 + 200_000);
    expect(remove(state).state.keeperId).toBe("ann");
  });

  it("takes someone here over someone who sat longer and is away", () => {
    const state = away(room([WHO, "ann", "ben"]), "ann");
    expect(remove(state).state.keeperId).toBe("ben");
  });

  it("takes someone away when nobody is here, seated longest first", () => {
    const state = away(away(room([WHO, "ann", "ben"]), "ben"), "ann");
    expect(remove(state).state.keeperId).toBe("ann");
  });

  it("moves the right alone when the taker already holds the role", () => {
    let state = room([WHO, "ann"]);
    state = away(state, WHO);
    state = act(state, "ann", { type: "claimOwner" }, T0 + 200_000);
    const result = remove(state);
    expect(result.state.ownerId).toBe("ann");
    expect(result.state.keeperId).toBe("ann");
    expect(result.causes).toEqual([{ type: "left", who: WHO }]);
  });

  it("changes nothing when nobody can take it: the caller deletes the room", () => {
    const state = room([WHO]);
    expect(remove(state).state).toBe(state);
    const empty = createRoom({ ownerId: WHO });
    expect(remove(empty).state).toBe(empty);
  });

  it("hands over from outside the room too", () => {
    const state = act(room([WHO, "ann"]), WHO, { type: "leave" });
    const result = remove(state);
    expect(result.state.keeperId).toBe("ann");
    expect(result.causes).toEqual([{ type: "ownerChanged", by: "transfer", to: "ann" }]);
  });
});

describe("a room whose rule refuses someone", () => {
  it("never gives it to a person the rule refuses, chosen or next in line", () => {
    const state = room([WHO, "ann", "ben"]);
    expect(remove(state, "ann", T0, ["ben"]).state.keeperId).toBe("ben");
    expect(remove(state, undefined, T0, ["ben"]).state.ownerId).toBe("ben");
  });

  it("leaves it with nobody when nobody seated is allowed, and anyone allowed can claim", () => {
    let state = started(room([WHO, "ann", "ben"]));
    state = revealed(vote(state, WHO, "5"));
    const result = remove(state, "ann", T0, []);
    expect(result.ok).toBe(true);
    expect(result.state.ownerId).toBe(VACANT);
    expect(result.state.keeperId).toBe(VACANT);
    expect(Object.keys(result.state.participants)).toEqual(["ann", "ben"]);
    expect(result.causes).toEqual([{ type: "left", who: WHO }]);
    expect(JSON.stringify(result.state)).not.toContain(WHO);
    const after = act(result.state, "ben", { type: "claimOwner" }, T0 + 1);
    expect(after.ownerId).toBe("ben");
    expect(after.keeperId).toBe(VACANT);
  });

  it("frees the role under an id no card sits under: a card must not point at the PO", () => {
    const state = revealed(vote(started(room([WHO, "ann"])), WHO, "5"));
    const result = remove(state, undefined, T0, []);
    expect(result.state.ownerId).toBe(VACANT);
    expect(Object.keys(result.state.round?.votes ?? {})).toEqual([GHOST]);
  });

  it("gives a keeper the rule refuses nothing: a claimed role goes free, and the right stays", () => {
    let state = room(["ann", WHO, "ben"]);
    state = away(state, "ann");
    state = act(state, WHO, { type: "claimOwner" }, T0 + 200_000);
    const result = remove(state, undefined, T0 + 200_000, ["ben"]);
    expect(result.state.ownerId).toBe(VACANT);
    expect(result.state.keeperId).toBe("ann");
    expect(result.causes).toEqual([{ type: "left", who: WHO }]);
  });

  it("gives a claimed role back to a keeper the rule allows", () => {
    let state = room(["ann", WHO, "ben"]);
    state = away(state, "ann");
    state = act(state, WHO, { type: "claimOwner" }, T0 + 200_000);
    const result = remove(state, undefined, T0 + 200_000, ["ann"]);
    expect(result.state.ownerId).toBe("ann");
    expect(result.causes[0]).toEqual({ type: "ownerChanged", by: "transfer", to: "ann" });
  });

  it("leaves a PO alone whom the rule refuses, when the person only had a seat", () => {
    const result = remove(room(["ann", WHO]), undefined, T0, []);
    expect(result.state.ownerId).toBe("ann");
    expect(result.state.keeperId).toBe("ann");
  });

  it("still changes nothing when nobody else is seated: the caller deletes the room", () => {
    const state = room([WHO]);
    expect(remove(state, undefined, T0, []).state).toBe(state);
  });
});

describe("a room someone else keeps", () => {
  it("loses the seat, and nothing moves", () => {
    const result = remove(room(["ann", WHO, "ben"]));
    expect(result.state.ownerId).toBe("ann");
    expect(result.state.keeperId).toBe("ann");
    expect(Object.keys(result.state.participants)).toEqual(["ann", "ben"]);
    expect(result.causes).toEqual([{ type: "left", who: WHO }]);
  });

  /** `ann` keeps the room, and the person took the role while `ann` was away. */
  function claimed(people: readonly string[]): RoomState {
    let state = room(people);
    state = away(state, "ann");
    return act(state, WHO, { type: "claimOwner" }, T0 + 200_000);
  }

  it("gives a claimed role back to a keeper who is seated", () => {
    const result = remove(claimed(["ann", WHO]));
    expect(result.state.ownerId).toBe("ann");
    expect(result.state.keeperId).toBe("ann");
    expect(result.causes[0]).toEqual({ type: "ownerChanged", by: "transfer", to: "ann" });
  });

  it("leaves a claimed role free to claim when the keeper has no seat", () => {
    const state = act(claimed(["ann", WHO, "ben"]), "ann", { type: "leave" });
    const result = remove(state);
    expect(result.state.ownerId).toBe("ann");
    expect(result.state.keeperId).toBe("ann");
    expect(result.causes).toEqual([{ type: "left", who: WHO }]);
    const after = act(result.state, "ben", { type: "claimOwner" }, T0 + 300_000);
    expect(after.ownerId).toBe("ben");
    expect(after.keeperId).toBe("ann");
  });
});

describe("the round on the table", () => {
  it("drops a card in a round still voting, as a leave does", () => {
    let state = started(room(["ann", WHO, "ben"]));
    state = vote(state, WHO, "5");
    const result = remove(state);
    expect(result.state.round?.votes).toEqual({});
    expect(result.causes).toContainEqual({ type: "voteRetracted", who: WHO });
  });

  it("reveals by the room's own rule, as a leave does", () => {
    const rule = { revealWhenAllVoted: true };
    let state = started(room(["ann", WHO, "ben"], rule));
    state = vote(vote(state, "ann", "3"), "ben", "8");
    const left = act(state, WHO, { type: "leave" });
    const result = remove(state);
    expect(result.state.round?.phase).toBe(left.round?.phase);
    expect(result.state.round?.phase).toBe("revealed");
    expect(result.state.round?.votes).toEqual(left.round?.votes);
  });

  it("keeps a card after a named reveal, with no name and nothing to say it changed", () => {
    let state = started(room(["ann", WHO], { allowChangeAfterReveal: true }));
    state = revealed(vote(vote(state, "ann", "3"), WHO, "5"));
    state = vote(state, WHO, "8");
    const result = remove(state);
    expect(result.state.round?.votes).toEqual({ ann: { card: "3" }, [GHOST]: { card: "8" } });
  });

  it("takes the kept name of someone who left after the reveal", () => {
    let state = started(room(["ann", WHO]));
    state = act(revealed(vote(vote(state, "ann", "3"), WHO, "5")), WHO, { type: "leave" });
    expect(state.round?.votes[WHO]?.name).toBe(`Name of ${WHO}`);
    const result = remove(state);
    expect(result.state.round?.votes[GHOST]).toEqual({ card: "5" });
    expect(result.causes).toEqual([]);
  });

  it("keeps a card after an anonymous reveal, under the new id", () => {
    let state = started(room(["ann", WHO, "ben"], { revealNames: false }));
    state = revealed(vote(vote(vote(state, "ann", "3"), WHO, "5"), "ben", "8"));
    const result = remove(state);
    const cards = Object.values(result.state.round?.votes ?? {}).map((one) => one.card);
    expect(cards.sort()).toEqual(["3", "5", "8"]);
    expect(Object.keys(result.state.round?.votes ?? {})).not.toContain(WHO);
  });

  it("reveals at a deadline that passed first, exactly once, and keeps the card", () => {
    const timed = { timer: { seconds: 30, revealAtEnd: true } };
    const state = vote(started(room(["ann", WHO], timed)), WHO, "5");
    const result = remove(state, undefined, T0 + 31_000);
    expect(result.causes).toContainEqual({ type: "revealed", by: "timer" });
    expect(result.state.round?.votes[GHOST]).toEqual({ card: "5" });
  });

  it("ends a countdown when the PO who goes leaves nobody to stop it", () => {
    let state = room(["ann", WHO], { autoAdvance: true });
    state = act(state, "ann", { type: "transferOwner", to: WHO });
    state = act(state, WHO, { type: "queueAdd", items: [{ title: "Next" }] });
    state = started(state);
    state = revealed(vote(state, "ann", "3"));
    state = act(state, WHO, { type: "setFinal", card: "3" });
    expect(state.round?.advanceAt).toBe(T0 + AUTO_ADVANCE_MS);
    state = away(state, "ann");
    const result = remove(state);
    expect(result.state.round?.advanceAt).toBeUndefined();
  });
});

describe("in any room", () => {
  const people = ["ann", "ben", WHO, "cleo"];
  const step = fc.oneof(
    fc.record({ who: fc.constantFrom(...people), type: fc.constant("join" as const) }),
    fc.record({ who: fc.constantFrom(...people), type: fc.constant("leave" as const) }),
    fc.record({ who: fc.constantFrom(...people), type: fc.constant("vote" as const) }),
    fc.record({ who: fc.constantFrom(...people), type: fc.constant("transfer" as const) }),
    fc.record({ who: fc.constantFrom(...people), type: fc.constant("claim" as const) }),
    fc.constant({ who: "", type: "round" as const }),
    fc.constant({ who: "", type: "reveal" as const }),
  );

  const mayTake = fc.option(fc.subarray(["ann", "ben", "cleo"]), { nil: undefined });

  function played(steps: readonly { who: string; type: string }[], anonymous: boolean): RoomState {
    let state = room(["ann"], { revealNames: !anonymous, allowChangeAfterReveal: true });
    let now = T0;
    for (const { who, type } of steps) {
      now += 300_000;
      const commands: Record<string, [string, Command]> = {
        join: [who, { type: "join", name: `Name of ${who}`, role: "voter" }],
        leave: [who, { type: "leave" }],
        vote: [who, { type: "castVote", card: "5" }],
        transfer: [state.ownerId, { type: "transferOwner", to: who }],
        claim: [who, { type: "claimOwner" }],
        round: [state.ownerId, { type: "startRound", subject: { kind: "none" } }],
        reveal: [state.ownerId, { type: "reveal" }],
      };
      const entry = commands[type];
      if (entry) state = apply(state, entry[1], { actor: entry[0], now }).state;
    }
    return state;
  }

  it("leaves nothing of the id, keeps every revealed card, and does nothing the second time", () => {
    fc.assert(
      fc.property(
        fc.array(step, { maxLength: 24 }),
        fc.boolean(),
        mayTake,
        (steps, hidden, may) => {
          const state = played(steps, hidden);
          const result = remove(state, undefined, T0 + 10_000_000, may);
          const others = Object.keys(state.participants).filter((id) => id !== WHO);
          if (keeperOf(state) === WHO && others.length === 0) {
            expect(result.state).toBe(state);
            return;
          }
          expect(JSON.stringify(result.state)).not.toContain(WHO);
          expect(JSON.stringify(result.state)).not.toContain(`Name of ${WHO}`);
          const round = state.round;
          if (round?.phase === "revealed") {
            const cards = (votes: Record<string, { card: string }> | undefined) =>
              Object.values(votes ?? {})
                .map(({ card }) => card)
                .sort();
            expect(cards(result.state.round?.votes)).toEqual(cards(round.votes));
          }
          const again = remove(result.state, undefined, T0 + 10_000_000, may);
          expect(again.state).toBe(result.state);
          if (result.state.ownerId === VACANT || may === undefined) return;
          const taken = result.state.ownerId !== state.ownerId;
          if (taken) expect(may).toContain(result.state.ownerId);
        },
      ),
      { numRuns: 300 },
    );
  });
});
