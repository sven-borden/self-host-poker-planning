import { apply, type Command, createRoom, type Participant, type RoomState } from "@pp/domain";
import { toSnapshot } from "@pp/protocol";
import { describe, expect, it } from "vitest";
import { isRoomFull } from "./room-full.ts";
import { handView, tableData, voteCount } from "./table-data.ts";

function roomWith(
  people: Array<[string, Participant["role"]]>,
  settings: Partial<RoomState["settings"]> = {},
): RoomState {
  const state = createRoom({ ownerId: "u0" });
  const participants: Record<string, Participant> = {};
  people.forEach(([id, role], i) => {
    participants[id] = { name: `Name ${id}`, role, joinedAt: i + 1, connected: true };
  });
  return { ...state, settings: { ...state.settings, ...settings }, participants };
}

const view = (state: RoomState, viewer: string) =>
  toSnapshot(state, viewer, { code: "abc", version: 1, now: 0 }).room;

describe("tableData", () => {
  const state = roomWith([
    ["u1", "voter"],
    ["u2", "observer"],
    ["u3", "voter"],
    ["u4", "voter"],
    ["u5", "observer"],
  ]);

  it("seats voters in join order, observers in the row, everyone present", () => {
    const { people, observers } = tableData(view(state, "nobody"));
    expect(people.map((p) => p.id)).toEqual(["u1", "u3", "u4"]);
    expect(people.every((p) => p.status.kind === "present")).toBe(true);
    expect(people[0]?.name).toBe("Name u1");
    expect(observers.map(({ id, name }) => ({ id, name }))).toEqual([
      { id: "u2", name: "Name u2" },
      { id: "u5", name: "Name u5" },
    ]);
  });

  it("puts the viewer first and keeps the others clockwise in join order", () => {
    expect(tableData(view(state, "u3")).people.map((p) => p.id)).toEqual(["u3", "u4", "u1"]);
    expect(tableData(view(state, "u4")).people.map((p) => p.id)).toEqual(["u4", "u1", "u3"]);
    expect(tableData(view(state, "u1")).people.map((p) => p.id)).toEqual(["u1", "u3", "u4"]);
  });

  it("leaves the seats in join order when the viewer observes", () => {
    expect(tableData(view(state, "u2")).people.map((p) => p.id)).toEqual(["u1", "u3", "u4"]);
  });
});

