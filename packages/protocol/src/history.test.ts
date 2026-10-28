import { describe, expect, it } from "vitest";
import {
  HISTORY_PAGE,
  type HistoryRoundView,
  historyAckSchema,
  historyRoundSchema,
  parseHistoryRequest,
} from "./history.ts";
import { historyLeaks } from "./leak-scan.ts";

const stats = {
  distribution: [
    { card: "3", count: 1 },
    { card: "5", count: 2 },
  ],
  core: ["3", "5"],
  mode: "5",
  agreement: 2 / 3,
  spread: ["3", "5"] as [string, string],
  consensus: false,
  average: 13 / 3,
  median: 5,
  suggested: "5",
};

const named: HistoryRoundView = {
  number: 2,
  subject: { kind: "link", url: "https://acme.atlassian.net/browse/PAY-482", key: "PAY-482" },
  final: "5",
  stats,
  startedAt: 1_000,
  revealedAt: 134_000,
  finishedAt: 200_000,
  votes: {
    kind: "named",
    votes: [
      { name: "Ana", card: "5" },
      { name: "Ben", card: "3", changedAfterReveal: true },
      { name: null, card: "5" },
    ],
  },
};

const anonymous: HistoryRoundView = {
  ...named,
  number: 1,
  subject: { kind: "none" },
  final: null,
  votes: { kind: "anonymous", cards: ["3", "5", "5"] },
};

describe("parseHistoryRequest", () => {
  it("takes nothing, an empty object, a cursor and a limit", () => {
    expect(parseHistoryRequest(undefined)).toEqual({ ok: true, request: {} });
    expect(parseHistoryRequest({})).toEqual({ ok: true, request: {} });
    expect(parseHistoryRequest({ before: 21, limit: 50 })).toEqual({
      ok: true,
      request: { before: 21, limit: 50 },
    });
  });

  it.each([
    ["a limit over the most a page holds", { limit: HISTORY_PAGE.max + 1 }],
    ["a limit of 0", { limit: 0 }],
    ["a fractional limit", { limit: 2.5 }],
    ["a cursor of 0", { before: 0 }],
    ["a cursor that is not a number", { before: "21" }],
    ["an unsafe integer", { before: 2 ** 60 }],
    ["an unknown field", { before: 3, room: "x" }],
    ["a string", "history"],
    ["null", null],
  ])("refuses %s", (_, input) => {
    expect(parseHistoryRequest(input)).toEqual({ ok: false, code: "bad_payload" });
  });

  it("pages 20 rounds by default, at most 50", () => {
    expect(HISTORY_PAGE).toEqual({ size: 20, max: 50 });
  });
});

describe("historyAckSchema", () => {
  it("parses a page with a named and an anonymous round, and its cursor", () => {
    const ack = { ok: true, rounds: [named, anonymous], next: 1 };
    expect(historyAckSchema.parse(ack)).toEqual(ack);
    expect(historyAckSchema.parse({ ok: false, code: "not_participant" })).toEqual({
      ok: false,
      code: "not_participant",
    });
  });

  it("refuses a user id beside a named vote, a name in an anonymous round, and any stray field", () => {
    const withWho = {
      ...named,
      votes: { kind: "named", votes: [{ who: "u-1", name: "Ana", card: "5" }] },
    };
    const withNames = { ...anonymous, votes: { kind: "anonymous", cards: ["5"], names: ["Ana"] } };
    for (const row of [
      withWho,
      withNames,
      { ...named, deck: { kind: "preset", id: "fib" } },
      { ...named, stats: { ...stats, voters: ["u-1"] } },
      { ...named, subject: { kind: "title", text: "x", by: "u-1" } },
    ]) {
      expect(historyRoundSchema.safeParse(row).success).toBe(false);
    }
    expect(historyAckSchema.safeParse({ ok: true, rounds: [], room: "x" }).success).toBe(false);
  });
});

describe("historyLeaks", () => {
  const people = { ids: ["u-ana", "u-ben"], names: ["Ana", "Ben"] };

  it("finds nothing in a clean page", () => {
    expect(historyLeaks({ ok: true, rounds: [named, anonymous] }, people)).toEqual([]);
    expect(historyLeaks({ ok: false, code: "internal" }, people)).toEqual([]);
    expect(historyLeaks(null, people)).toEqual([]);
  });

  it("finds a user id or a `who` in any row", () => {
    const row = {
      ...named,
      votes: { kind: "named", votes: [{ who: "x", name: "Ana", card: "5" }] },
      subject: { kind: "title", text: "u-ben" },
    };
    expect(historyLeaks({ rounds: [row] }, people)).toEqual([
      { path: "rounds.0.subject.text", value: "u-ben" },
      { path: "rounds.0.votes.votes.0.who", value: "who" },
    ]);
  });

  it("finds a user id inside a longer string", () => {
    const row = { ...named, subject: { kind: "title", text: "Estimate for u-ana tomorrow" } };
    expect(historyLeaks({ rounds: [row] }, people)).toEqual([
      { path: "rounds.0.subject.text", value: "Estimate for u-ana tomorrow" },
    ]);
  });

  it("finds a user id, or a `who`, used as a key, whatever its value", () => {
    const row = { ...named, stats: { ...stats, byPerson: { "u-ben": 3 } }, votes: { who: 7 } };
    expect(historyLeaks({ rounds: [row] }, people)).toEqual([
      { path: "rounds.0.stats.byPerson.u-ben", value: "u-ben" },
      { path: "rounds.0.votes.who", value: "who" },
    ]);
  });

  it("finds a name, or a name field, in an anonymous row only", () => {
    const row = {
      ...anonymous,
      subject: { kind: "title", text: "Ben" },
      votes: { kind: "anonymous", cards: ["5"], name: "Someone" },
    };
    expect(historyLeaks({ rounds: [named, row] }, people)).toEqual([
      { path: "rounds.1.subject.text", value: "Ben" },
      { path: "rounds.1.votes.name", value: "name" },
    ]);
  });

  it("finds a name used as a key in an anonymous row", () => {
    const row = { ...anonymous, votes: { kind: "anonymous", cards: ["5"], byName: { Ana: 1 } } };
    expect(historyLeaks({ rounds: [row] }, people)).toEqual([
      { path: "rounds.0.votes.byName.Ana", value: "Ana" },
    ]);
  });
});
