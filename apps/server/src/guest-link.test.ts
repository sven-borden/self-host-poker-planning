/**
 * The order of a guest's way to an account (#48, ADR-025), on a fake store and fake rooms: what
 * ends a sign-in, what runs again, and that the guest goes only after all of it moved. The room
 * sync's own part runs on the real runner and domain below it; the real thing is in
 * `guest-link.db.test.ts`.
 */
import { createRoom } from "@pp/domain";
import { describe, expect, it, vi } from "vitest";
import { DatabaseError } from "./db/errors.ts";
import type { GuestLinkStore } from "./db/guest-links.ts";
import { createCommandRunner } from "./db/runner.ts";
import { createGuestLinks, type GuestRooms, MAX_PASSES } from "./guest-link.ts";
import { createRoomSync } from "./sync/room-sync.ts";
import { memoryRoomStore } from "./sync/test-support.ts";
import { collectLogs } from "./test-support.ts";

function harness(overrides: Partial<GuestLinkStore> = {}) {
  const calls: string[] = [];
  const store: GuestLinkStore = {
    begin: async () => void calls.push("begin"),
    accountOf: async () => "account",
    guestsOf: async () => ["guest"],
    pending: async () => ["guest"],
    roomsOf: async () => ["room-a", "room-b"],
    complete: async () => void calls.push("complete"),
    ...overrides,
  };
  const rooms: GuestRooms = {
    moveGuest: vi.fn(async (code: string) => {
      calls.push(`move ${code}`);
      return "unchanged" as const;
    }),
    dropGuest: vi.fn(() => void calls.push("drop")),
  };
  const logs = collectLogs();
  const links = createGuestLinks({ store, rooms, logger: logs.logger, waitMs: 50 });
  return { calls, store, rooms, links, logs };
}

describe("a sign-in", () => {
  it("writes the link, closes the guest's sockets, moves every room, then ends the guest", async () => {
    const { calls, links } = harness();
    await expect(links.link("guest", "account")).resolves.toBe(true);
    expect(calls).toEqual(["begin", "drop", "move room-a", "move room-b", "complete"]);
  });

  it("ends when the link cannot be written, having moved nothing", async () => {
    const error = new DatabaseError("begin guest link", "57P01");
    const { calls, links } = harness({ begin: () => Promise.reject(error) });
    await expect(links.link("guest", "account")).rejects.toBe(error);
    expect(calls).toEqual([]);
  });

  it("looks again until a pass changes nothing, for a command that was in flight", async () => {
    const { calls, links, rooms } = harness();
    vi.mocked(rooms.moveGuest).mockResolvedValueOnce("changed");
    await links.link("guest", "account");
    expect(calls).toEqual([
      "begin",
      "drop",
      "move room-b",
      "move room-a",
      "move room-b",
      "complete",
    ]);
  });

  it("goes through every room when one fails, keeps the guest, and says so", async () => {
    const { calls, links, rooms, logs } = harness();
    vi.mocked(rooms.moveGuest).mockResolvedValueOnce("failed");
    await expect(links.link("guest", "account")).resolves.toBe(false);
    expect(calls).toEqual(["begin", "drop", "move room-b"]);
    expect(logs.messages()).toContain("guest link: not every room moved");
  });

  it("counts a room whose move throws as one that failed", async () => {
    const { calls, links, rooms } = harness();
    vi.mocked(rooms.moveGuest).mockRejectedValueOnce(new Error("a bad state"));
    await expect(links.link("guest", "account")).resolves.toBe(false);
    expect(calls).not.toContain("complete");
  });

  it("gives up for now on rooms that keep changing, with the guest kept", async () => {
    const { calls, links, rooms } = harness();
    vi.mocked(rooms.moveGuest).mockResolvedValue("changed");
    await expect(links.link("guest", "account")).resolves.toBe(false);
    expect(calls).not.toContain("complete");
    expect(rooms.moveGuest).toHaveBeenCalledTimes(MAX_PASSES * 2);
  });

  it("keeps the signed-in person when the end of the move fails, and can run again", async () => {
    const { calls, links } = harness({
      complete: () => Promise.reject(new DatabaseError("complete guest link", "40P01")),
    });
    await expect(links.link("guest", "account")).resolves.toBe(false);
    expect(calls).toEqual(["begin", "drop", "move room-a", "move room-b"]);
    await links.settle("account");
    expect(calls.filter((call) => call === "move room-a")).toHaveLength(2);
  });

  it("stops waiting after a while, and the move goes on", async () => {
    let free = () => {};
    const { calls, links } = harness({
      roomsOf: () =>
        new Promise((resolve) => {
          free = () => resolve([]);
        }),
    });
    await expect(links.link("guest", "account")).resolves.toBe(false);
    free();
    await vi.waitFor(() => expect(calls).toContain("complete"));
  });

  it("finds nothing to do when no link is pending, and never completes", async () => {
    const { calls, links } = harness({ accountOf: async () => null });
    await expect(links.link("guest", "account")).resolves.toBe(true);
    expect(calls).toEqual(["begin"]);
  });
});

