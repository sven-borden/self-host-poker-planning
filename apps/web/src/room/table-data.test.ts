import { createRoom, type Participant, type RoomState } from "@pp/domain";
import { toSnapshot } from "@pp/protocol";
import { describe, expect, it } from "vitest";
import { isRoomFull, tableData } from "./table-data.ts";

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
    expect(observers).toEqual([
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
