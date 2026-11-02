/**
 * The order of an account's deletion (#51, ADR-029), on a fake store and fake rooms: what ends it
 * before it starts, what runs again, and that the `user` row goes last and only after all of it is
 * done. The real thing is in `account.db.test.ts`.
 */
import { describe, expect, it, vi } from "vitest";
import {
  type AccountRooms,
  createAccountDeletions,
  DELETION_STUCK_MS,
  MAX_PASSES,
} from "./account-deletion.ts";
import type { AccountDeletionStore } from "./db/account-deletions.ts";
import { DatabaseError } from "./db/errors.ts";
import { collectLogs } from "./test-support.ts";

const ME = "person-id-never-logged";
const ROOM_A = { id: "id-a", code: "room-a", ownerId: ME, rule: null };
const ROOM_B = { id: "id-b", code: "room-b", ownerId: ME, rule: null };
const RULE = { domains: ["example.com"], tenants: [] };
const PROVIDERS = { google: true, microsoft: false };

function harness(overrides: Partial<AccountDeletionStore> = {}, domain: string | null = null) {
  const calls: string[] = [];
  let left = [ROOM_A, ROOM_B];
  const store: AccountDeletionStore = {
    begin: async () => void calls.push("begin"),
    markerOf: async () => ({ choices: {}, since: new Date() }),
    pending: async () => [ME],
    endSessions: async () => void calls.push("sessions"),
    guestsOf: async () => [],
    roomsOf: async () => left,
    deleteKept: async () => false,
    deleteAlone: async () => false,
    anonymiseRounds: async () => void calls.push("rounds"),
    finish: async () => {
      calls.push("finish");
      return true;
    },
    ...overrides,
  };
  const rooms: AccountRooms = {
    removeAccount: vi.fn(async ({ id, code }) => {
      calls.push(`remove ${code}`);
      left = left.filter((room) => room.id !== id);
      return "changed" as const;
    }),
    roomDeleted: vi.fn((id: string) => {
      calls.push(`deleted ${id}`);
      left = left.filter((room) => room.id !== id);
    }),
    dropAccount: vi.fn(() => void calls.push("drop")),
  };
  const logs = collectLogs("debug");
  const identitiesOf = vi.fn(
    async () => new Map(domain === null ? [] : [[ME, { domain, tenant: null }]]),
  );
  const rules = { providers: PROVIDERS, identitiesOf };
  const deletions = createAccountDeletions({
    store,
    rooms,
    rules,
    logger: logs.logger,
    waitMs: 50,
  });
  return { calls, store, rooms, deletions, logs, identitiesOf };
}

