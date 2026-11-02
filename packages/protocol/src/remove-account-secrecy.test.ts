/**
 * An account deleted after an anonymous reveal or while one votes (#51, ADR-029): nobody at the
 * table may learn which card was the person's, then or later. So a third person's frames, before
 * and after it, must not depend on who held what: deal the same cards differently among everyone
 * but that viewer, and the frames come out byte for byte the same, whether the person is seated
 * or gone, holds a card or not, is the PO, the keeper or neither, whoever takes over, and whether
 * a room's rule lets anyone take it at all.
 */
import { apply, type Command, createRoom, type RoomState } from "@pp/domain";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { toSnapshot } from "./project.ts";

const T0 = 1_700_000_000_000;
const WHO = "person";
const VIEWER = "ben";
const FILLERS = ["cleo", "dan"];
const GHOST = "a-new-random-id";
const VACANT = "another-new-random-id";
const CARDS = ["1", "2", "3", "5", "8", "13"] as const;

interface Side {
  seated: boolean;
  card: boolean;
}

const SIDES: readonly Side[] = [
  { seated: true, card: true },
  { seated: true, card: false },
  { seated: false, card: true },
  { seated: false, card: false },
];

const act = (state: RoomState, actor: string, command: Command) =>
  apply(state, command, { actor, now: T0 }).state;

/** Everyone joins and votes as `dealt` says, the round reveals, and then the seatless leave. */
function revealedRoom(
  person: Side,
  owner: string,
  poVotes: boolean,
  dealt: Record<string, string>,
  keeper = owner,
): RoomState {
  let state = createRoom({ ownerId: owner });
  state = {
    ...state,
    keeperId: keeper,
    settings: { ...state.settings, revealNames: false, revealWhenAllVoted: false, poVotes },
  };
  const everyone = [VIEWER, ...FILLERS, WHO];
  for (const who of everyone) {
    state = act(state, who, { type: "join", name: `Name of ${who}`, role: "voter" });
  }
  state = act(state, owner, { type: "startRound", subject: { kind: "none" } });
  for (const who of everyone) {
    const card = dealt[who];
    if (card !== undefined && (who !== WHO || person.card)) {
      state = act(state, who, { type: "castVote", card });
    }
  }
  state = act(state, owner, { type: "reveal" });
  if (!person.seated) state = act(state, WHO, { type: "leave" });
  return state;
}

/** The same room with the cards dealt anew among everyone but the viewer, in `order`. */
function redealt(state: RoomState, order: readonly number[]): RoomState {
  const round = state.round;
  if (!round) throw new Error("no round");
  const holders = Object.keys(round.votes).filter((who) => who !== VIEWER);
  const cards = holders
    .map((who, i) => ({ card: round.votes[who]?.card ?? "", key: order[i] ?? 0 }))
    .sort((a, b) => a.key - b.key)
    .map(({ card }) => card);
  const votes = { ...round.votes };
  holders.forEach((who, i) => {
    const vote = votes[who];
    if (vote) votes[who] = { ...vote, card: cards[i] ?? vote.card };
  });
  return { ...state, round: { ...round, votes } };
}

/** What the viewer's socket gets before the deletion and after it, as the bytes it gets. */
function frames(
  state: RoomState,
  heir?: string,
  mayTake?: readonly string[],
  vacate?: true,
): string {
  const command: Command = {
    type: "removeAccount",
    who: WHO,
    ghost: GHOST,
    vacant: VACANT,
    ...(heir !== undefined && { heir }),
    ...(mayTake !== undefined && { mayTake }),
    ...(vacate && { vacate }),
  };
  const gone = apply(state, command, { actor: ":server", now: T0 + 5 });
  const meta = { code: "ROOM", version: 1, now: T0 };
  return JSON.stringify([
    toSnapshot(state, VIEWER, meta),
    toSnapshot(gone.state, VIEWER, { ...meta, version: 2, causes: gone.causes }),
  ]);
}

const deal = fc.record({
  owner: fc.constantFrom(VIEWER, "dan", WHO),
  keeper: fc.constantFrom(VIEWER, "dan", WHO),
  poVotes: fc.boolean(),
  heir: fc.option(fc.constantFrom(VIEWER, "cleo", "dan"), { nil: undefined }),
  mayTake: fc.option(fc.subarray([VIEWER, "cleo", "dan"]), { nil: undefined }),
  vacate: fc.constantFrom(undefined, true as const),
  dealt: fc.record(
    Object.fromEntries([VIEWER, ...FILLERS, WHO].map((who) => [who, fc.constantFrom(...CARDS)])),
  ),
  order: fc.array(fc.integer(), { minLength: 4, maxLength: 4 }),
});

describe("an anonymous reveal, through an account's deletion", () => {
  for (const person of SIDES) {
    const name = `${person.seated ? "seated" : "gone"}, ${person.card ? "with" : "without"} a card`;

    it(`shows a third person nothing of who held what: ${name}`, () => {
      let dealtDifferently = 0;
      fc.assert(
        fc.property(deal, ({ owner, keeper, poVotes, heir, mayTake, vacate, dealt, order }) => {
          const state = revealedRoom(person, owner, poVotes, dealt, keeper);
          const other = redealt(state, order);
          if (JSON.stringify(other.round?.votes) !== JSON.stringify(state.round?.votes)) {
            dealtDifferently += 1;
          }
          expect(frames(other, heir, mayTake, vacate)).toBe(frames(state, heir, mayTake, vacate));
        }),
        { numRuns: 120 },
      );
      // The property says nothing unless cards really changed hands.
      expect(dealtDifferently).toBeGreaterThan(0);
    });
  }

  it("keeps every card on the table, and the person's id in no frame after it", () => {
    const dealt = { ben: "1", cleo: "2", dan: "3", person: "8" };
    const state = revealedRoom({ seated: true, card: true }, "dan", true, dealt);
    const [before, after] = JSON.parse(frames(state)) as [Frame, Frame];
    expect(before.room.round.cards).toEqual(["1", "2", "3", "8"]);
    expect(after.room.round.cards).toEqual(before.room.round.cards);
    expect(JSON.stringify(after.room)).not.toContain(WHO);
    expect(JSON.stringify(after.room)).not.toContain(`Name of ${WHO}`);
  });

  it("says nothing of a card in a round still voting: only that the person left", () => {
    let state = createRoom({ ownerId: "dan" });
    state = { ...state, settings: { ...state.settings, revealNames: false } };
    for (const who of [VIEWER, "dan", WHO]) {
      state = act(state, who, { type: "join", name: `Name of ${who}`, role: "voter" });
    }
    state = act(state, "dan", { type: "startRound", subject: { kind: "none" } });
    state = act(state, WHO, { type: "castVote", card: "13" });
    const text = frames(state);
    expect(text).not.toContain('"13"');
  });
});

interface Frame {
  room: { round: { cards: string[] } };
}