describe("the table's states (#17)", () => {
  /** u0 is the PO and votes; u1 and u3 vote; u2 observes. */
  function round(): RoomState {
    let s = roomWith([
      ["u0", "voter"],
      ["u1", "voter"],
      ["u2", "observer"],
      ["u3", "voter"],
    ]);
    const run = (actor: string, command: Command) => {
      const result = apply(s, command, { actor, now: 100 });
      if (!result.ok) throw new Error(result.error);
      s = result.state;
    };
    run("u0", { type: "startRound", subject: { kind: "none" } });
    run("u1", { type: "castVote", card: "8" });
    run(":server", { type: "presence", who: "u3", connected: false });
    run(":server", { type: "presence", who: "u2", connected: false });
    return s;
  }

  it("shows who voted, who thinks and who is away; the PO and the viewer", () => {
    const { people, observers } = tableData(view(round(), "u1"));
    expect(
      people.map(({ id, status, away, owner, you }) => ({ id, status, away, owner, you })),
    ).toEqual([
      { id: "u1", status: { kind: "voted" }, away: false, owner: false, you: true },
      { id: "u3", status: { kind: "thinking" }, away: true, owner: false, you: false },
      { id: "u0", status: { kind: "thinking" }, away: false, owner: true, you: false },
    ]);
    expect(observers[0]).toMatchObject({ id: "u2", away: true, owner: false, you: false });
  });

  it("never carries a card before reveal, even for the viewer's own seat", () => {
    const data = tableData(view(round(), "u1"));
    expect(JSON.stringify(data.people)).not.toContain('"8"');
  });

  it("shows the cards of a named reveal, and only who voted or not after an anonymous one", () => {
    const revealed = (anonymous: boolean): RoomState => {
      const s = round();
      if (!s.round) throw new Error("no round");
      return { ...s, round: { ...s.round, anonymous, phase: "revealed", revealedAt: 200 } };
    };
    const named = tableData(view(revealed(false), "u0")).people;
    expect(named.map((p) => p.status)).toEqual([
      { kind: "revealed", card: null },
      { kind: "revealed", card: "8" },
      { kind: "revealed", card: null },
    ]);
    const anonymous = tableData(view(revealed(true), "u0")).people;
    // Who voted is public; no card belongs to anyone: it went to the results' columns.
    expect(anonymous.map((p) => p.status)).toEqual([
      { kind: "revealed", card: null },
      { kind: "voted", dealt: true },
      { kind: "revealed", card: null },
    ]);
  });

  it("marks the lowest and highest cards of a named reveal, never an anonymous one (#20)", () => {
    const revealed = (cards: Record<string, string>, anonymous = false): RoomState => {
      const s = round();
      if (!s.round) throw new Error("no round");
      const votes = Object.fromEntries(Object.entries(cards).map(([who, card]) => [who, { card }]));
      return {
        ...s,
        round: { ...s.round, votes, anonymous, phase: "revealed", revealedAt: 200 },
      };
    };
    const statuses = (state: RoomState) => tableData(view(state, "u0")).people.map((p) => p.status);
    expect(statuses(revealed({ u0: "3", u1: "8", u3: "13" }))).toEqual([
      { kind: "revealed", card: "3", extreme: "low" },
      { kind: "revealed", card: "8" },
      { kind: "revealed", card: "13", extreme: "high" },
    ]);
    // A special card is neither; equal cards have no spread to mark.
    expect(statuses(revealed({ u0: "?", u1: "8", u3: "8" }))).toEqual([
      { kind: "revealed", card: "?" },
      { kind: "revealed", card: "8" },
      { kind: "revealed", card: "8" },
    ]);
    expect(JSON.stringify(statuses(revealed({ u0: "3", u1: "8", u3: "13" }, true)))).not.toMatch(
      /extreme|"3"|"13"/,
    );
  });

  it("gives everyone in the room initials and a colour of their own, the same for every viewer", () => {
    const twins = roomWith(
      Array.from({ length: 12 }, (_, i): [string, Participant["role"]] => [
        `id-${i}`,
        i % 4 === 0 ? "observer" : "voter",
      ]),
    );
    for (const p of Object.values(twins.participants)) p.name = "Ana Lima";
    const looks = (viewer: string) => {
      const { people, observers } = tableData(view(twins, viewer));
      return [...people, ...observers].map((p) => `${p.id}:${p.look?.colour}:${p.look?.initials}`);
    };
    const seen = looks("id-1");
    const pairs = seen.map((entry) => entry.split(":").slice(1).join(":"));
    expect(new Set(pairs).size).toBe(12);
    expect(looks("id-5").sort()).toEqual([...seen].sort());
  });
});

describe("isRoomFull", () => {
  const people = (voters: number, observers: number) =>
    [
      ...Array.from({ length: voters }, (_, i): [string, "voter"] => [`v${i}`, "voter"]),
      ...Array.from({ length: observers }, (_, i): [string, "observer"] => [`o${i}`, "observer"]),
    ] as Array<[string, Participant["role"]]>;

  it("counts observers by default: 16 people fill the room", () => {
    expect(isRoomFull(view(roomWith(people(15, 0)), "x"))).toBe(false);
    expect(isRoomFull(view(roomWith(people(12, 4)), "x"))).toBe(true);
  });

  it("leaves room for observers when they do not count, up to the hard cap", () => {
    const loose = { observersCount: false };
    expect(isRoomFull(view(roomWith(people(16, 0), loose), "x"))).toBe(false);
    expect(isRoomFull(view(roomWith(people(16, 15), loose), "x"))).toBe(false);
    expect(isRoomFull(view(roomWith(people(16, 16), loose), "x"))).toBe(true);
  });
});