describe("a deletion", () => {
  it("writes the marker, closes the sockets, deals with the rooms, and ends with the row", async () => {
    const { calls, deletions } = harness();
    await expect(deletions.start(ME, {})).resolves.toBe(true);
    expect(calls).toEqual([
      "begin",
      "sessions",
      "drop",
      "remove room-a",
      "remove room-b",
      "rounds",
      "finish",
    ]);
  });

  it("ends when the marker cannot be written, having touched nothing", async () => {
    const error = new DatabaseError("begin account deletion", "57P01");
    const { calls, deletions } = harness({ begin: () => Promise.reject(error) });
    await expect(deletions.start(ME, {})).rejects.toBe(error);
    expect(calls).toEqual([]);
  });

  it("does as the person chose: a room to delete goes, and a heir is passed on", async () => {
    const deleteKept = vi.fn(async () => true);
    const { calls, deletions, rooms, store } = harness({
      deleteKept,
      markerOf: async () => ({
        choices: { [ROOM_A.id]: { delete: true }, [ROOM_B.id]: { to: "heir" } },
        since: new Date(),
      }),
    });
    await deletions.start(ME, store.markerOf as never);
    expect(deleteKept).toHaveBeenCalledWith(ROOM_A, ME);
    expect(calls).toContain("deleted id-a");
    expect(rooms.removeAccount).toHaveBeenCalledWith(
      ROOM_B,
      expect.objectContaining({ who: ME, heir: "heir" }),
    );
  });

  it("gives each card its own new id, which is no hash of anything", async () => {
    const { deletions, rooms } = harness();
    await deletions.start(ME, {});
    const ghosts = vi
      .mocked(rooms.removeAccount)
      .mock.calls.flatMap(([, { ghost, vacant }]) => [ghost, vacant]);
    expect(new Set(ghosts).size).toBe(4);
    for (const ghost of ghosts) expect(ghost).toMatch(/^[0-9a-f]{32}$/);
  });

  it("deals with a guest still on the way here as the same person", async () => {
    const seen: string[] = [];
    const { deletions } = harness({
      guestsOf: async () => ["guest"],
      roomsOf: async (who) => {
        seen.push(who);
        return [];
      },
    });
    await expect(deletions.start(ME, {})).resolves.toBe(true);
    expect(seen).toEqual([ME, "guest"]);
  });

  it("looks again until no room is left, for a command that was in flight", async () => {
    let found = 2;
    const { deletions, calls } = harness({
      roomsOf: async () => (found-- > 0 ? [ROOM_A] : []),
    });
    await expect(deletions.start(ME, {})).resolves.toBe(true);
    expect(calls.filter((call) => call === "remove room-a")).toHaveLength(2);
    expect(calls.at(-1)).toBe("finish");
  });

  it("does everything but the last step when a room fails", async () => {
    const { calls, deletions, rooms, logs } = harness();
    vi.mocked(rooms.removeAccount).mockResolvedValueOnce("failed");
    await expect(deletions.start(ME, {})).resolves.toBe(false);
    expect(calls).toEqual(["begin", "sessions", "drop", "remove room-b", "rounds"]);
    expect(logs.raw.join("\n")).not.toContain(ME);
  });

  it("goes on to everyone else's rooms and rounds when one person's room fails", async () => {
    const guestRoom = { ...ROOM_A, id: "id-guest", code: "room-guest" };
    const cleared: string[] = [];
    const { calls, deletions, rooms } = harness({
      guestsOf: async () => ["guest"],
      roomsOf: async (who) => (who === ME ? [ROOM_A] : [guestRoom]),
      anonymiseRounds: async (who) => void cleared.push(who),
    });
    vi.mocked(rooms.removeAccount).mockRejectedValueOnce(new Error("a room nobody can read"));
    await expect(deletions.start(ME, {})).resolves.toBe(false);
    expect(calls).toContain("remove room-guest");
    expect(cleared).toEqual([ME, "guest"]);
    expect(calls).not.toContain("finish");
  });

  it("closes the sockets of a guest on the way here too", async () => {
    const { deletions, rooms } = harness({
      guestsOf: async () => ["guest"],
      roomsOf: async () => [],
    });
    await deletions.start(ME, {});
    expect(vi.mocked(rooms.dropAccount).mock.calls).toEqual([[ME], ["guest"]]);
  });

  it("counts a room whose state cannot be read as failed, naming it by its id", async () => {
    const { calls, deletions, rooms, logs } = harness();
    vi.mocked(rooms.removeAccount).mockRejectedValueOnce(new Error("a value out of the room"));
    await expect(deletions.start(ME, {})).resolves.toBe(false);
    expect(calls).not.toContain("finish");
    const text = logs.raw.join("\n");
    expect(text).toContain(ROOM_A.id);
    expect(text).not.toContain("a value out of the room");
  });

  describe("with a room's rule", () => {
    const refusedKeeper = { ...ROOM_A, ownerId: "someone-else", rule: RULE };

    it("deletes nothing for a keeper the rule refuses, whatever was chosen", async () => {
      const deleteKept = vi.fn(async () => true);
      const deleteAlone = vi.fn(async () => true);
      const { deletions, rooms, identitiesOf } = harness({
        deleteKept,
        deleteAlone,
        markerOf: async () => ({ choices: { [ROOM_A.id]: { delete: true } }, since: new Date() }),
        roomsOf: vi.fn(async () => [refusedKeeper]),
      });
      await deletions.start(ME, {});
      expect(deleteKept).not.toHaveBeenCalled();
      expect(deleteAlone).not.toHaveBeenCalled();
      expect(rooms.removeAccount).toHaveBeenCalled();
      expect(identitiesOf).toHaveBeenCalled();
    });

    it("lets a keeper the rule passes delete, with no session left to go by", async () => {
      const deleteAlone = vi.fn(async () => true);
      const roomsOf = vi.fn(async (): Promise<(typeof ROOM_A)[]> => []);
      roomsOf.mockResolvedValueOnce([refusedKeeper as never]);
      const { deletions, rooms } = harness({ deleteAlone, roomsOf }, "example.com");
      await deletions.start(ME, {});
      expect(deleteAlone).toHaveBeenCalled();
      expect(rooms.removeAccount).not.toHaveBeenCalled();
    });

    it("lets the PO who keeps a room delete it, as every rule passes the PO", async () => {
      const deleteAlone = vi.fn(async () => true);
      const roomsOf = vi.fn(async (): Promise<(typeof ROOM_A)[]> => []);
      roomsOf.mockResolvedValueOnce([{ ...ROOM_A, rule: RULE } as never]);
      const { deletions } = harness({ deleteAlone, roomsOf });
      await deletions.start(ME, {});
      expect(deleteAlone).toHaveBeenCalled();
    });

    it("reads nothing more for rooms with no rule", async () => {
      const { deletions, identitiesOf } = harness();
      await deletions.start(ME, {});
      expect(identitiesOf).not.toHaveBeenCalled();
    });
  });

  it("gives up for now when the rooms keep changing, and says so", async () => {
    const { calls, deletions, logs } = harness({ roomsOf: async () => [ROOM_A] });
    await expect(deletions.start(ME, {})).resolves.toBe(false);
    expect(calls.filter((call) => call === "remove room-a")).toHaveLength(MAX_PASSES);
    expect(calls).not.toContain("finish");
    expect(logs.messages()).toContain("account deletion: the person's rooms kept changing");
  });

  it("goes round again when the last step finds the person named after all", async () => {
    const finish = vi.fn(async () => finish.mock.calls.length > 1);
    const { deletions } = harness({ finish });
    await expect(deletions.start(ME, {})).resolves.toBe(true);
    expect(finish).toHaveBeenCalledTimes(2);
  });

  it("logs louder once a deletion has been stuck for a day", async () => {
    const since = new Date(Date.now() - DELETION_STUCK_MS - 1000);
    const { deletions, rooms, logs } = harness({
      markerOf: async () => ({ choices: {}, since }),
    });
    vi.mocked(rooms.removeAccount).mockResolvedValue("failed");
    await deletions.sweep();
    expect(logs.lines.some((line) => line.level === 50)).toBe(true);
  });

  it("answers false after the wait, and the run goes on", async () => {
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const finish = vi.fn(async () => {
      await held;
      return true;
    });
    const { deletions } = harness({ finish, roomsOf: async () => [] });
    await expect(deletions.start(ME, {})).resolves.toBe(false);
    expect(finish).toHaveBeenCalledTimes(1);
    release();
    await vi.waitFor(() => expect(finish).toHaveBeenCalledTimes(1));
  });

  it("joins a run in progress instead of starting a second", async () => {
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const endSessions = vi.fn(() => held);
    const { deletions } = harness({ endSessions, roomsOf: async () => [] });
    const first = deletions.start(ME, {});
    const second = deletions.start(ME, {});
    await vi.waitFor(() => expect(endSessions).toHaveBeenCalled());
    release();
    await Promise.all([first, second]);
    expect(endSessions).toHaveBeenCalledTimes(1);
  });
});

describe("what starts it again", () => {
  it("does nothing for an account with no marker", async () => {
    const { calls, deletions } = harness({ markerOf: async () => null });
    await expect(deletions.refuses(ME)).resolves.toBe(false);
    await deletions.resume(ME);
    expect(calls).toEqual([]);
  });

  it("refuses a sign-in to an account on its way out, and runs the deletion", async () => {
    const { calls, deletions } = harness();
    await expect(deletions.refuses(ME)).resolves.toBe(true);
    await vi.waitFor(() => expect(calls).toContain("finish"));
  });

  it("never rejects from a sweep or a resume, whatever the store does", async () => {
    const fail = () => Promise.reject(new DatabaseError("read", "57P01"));
    const { deletions } = harness({ markerOf: fail, pending: fail });
    await expect(deletions.sweep()).resolves.toBeUndefined();
    await expect(deletions.resume(ME)).resolves.toBeUndefined();
  });

  it("a run that fails on the store reports false and holds nothing", async () => {
    const { deletions } = harness({
      endSessions: () => Promise.reject(new DatabaseError("end sessions", "57P01")),
    });
    await expect(deletions.start(ME, {})).resolves.toBe(false);
    await expect(deletions.start(ME, {})).resolves.toBe(false);
  });
});
