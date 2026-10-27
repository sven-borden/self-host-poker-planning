import { createRoom } from "@pp/domain";
import { type Snapshot, toSnapshot } from "@pp/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { useRoomStore } from "./room-store.ts";

const snapshot = (code: string, version: number): Snapshot =>
  toSnapshot(createRoom({ ownerId: "ua" }), "ua", { code, version, now: 0 });

afterEach(() => {
  useRoomStore.getState().reset();
});

describe("useRoomStore", () => {
  it("keeps only newer snapshots of the open room", () => {
    const store = useRoomStore.getState();
    store.open("abc");
    expect(store.receive(snapshot("abc", 2))).toBe(true);
    expect(store.receive(snapshot("abc", 1))).toBe(false);
    expect(store.receive(snapshot("abc", 2))).toBe(false);
    expect(store.receive(snapshot("xyz", 9))).toBe(false);
    expect(store.receive(snapshot("abc", 3))).toBe(true);
    expect(useRoomStore.getState().snapshot?.version).toBe(3);
  });

  it("keeps the snapshot when the same room opens again and drops it for another", () => {
    const store = useRoomStore.getState();
    store.open("abc");
    store.receive(snapshot("abc", 2));
    store.open("abc");
    expect(useRoomStore.getState().snapshot?.version).toBe(2);
    store.open("xyz");
    expect(useRoomStore.getState()).toMatchObject({ code: "xyz", snapshot: null });
  });

  it("holds an error until the status changes again", () => {
    const store = useRoomStore.getState();
    store.open("abc");
    store.fail("room_not_found");
    expect(useRoomStore.getState()).toMatchObject({ status: "error", error: "room_not_found" });
    store.setStatus("live");
    expect(useRoomStore.getState()).toMatchObject({ status: "live", error: null });
  });
});
