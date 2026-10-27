/**
 * The secrecy promise, as properties over realistic rooms (random command sequences run
 * through the domain's `apply`):
 * - while Voting, nobody sees another person's card;
 * - in an anonymous round, before and after reveal, nothing ties a person to a card;
 * - the order in which votes were cast never shows in an anonymous snapshot.
 */
import { apply, deckCards, type RoomState, type Round, type UserId, type Vote } from "@pp/domain";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { cardLeaks } from "./leak-scan.ts";
import { toSnapshot } from "./project.ts";
import { snapshotSchema } from "./schemas.ts";
import {
  type Frame,
  meta,
  OWNER,
  PEOPLE,
  play,
  START,
  scenarioArb,
  VIEWERS,
} from "./test-support.ts";

const RUNS = { numRuns: 150 };

function withVotes(state: RoomState, round: Round, votes: Record<UserId, Vote>): RoomState {
  return { ...state, round: { ...round, votes } };
}

/** The state with every other person's card swapped for another card of the round. */
function withOtherCards(state: RoomState, round: Round, viewer: UserId): RoomState {
  const cards = deckCards(round.deck, round.specials);
  const votes = Object.fromEntries(
    Object.entries(round.votes).map(([who, vote]) => {
      if (who === viewer) return [who, vote];
      const next = cards[(cards.indexOf(vote.card) + 1) % cards.length] ?? vote.card;
      return [who, { ...vote, card: next }];
    }),
  );
  return withVotes(state, round, votes);
}

/** The state with the other people's votes (card and flag) moved one person along. */
function withVotesRotated(state: RoomState, round: Round, viewer: UserId): RoomState {
  const holders = Object.keys(round.votes)
    .filter((who) => who !== viewer)
    .sort();
  const votes = { ...round.votes };
  for (const [i, who] of holders.entries()) {
    const from = holders[(i + 1) % holders.length];
    const vote = from === undefined ? undefined : round.votes[from];
    if (vote) votes[who] = vote;
  }
  return withVotes(state, round, votes);
}

/** The same votes, inserted in reverse order (the record's order is the casting order). */
function withVotesReversed(state: RoomState, round: Round): RoomState {
  return withVotes(state, round, Object.fromEntries(Object.entries(round.votes).reverse()));
}

function forEachView(
  frames: readonly Frame[],
  check: (frame: Frame, round: Round, viewer: UserId) => void,
) {
  for (const frame of frames) {
    const round = frame.state.round;
    if (!round) continue;
    for (const viewer of VIEWERS) check(frame, round, viewer);
  }
}

describe("while Voting", () => {
  it("no snapshot holds another person's card, anywhere", () => {
    fc.assert(
      fc.property(scenarioArb, (steps) => {
        forEachView(play(steps), (frame, round, viewer) => {
          if (round.phase !== "voting") return;
          const snapshot = toSnapshot(frame.state, viewer, meta(frame));
          const labels = new Set([
            ...deckCards(round.deck, round.specials),
            ...Object.values(round.votes).map((v) => v.card),
          ]);
          expect(cardLeaks(snapshot, labels)).toEqual([]);
          const own = Object.hasOwn(round.votes, viewer) ? round.votes[viewer] : undefined;
          expect(snapshot.room.round?.yourVote).toBe(own?.card);
        });
      }),
      RUNS,
    );
  });

  it("a snapshot stays the same whatever the others voted", () => {
    fc.assert(
      fc.property(scenarioArb, (steps) => {
        forEachView(play(steps), (frame, round, viewer) => {
          if (round.phase !== "voting") return;
          const other = withOtherCards(frame.state, round, viewer);
          expect(toSnapshot(other, viewer, meta(frame))).toStrictEqual(
            toSnapshot(frame.state, viewer, meta(frame)),
          );
        });
      }),
      RUNS,
    );
  });
});