describe("running it again", () => {
  it("joins a run in progress: one instance moves a guest once at a time", async () => {
    let free = () => {};
    const { calls, links } = harness({
      roomsOf: () =>
        new Promise((resolve) => {
          free = () => resolve(["room-a"]);
        }),
    });
    const first = links.link("guest", "account");
    const second = links.settle("account");
    await vi.waitFor(() => expect(calls).toContain("drop"));
    free();
    await Promise.all([first, second]);
    expect(calls.filter((call) => call === "drop")).toHaveLength(1);
    expect(calls.filter((call) => call === "complete")).toHaveLength(1);
  });

  it("settle is quiet for an account with no guest", async () => {
    const { calls, links } = harness({ guestsOf: async () => [] });
    await links.settle("account");
    expect(calls).toEqual([]);
  });

  it("settle and sweep never reject: a visit goes on whatever the database says", async () => {
    const down = () => Promise.reject(new DatabaseError("read guest links", "57P01"));
    const { links, logs } = harness({ guestsOf: down, pending: down });
    await expect(links.settle("account")).resolves.toBeUndefined();
    await expect(links.sweep()).resolves.toBeUndefined();
    expect(logs.messages()).toContain("guest link: pending moves not read");
  });

  it("sweep finishes every move nobody finished", async () => {
    const { calls, links } = harness({ pending: async () => ["guest", "other"] });
    await links.sweep();
    expect(calls.filter((call) => call === "complete")).toHaveLength(2);
  });
});

describe("the room sync's part", () => {
  async function room() {
    const store = memoryRoomStore();
    const base = createRoom({ ownerId: "guest" });
    await store.insertRoom({ code: "CODE", name: null, state: base });
    const logs = collectLogs();
    const runner = createCommandRunner(store);
    const sync = createRoomSync({ runner, store, logger: logs.logger });
    return { store, sync };
  }

  it("is changed, then unchanged", async () => {
    const { store, sync } = await room();
    await expect(sync.moveGuest("CODE", "guest", "account")).resolves.toBe("changed");
    expect(store.rooms.get("CODE")?.state.ownerId).toBe("account");
    await expect(sync.moveGuest("CODE", "guest", "account")).resolves.toBe("unchanged");
    expect(store.commits).toBe(1);
  });

  it("is unchanged for a room deleted meanwhile", async () => {
    const { sync } = await room();
    await expect(sync.moveGuest("GONE", "guest", "account")).resolves.toBe("unchanged");
  });

  it("is failed when every attempt loses, and stores nothing", async () => {
    const { store, sync } = await room();
    store.fate = () => "lose";
    await expect(sync.moveGuest("CODE", "guest", "account")).resolves.toBe("failed");
    expect(store.rooms.get("CODE")?.state.ownerId).toBe("guest");
  });

  it("is failed on a database error, and running it again finds the room as it is", async () => {
    const { store, sync } = await room();
    store.fate = () => "store-then-fail";
    await expect(sync.moveGuest("CODE", "guest", "account")).resolves.toBe("failed");
    store.fate = () => "store";
    await expect(sync.moveGuest("CODE", "guest", "account")).resolves.toBe("unchanged");
    expect(store.commits).toBe(1);
  });
});
