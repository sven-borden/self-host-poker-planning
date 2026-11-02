/**
 * A guest who signs in after an anonymous reveal (#48, ADR-025): nobody at the table may learn
 * which card was whose from the move. So a third person's frames, before and after it, must not
 * depend on who held what: deal the same cards differently among everyone but that person, and
 * the frames come out byte for byte the same, in every combination of the guest and the account
 * being seated or not, with a card or without.
 */
import { apply, type Command, createRoom, type RoomState } from "@pp/domain";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { toSnapshot } from "./project.ts";

const T0 = 1_700_000_000_000;
const GUEST = "guest";
const ACCOUNT = "account";
const VIEWER = "ben";
const FILLERS = ["cleo", "dan"];
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

const COMBINATIONS = SIDES.flatMap((guest) => SIDES.map((account) => ({ guest, account })));

const act = (state: RoomState, actor: string, command: Command) =>
  apply(state, command, { actor, now: T0 }).state;

/** Everyone joins and votes as `dealt` says; the round reveals; then the seatless leave. */
function revealedRoom(
  guest: Side,
  account: Side,
  owner: string,
  poVotes: boolean,
  dealt: Record<string, string>,
): RoomState {
  let state = createRoom({ ownerId: owner });
  state = {
    ...state,
    settings: { ...state.settings, revealNames: false, revealWhenAllVoted: false, poVotes },
  };
  const everyone = [VIEWER, ...FILLERS, GUEST, ACCOUNT];
  for (const who of everyone) {
    state = act(state, who, { type: "join", name: `Name of ${who}`, role: "voter" });
  }
  state = act(state, owner, { type: "startRound", subject: { kind: "none" } });
  for (const who of everyone) {
    const skips = (who === GUEST && !guest.card) || (who === ACCOUNT && !account.card);
    const card = dealt[who];
    if (!skips && card !== undefined) state = act(state, who, { type: "castVote", card });
  }
  state = act(state, owner, { type: "reveal" });
  if (!guest.seated) state = act(state, GUEST, { type: "leave" });
  if (!account.seated) state = act(state, ACCOUNT, { type: "leave" });
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

/** What the viewer's socket gets before the move and after it, as the bytes it gets. */
function frames(state: RoomState): string {
  const moved = apply(
    state,
    { type: "moveGuest", guest: GUEST, account: ACCOUNT },
    { actor: ":server", now: T0 + 5 },
  );
  const meta = { code: "ROOM", version: 1, now: T0 };
  return JSON.stringify([
    toSnapshot(state, VIEWER, meta),
    toSnapshot(moved.state, VIEWER, { ...meta, version: 2, causes: moved.causes }),
  ]);
}

const deal = fc.record({
  owner: fc.constantFrom(VIEWER, "dan", GUEST, ACCOUNT),
  poVotes: fc.boolean(),
  dealt: fc.record(
    Object.fromEntries(
      [VIEWER, ...FILLERS, GUEST, ACCOUNT].map((who) => [who, fc.constantFrom(...CARDS)]),
    ),
  ),
  order: fc.array(fc.integer(), { minLength: 5, maxLength: 5 }),
});

describe("an anonymous reveal, through a sign-in", () => {
  for (const { guest, account } of COMBINATIONS) {
    const name = (side: Side) =>
      `${side.seated ? "seated" : "gone"}, ${side.card ? "with" : "without"} a card`;

    it(`shows a third person nothing of who held what: guest ${name(guest)}, account ${name(account)}`, () => {
      let dealtDifferently = 0;
      fc.assert(
        fc.property(deal, ({ owner, poVotes, dealt, order }) => {
          const state = revealedRoom(guest, account, owner, poVotes, dealt);
          const other = redealt(state, order);
          if (JSON.stringify(other.round?.votes) !== JSON.stringify(state.round?.votes)) {
            dealtDifferently += 1;
          }
          expect(frames(other)).toBe(frames(state));
        }),
        { numRuns: 120 },
      );
      // The property says nothing unless cards really changed hands.
      expect(dealtDifferently).toBeGreaterThan(0);
    });
  }

  it("keeps every card on the table through the move", () => {
    const dealt = { ben: "1", cleo: "2", dan: "3", guest: "5", account: "8" };
    const seated = { seated: true, card: true };
    const state = revealedRoom(seated, seated, "dan", true, dealt);
    const [before, after] = JSON.parse(frames(state)) as [Frame, Frame];
    expect(before.room.round.cards).toEqual(["1", "2", "3", "5", "8"]);
    expect(after.room.round.cards).toEqual(before.room.round.cards);
  });
});

interface Frame {
  room: { round: { cards: string[] } };
}