describe("in an anonymous round", () => {
  it("swapping the others' votes between them never changes a snapshot, before or after reveal", () => {
    let revealed = 0;
    fc.assert(
      fc.property(scenarioArb, (steps) => {
        forEachView(play(steps), (frame, round, viewer) => {
          if (!round.anonymous) return;
          const others = Object.entries(round.votes).filter(([who]) => who !== viewer);
          // Count the views where a swap really moves a card from one person to another.
          if (round.phase === "revealed" && new Set(others.map(([, v]) => v.card)).size > 1) {
            revealed++;
          }
          const swapped = withVotesRotated(frame.state, round, viewer);
          expect(toSnapshot(swapped, viewer, meta(frame))).toStrictEqual(
            toSnapshot(frame.state, viewer, meta(frame)),
          );
        });
      }),
      RUNS,
    );
    // The generator must reach anonymous reveals with different cards, or this proves nothing.
    expect(revealed).toBeGreaterThan(100);
  });

  it("no cause names a voter after reveal, and no cause but finalSet carries a card", () => {
    fc.assert(
      fc.property(scenarioArb, (steps) => {
        forEachView(play(steps), (frame, round, viewer) => {
          const { causes } = toSnapshot(frame.state, viewer, meta(frame));
          for (const cause of causes) {
            if ("card" in cause) expect(cause.type).toBe("finalSet");
            if (round.anonymous && round.phase === "revealed") {
              if (cause.type === "voteCast" || cause.type === "voteRetracted") {
                expect(cause).toStrictEqual({ type: cause.type });
              }
            }
          }
        });
      }),
      RUNS,
    );
  });

  it("once revealed, the cards, results and who voted never change until the next round", () => {
    // One snapshot at a time cannot see this: a change between two snapshots, by someone
    // the viewer can pick out, ties that person to a card.
    let compared = 0;
    fc.assert(
      fc.property(scenarioArb, (steps) => {
        const frames = play(steps);
        for (const viewer of VIEWERS) {
          let locked: { round: string; view: string } | undefined;
          for (const frame of frames) {
            const round = toSnapshot(frame.state, viewer, meta(frame)).room.round;
            if (round?.phase !== "revealed" || !round.anonymous) {
              locked = undefined;
              continue;
            }
            const key = `${round.number}@${round.startedAt}`;
            // `voted` as a set: a voter who leaves moves to the end of the list, by design.
            const view = JSON.stringify({
              cards: round.cards,
              results: round.results,
              voted: [...round.voted].sort(),
            });
            if (locked?.round === key) {
              expect(view).toBe(locked.view);
              compared++;
            } else {
              locked = { round: key, view };
            }
          }
        }
      }),
      RUNS,
    );
    // The generator must reach later snapshots of anonymous reveals, or this proves nothing.
    expect(compared).toBeGreaterThan(300);
  });

  it("the order the votes were cast in never shows", () => {
    fc.assert(
      fc.property(scenarioArb, (steps) => {
        forEachView(play(steps), (frame, round, viewer) => {
          if (!round.anonymous) return;
          const reversed = withVotesReversed(frame.state, round);
          expect(JSON.stringify(toSnapshot(reversed, viewer, meta(frame)))).toBe(
            JSON.stringify(toSnapshot(frame.state, viewer, meta(frame))),
          );
        });
      }),
      RUNS,
    );
  });

  it("casting the same votes in any order gives the same snapshots, before and after reveal", () => {
    const voters = PEOPLE.slice(0, 4);
    const cards = ["1", "3", "3", "8"];
    const setUp = play([
      ...voters.map((who) => ({
        actor: who,
        dt: 1,
        command: { type: "join" as const, name: "someone", role: "voter" as const },
      })),
      {
        actor: OWNER,
        dt: 1,
        command: {
          type: "updateSettings" as const,
          patch: { revealNames: false, revealWhenAllVoted: false },
        },
      },
      { actor: OWNER, dt: 1, command: { type: "startRound" as const, subject: { kind: "none" } } },
    ]);
    const start = setUp.at(-1)?.state;
    if (!start) throw new Error("no state");

    const views = (order: readonly number[]) => {
      let state = start;
      for (const i of order) {
        const who = voters[i] ?? OWNER;
        state = apply(
          state,
          { type: "castVote", card: cards[i] ?? "1" },
          { actor: who, now: START },
        ).state;
      }
      const voting = VIEWERS.map((v) =>
        JSON.stringify(toSnapshot(state, v, { code: "c", version: 1, now: START })),
      );
      const result = apply(state, { type: "reveal" }, { actor: OWNER, now: START + 1 });
      const after = VIEWERS.map((v) =>
        JSON.stringify(
          toSnapshot(result.state, v, {
            code: "c",
            version: 2,
            now: START + 1,
            causes: result.causes,
          }),
        ),
      );
      return { voting, after, revealed: result.state.round?.phase };
    };

    const baseline = views([0, 1, 2, 3]);
    expect(baseline.revealed).toBe("revealed");
    fc.assert(
      fc.property(fc.shuffledSubarray([0, 1, 2, 3], { minLength: 4 }), (order) => {
        expect(views(order)).toStrictEqual(baseline);
      }),
      { numRuns: 50 },
    );
  });
});

describe("snapshots", () => {
  it("round-trip through JSON and the schema unchanged", () => {
    fc.assert(
      fc.property(scenarioArb, (steps) => {
        for (const frame of play(steps)) {
          for (const viewer of VIEWERS) {
            const snapshot = toSnapshot(frame.state, viewer, meta(frame));
            expect(snapshotSchema.parse(JSON.parse(JSON.stringify(snapshot)))).toStrictEqual(
              snapshot,
            );
          }
        }
      }),
      RUNS,
    );
  });
});
