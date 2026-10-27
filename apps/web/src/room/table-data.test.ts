import { apply, type Command, createRoom, type Participant, type RoomState } from "@pp/domain";
import { toSnapshot } from "@pp/protocol";
import { describe, expect, it } from "vitest";
import { isRoomFull } from "./room-full.ts";
import { tableData } from "./table-data.ts";

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

  it("shows the cards of a named reveal, and only who voted after an anonymous one", () => {
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
    expect(anonymous.map((p) => p.status.kind)).toEqual(["thinking", "voted", "thinking"]);
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
