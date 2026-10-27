import { apply, type Command, type RoomState } from "@pp/domain";
import { describe, expect, it } from "vitest";
import { nextRound, revealedRoom, T0, votingRoom } from "./fixtures.ts";
import type { EndedRound } from "./history.ts";
import type { RoomStore, StoredRoom } from "./rooms.ts";
import { createCommandRunner, MAX_RETRIES } from "./runner.ts";

/** An in-memory `RoomStore` with the same compare-and-set rule, and hooks for the tests. */
function memoryStore(rooms: StoredRoom[] = []) {
  const byCode = new Map(rooms.map((r) => [r.code, { ...r }]));
  const commits: { id: string; expected: number; ended?: EndedRound }[] = [];
  const hooks = {
    /** Runs before each load resolves; a test can delay it or change the room behind it. */
    beforeLoad: async (_code: string): Promise<void> => {},
    /** Runs before each commit compares the version; a test can write behind it. */
    beforeCommit: (): void => {},
    /** Forces the next n commits to lose. */
    loseCommits: 0,
  };
  const store: RoomStore = {
    insertRoom: async () => null,
    loadRoom: async (code) => {
      await hooks.beforeLoad(code);
      const r = byCode.get(code);
      return r ? { ...r } : null;
    },
    loadRoomHeader: async (code) => {
      const r = byCode.get(code);
      return r ? { code: r.code, name: null } : null;
    },
    commitRoom: async (id, expected, next, ended) => {
      commits.push({ id, expected, ...(ended && { ended }) });
      hooks.beforeCommit();
      const r = [...byCode.values()].find((x) => x.id === id);
      if (!r || r.version !== expected) return false;
      if (hooks.loseCommits > 0) {
        hooks.loseCommits--;
        return false;
      }
      r.state = next;
      r.version++;
      return true;
    },
  };
  return { store, hooks, commits, room: (code: string) => byCode.get(code) };
}

const room = (code: string, state: RoomState = votingRoom()): StoredRoom => ({
  id: `id-${code}`,
  code,
  version: 1,
  state,
});

const command =
  (actor: string, cmd: Command, now = T0 + 100) =>
  (state: RoomState) =>
    apply(state, cmd, { actor, now });