describe("the round's centre and the hand (#18)", () => {
  const step = (s: RoomState, actor: string, command: Command): RoomState => {
    const result = apply(s, command, { actor, now: 100 });
    if (!result.ok) throw new Error(result.error);
    return result.state;
  };
  const base = roomWith([
    ["u0", "voter"],
    ["u1", "voter"],
    ["u2", "voter"],
    ["u3", "observer"],
  ]);
  const voting = step(base, "u0", { type: "startRound", subject: { kind: "none" } });
  const me = (state: RoomState, id: string) => {
    const room = view(state, id);
    const person = room.participants.find((p) => p.id === id);
    if (!person) throw new Error("not in the room");
    return { room, person };
  };

  it("counts who voted out of who can vote", () => {
    const voted = step(voting, "u1", { type: "castVote", card: "5" });
    expect(voteCount(view(voted, "u3"))).toEqual({ count: 1, total: 3 });
    // The PO stops voting: one voter fewer.
    const noPo = { ...voted, settings: { ...voted.settings, poVotes: false } };
    expect(voteCount(view(noPo, "u3"))).toEqual({ count: 1, total: 2 });
    // Someone away counts only once their vote is in.
    const away = (s: RoomState, id: string): RoomState => ({
      ...s,
      participants: {
        ...s.participants,
        [id]: { ...(s.participants[id] as Participant), connected: false, awaySince: 50 },
      },
    });
    expect(voteCount(view(away(voted, "u2"), "u3"))).toEqual({ count: 1, total: 2 });
    expect(voteCount(view(away(voted, "u1"), "u3"))).toEqual({ count: 1, total: 3 });
    expect(voteCount(view(base, "u3"))).toEqual({ count: 0, total: 3 });
  });

  it("gives an observer no hand, and the PO none when the PO does not vote", () => {
    const watcher = me(voting, "u3");
    expect(handView(watcher.room, watcher.person)).toEqual({ kind: "none" });
    const noPo = { ...voting, settings: { ...voting.settings, poVotes: false } };
    const owner = me(noPo, "u0");
    expect(handView(owner.room, owner.person)).toEqual({ kind: "owner" });
    const voter = me(noPo, "u1");
    expect(handView(voter.room, voter.person)).toMatchObject({ kind: "cards", playable: true });
  });

  it("never shows a PO who does not vote as thinking or without a vote", () => {
    const noPo = (s: RoomState): RoomState => ({
      ...s,
      settings: { ...s.settings, poVotes: false },
    });
    const status = (s: RoomState) =>
      tableData(view(s, "u1")).people.find((p) => p.id === "u0")?.status;
    expect(status(noPo(voting))).toEqual({ kind: "present" });
    expect(status(voting)).toEqual({ kind: "thinking" });
    const revealed = step(voting, "u0", { type: "reveal" });
    expect(status(noPo(revealed))).toEqual({ kind: "present" });
    expect(status(revealed)).toEqual({ kind: "revealed", card: null });
    const anonymous = step(
      step(base, "u0", { type: "updateSettings", patch: { revealNames: false } }),
      "u0",
      { type: "startRound", subject: { kind: "none" } },
    );
    const hidden = step(anonymous, "u0", { type: "reveal" });
    expect(status(noPo(hidden))).toEqual({ kind: "present" });
    expect(status(hidden)).toEqual({ kind: "revealed", card: null });
  });

  it("deals the round's deck and specials, playable only while Voting", () => {
    const voter = me(voting, "u1");
    expect(handView(voter.room, voter.person)).toEqual({
      kind: "cards",
      cards: ["0", "1", "2", "3", "5", "8", "13", "21", "?", "☕"],
      playable: true,
      reason: "voting",
    });
    const tshirt = {
      ...base,
      settings: {
        ...base.settings,
        deck: { kind: "preset" as const, id: "tshirt" as const },
        specials: [],
      },
    };
    const inLobby = me(tshirt, "u1");
    expect(handView(inLobby.room, inLobby.person)).toEqual({
      kind: "cards",
      cards: ["XS", "S", "M", "L", "XL", "XXL"],
      playable: false,
      reason: "lobby",
    });
    const revealed = me(step(voting, "u0", { type: "reveal" }), "u1");
    expect(handView(revealed.room, revealed.person)).toMatchObject({
      playable: false,
      reason: "revealed",
    });
  });
});
