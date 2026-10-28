import { computeResults } from "@pp/domain";
import { describe, expect, it } from "vitest";
import { nextRound, play, revealedRoom, T0, votingRoom } from "./fixtures.ts";
import {
  type EndedRound,
  historyRound,
  historyRow,
  historyView,
  isHistory,
  type StoredHistoryRound,
} from "./history.ts";

function ended(state = revealedRoom(), finishedAt = T0 + 20): EndedRound {
  const { ended: round } = nextRound(state, finishedAt);
  return { round, participants: state.participants, finishedAt };
}

describe("historyRow", () => {
  it("keeps who, name and card of a named round, in joining order", () => {
    const row = historyRow("room-1", ended());
    expect(row).toEqual({
      roomId: "room-1",
      number: 1,
      subject: { kind: "title", text: "Login page" },
      deck: { spec: { kind: "preset", id: "fib" }, specials: ["?", "☕"] },
      votes: {
        kind: "named",
        votes: [
          { who: "u2", name: "Bob", card: "5" },
          { who: "u3", name: "Cy", card: "8" },
        ],
      },
      stats: computeResults(["5", "8"], { kind: "preset", id: "fib" }),
      final: null,
      startedAt: new Date(T0 + 4),
      revealedAt: new Date(T0 + 10),
      finishedAt: new Date(T0 + 20),
    });
  });

  it("keeps the final estimate and a vote changed after reveal", () => {
    let s = play(votingRoom(), "u1", {
      type: "updateSettings",
      patch: { allowChangeAfterReveal: true },
    });
    s = play(s, "u1", { type: "reveal" }, T0 + 10);
    s = play(s, "u2", { type: "castVote", card: "8" }, T0 + 11);
    s = play(s, "u1", { type: "setFinal", card: "8" }, T0 + 12);
    const row = historyRow("r", ended(s));
    expect(row.final).toBe("8");
    expect(row.votes).toEqual({
      kind: "named",
      votes: [
        { who: "u2", name: "Bob", card: "8", changedAfterReveal: true },
        { who: "u3", name: "Cy", card: "8" },
      ],
    });
  });

  it("keeps the card of a voter who left after the others, with the name the vote kept (#19)", () => {
    const s = play(revealedRoom(), "u2", { type: "leave" }, T0 + 11);
    expect(historyRow("r", ended(s)).votes).toEqual({
      kind: "named",
      votes: [
        { who: "u3", name: "Cy", card: "8" },
        { who: "u2", name: "Bob", card: "5" },
      ],
    });
  });

  it("never looks a departed id up on Object.prototype", () => {
    const base = ended();
    const round = { ...base.round, votes: { constructor: { card: "3" } } };
    expect(historyRow("r", { ...base, round }).votes).toEqual({
      kind: "named",
      votes: [{ who: "constructor", name: null, card: "3" }],
    });
  });

  it("keeps only the cards of an anonymous round, in display order", () => {
    let s = votingRoom({ anonymous: true });
    // The last vote reveals the round (revealWhenAllVoted).
    s = play(s, "u1", { type: "castVote", card: "?" }, T0 + 7);
    const row = historyRow("r", ended(s));
    expect(row.votes).toEqual({ kind: "anonymous", cards: ["5", "8", "?"] });
    // Nothing in the row maps a person to a card: no user id and no name anywhere.
    const text = JSON.stringify(row);
    for (const leak of ["u1", "u2", "u3", "Ada", "Bob", "Cy"]) {
      expect(text).not.toContain(leak);
    }
  });

  it("orders anonymous cards by the deck whatever the order of the votes", () => {
    let s = votingRoom({ anonymous: true });
    // The last vote reveals the round (revealWhenAllVoted).
    s = play(s, "u1", { type: "castVote", card: "1" }, T0 + 7);
    expect(historyRow("r", ended(s)).votes).toEqual({
      kind: "anonymous",
      cards: ["1", "5", "8"],
    });
  });

  it("falls back to startedAt when a round has no revealedAt", () => {
    const base = ended();
    const { revealedAt: _, ...round } = base.round;
    expect(historyRow("r", { ...base, round }).revealedAt).toEqual(new Date(T0 + 4));
  });
});

describe("historyRound", () => {
  it("is the ended round when a command ended one", () => {
    const before = revealedRoom();
    const { state, ended: round } = nextRound(before);
    expect(historyRound(before, state, round)).toBe(round);
  });

  it("is the revealed round once its final is set or changed, before any next round (#32)", () => {
    const before = revealedRoom();
    const decided = play(before, "u1", { type: "setFinal", card: "8" }, T0 + 12);
    expect(historyRound(before, decided)).toBe(decided.round);
    const changed = play(decided, "u1", { type: "setFinal", card: "5" }, T0 + 13);
    expect(historyRound(decided, changed)?.final).toBe("5");
    // A vote changed after the decision rewrites the row too.
    let open = play(revealedRoom(), "u1", {
      type: "updateSettings",
      patch: { allowChangeAfterReveal: true },
    });
    open = play(open, "u1", { type: "setFinal", card: "8" }, T0 + 12);
    const revised = play(open, "u2", { type: "castVote", card: "8" }, T0 + 14);
    expect(historyRound(open, revised)).toBe(revised.round);
  });

  it("is nothing for a revealed round without a final, a round left as it was, or a voting round", () => {
    const revealed = revealedRoom();
    expect(historyRound(votingRoom(), revealed)).toBeUndefined();
    const decided = play(revealed, "u1", { type: "setFinal", card: "8" }, T0 + 12);
    // Someone joins: the round on the table is the same object, nothing to write again.
    const joined = play(decided, "u4", { type: "join", name: "Dee", role: "voter" }, T0 + 15);
    expect(historyRound(decided, joined)).toBeUndefined();
    expect(historyRound(votingRoom(), votingRoom())).toBeUndefined();
  });
});

describe("isHistory", () => {
  it("accepts a revealed round only", () => {
    expect(isHistory(ended())).toBe(true);
    const { ended: voting } = nextRound(votingRoom());
    expect(isHistory({ round: voting, participants: {}, finishedAt: T0 })).toBe(false);
    expect(isHistory(undefined)).toBe(false);
  });
});

describe("historyView", () => {
  it("sends a named round without its voters' ids, times in milliseconds", () => {
    let s = play(votingRoom(), "u1", {
      type: "updateSettings",
      patch: { allowChangeAfterReveal: true },
    });
    s = play(s, "u1", { type: "reveal" }, T0 + 10);
    s = play(s, "u2", { type: "castVote", card: "8" }, T0 + 11);
    const row = historyRow("room-1", ended(s));
    const view = historyView({ ...row, final: "8" } as StoredHistoryRound);
    expect(view).toEqual({
      number: 1,
      subject: { kind: "title", text: "Login page" },
      final: "8",
      stats: row.stats,
      startedAt: T0 + 4,
      revealedAt: T0 + 10,
      finishedAt: T0 + 20,
      votes: {
        kind: "named",
        votes: [
          { name: "Bob", card: "8", changedAfterReveal: true },
          { name: "Cy", card: "8" },
        ],
      },
    });
    expect(JSON.stringify(view)).not.toMatch(/"u[0-9]"|"who"|room-1|deck/);
  });

  it("sends an anonymous round's cards as stored, and nothing else about its voters", () => {
    const row = historyRow("room-1", ended(revealedRoom({ anonymous: true })));
    const view = historyView(row as StoredHistoryRound);
    expect(view.votes).toEqual({ kind: "anonymous", cards: ["5", "8"] });
    expect(JSON.stringify(view)).not.toMatch(/Bob|Cy|"u[0-9]"/);
  });
});