describe("createCommandRunner", () => {
  it("loads, applies and commits, answering the new version", async () => {
    const mem = memoryStore([room("ABC")]);
    const runner = createCommandRunner(mem.store);
    const outcome = await runner.run("ABC", command("u1", { type: "castVote", card: "3" }));
    expect(outcome).toMatchObject({
      ok: true,
      id: "id-ABC",
      code: "ABC",
      version: 2,
      changed: true,
    });
    expect(mem.room("ABC")?.state.round?.votes.u1).toEqual({ card: "3" });
    expect(mem.commits).toEqual([{ id: "id-ABC", expected: 1 }]);
  });

  it("skips the write when the step returns the loaded state itself", async () => {
    const mem = memoryStore([room("ABC")]);
    const runner = createCommandRunner(mem.store);
    // A refused command changes nothing: the result's state is the input object.
    const outcome = await runner.run("ABC", command("u9", { type: "reveal" }));
    expect(outcome).toMatchObject({ ok: true, version: 1, changed: false });
    if (outcome.ok) expect(outcome.result).toMatchObject({ ok: false, error: "not_participant" });
    expect(mem.commits).toEqual([]);
  });

  it("answers room_not_found for an unknown code", async () => {
    const runner = createCommandRunner(memoryStore().store);
    expect(await runner.run("NOPE", command("u1", { type: "reveal" }))).toEqual({
      ok: false,
      error: "room_not_found",
    });
  });

  it("reloads and runs the step again on the fresh state after a lost commit", async () => {
    const mem = memoryStore([room("ABC")]);
    const runner = createCommandRunner(mem.store);
    let calls = 0;
    // Another instance stores Ada's new name between our first load and our commit.
    mem.hooks.beforeCommit = () => {
      mem.hooks.beforeCommit = () => {};
      const r = mem.room("ABC");
      const other =
        r && apply(r.state, { type: "rename", name: "Ada L" }, { actor: "u1", now: T0 });
      if (r && other?.ok) {
        r.state = other.state;
        r.version++;
      }
    };
    const outcome = await runner.run("ABC", (state) => {
      calls++;
      return apply(state, { type: "retractVote" }, { actor: "u2", now: T0 + 100 });
    });
    // First load saw version 1, the commit expected 1 but found 2: one retry.
    expect(calls).toBe(2);
    expect(outcome).toMatchObject({ ok: true, version: 3, changed: true });
    expect(mem.room("ABC")?.state.round?.votes).toEqual({ u3: { card: "8" } });
    expect(mem.room("ABC")?.state.participants.u1?.name).toBe("Ada L");
  });

  it(`answers conflict after ${MAX_RETRIES} retries`, async () => {
    const mem = memoryStore([room("ABC")]);
    mem.hooks.loseCommits = 99;
    const runner = createCommandRunner(mem.store);
    const outcome = await runner.run("ABC", command("u1", { type: "castVote", card: "3" }));
    expect(outcome).toEqual({ ok: false, error: "conflict" });
    expect(mem.commits).toHaveLength(MAX_RETRIES + 1);
    expect(mem.room("ABC")?.version).toBe(1);
  });

  it("runs one command per room at a time, in arrival order", async () => {
    const mem = memoryStore([room("ABC"), room("XYZ")]);
    const order: string[] = [];
    let release = () => {};
    const gate = new Promise<void>((done) => {
      release = done;
    });
    mem.hooks.beforeLoad = async (code) => {
      order.push(`load ${code}`);
      if (code === "ABC" && order.length === 1) await gate;
    };
    const runner = createCommandRunner(mem.store);
    const first = runner.run("ABC", command("u1", { type: "rename", name: "Ada 1" }));
    const second = runner.run("ABC", command("u1", { type: "rename", name: "Ada 2" }));
    const other = runner.run("XYZ", command("u1", { type: "castVote", card: "2" }));
    // XYZ is not held up by ABC; the second ABC command waits for the first.
    await other;
    await new Promise((done) => setImmediate(done));
    expect(order).toEqual(["load ABC", "load XYZ"]);
    expect(runner.busyRooms()).toBe(1);
    release();
    expect(await first).toMatchObject({ ok: true, version: 2 });
    expect(await second).toMatchObject({ ok: true, version: 3 });
    expect(order).toEqual(["load ABC", "load XYZ", "load ABC"]);
    expect(mem.room("ABC")?.state.participants.u1?.name).toBe("Ada 2");
    await new Promise((done) => setImmediate(done));
    expect(runner.busyRooms()).toBe(0);
  });

  it("keeps the queue going after a step or the store throws", async () => {
    const mem = memoryStore([room("ABC")]);
    const runner = createCommandRunner(mem.store);
    const boom = runner.run("ABC", () => {
      throw new Error("step failed");
    });
    const next = runner.run("ABC", command("u1", { type: "castVote", card: "3" }));
    await expect(boom).rejects.toThrow("step failed");
    expect(await next).toMatchObject({ ok: true, version: 2 });
  });

  it("hands the ended round to the store with the names before and after, and the clock", async () => {
    const state = revealedRoom();
    const mem = memoryStore([room("ABC", state)]);
    const runner = createCommandRunner(mem.store, { now: () => T0 + 500 });
    const outcome = await runner.run(
      "ABC",
      command("u1", { type: "startRound", subject: { kind: "none" } }),
    );
    expect(outcome).toMatchObject({ ok: true, changed: true });
    const commit = mem.commits[0];
    expect(commit?.ended?.round).toEqual(nextRound(state).ended);
    expect(commit?.ended?.finishedAt).toBe(T0 + 500);
    expect(commit?.ended?.participants).toEqual({
      u1: { name: "Ada", joinedAt: T0 },
      u2: { name: "Bob", joinedAt: T0 + 1 },
      u3: { name: "Cy", joinedAt: T0 + 2 },
    });
  });
});
