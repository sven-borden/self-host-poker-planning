import { apply, createRoom, type RoomState } from "@pp/domain";
import { toSnapshot } from "@pp/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Database, openDatabase, setupDatabase } from "../database.ts";
import { run } from "../run.ts";
import { collectLogs, SECRET, testConfig } from "../test-support.ts";
import { nextRound, play, revealedRoom, T0, votingRoom } from "./fixtures.ts";
import { FIRST_VERSION, type RoomStore } from "./rooms.ts";
import { createCommandRunner } from "./runner.ts";
import { createTestDatabase, type TestDatabase, testClient } from "./test-db.ts";

let t: TestDatabase;
let a: Database;
let b: Database;
let codes = 0;
const newCode = () => `R${String(++codes).padStart(9, "0")}`;
const open = () => openDatabase(t.url, collectLogs().logger, { max: 3 });

beforeAll(async () => {
  t = await createTestDatabase();
  // Two pools, as two server instances would hold them.
  a = await open();
  b = await open();
});
afterAll(async () => {
  await Promise.all([a?.close(), b?.close()]);
  await t?.drop();
});

async function insert(state: RoomState, store: RoomStore = a.store) {
  const room = await store.insertRoom({ code: newCode(), name: "Sprint 42", state });
  if (!room) throw new Error("code taken");
  return room;
}

/** Each column of the room row, for checks the store does not expose. */
async function rowOf(id: string) {
  const sql = testClient(t.url);
  try {
    const { rows } = await sql.query(
      `select owner_user_id, version, password_hash, jsonb_typeof(live) as live_type,
        last_active_at from room where id = $1`,
      [id],
    );
    return rows[0];
  } finally {
    await sql.end();
  }
}

async function historyOf(id: string) {
  const sql = testClient(t.url);
  try {
    const { rows } = await sql.query(
      `select number, votes, stats, final, row_to_json(h)::text as text
      from round_history h where room_id = $1 order by number`,
      [id],
    );
    return rows;
  } finally {
    await sql.end();
  }
}

describe("insertRoom and loadRoom", () => {
  it("store the state as a jsonb object and load it back equal", async () => {
    const state = votingRoom();
    const room = await a.store.insertRoom({
      code: newCode(),
      name: null,
      state,
      passwordHash: "$argon2id$fake",
    });
    expect(room).toMatchObject({ code: room?.code, version: FIRST_VERSION });
    const loaded = await b.store.loadRoom(room?.code ?? "");
    expect(loaded).toEqual({ id: room?.id, code: room?.code, version: FIRST_VERSION, state });
    expect(await rowOf(room?.id ?? "")).toMatchObject({
      owner_user_id: "u1",
      password_hash: "$argon2id$fake",
      live_type: "object",
    });
  });

  it("answer null for a taken code and for an unknown one", async () => {
    const room = await insert(createRoom({ ownerId: "u1" }));
    expect(
      await a.store.insertRoom({
        code: room.code,
        name: null,
        state: createRoom({ ownerId: "x" }),
      }),
    ).toBeNull();
    expect(await a.store.loadRoom("NOPE")).toBeNull();
  });
});

describe("commitRoom", () => {
  it("writes once per version and copies the owner", async () => {
    const room = await insert(votingRoom());
    // An hour back, so the commit must move it forward (no tie within the same millisecond).
    const sql = testClient(t.url);
    try {
      await sql.query(
        "update room set last_active_at = last_active_at - interval '1 hour' where id = $1",
        [room.id],
      );
    } finally {
      await sql.end();
    }
    const before = await rowOf(room.id);
    const next = play(room.state, "u1", { type: "transferOwner", to: "u2" });
    expect(await a.store.commitRoom(room.id, FIRST_VERSION, next)).toBe(true);
    // The same expected version again: another instance already moved on.
    expect(await b.store.commitRoom(room.id, FIRST_VERSION, room.state)).toBe(false);
    const after = await rowOf(room.id);
    expect(after).toMatchObject({ owner_user_id: "u2", version: FIRST_VERSION + 1 });
    expect(after?.last_active_at.getTime()).toBeGreaterThan(before?.last_active_at.getTime());
    expect((await a.store.loadRoom(room.code))?.state).toEqual(next);
  });

  it("AC 1: of two concurrent commands from two instances, one wins, the other reapplies on the fresh state", async () => {
    const room = await insert(votingRoom());
    // Both instances load version 1 before either commits.
    let arrived = 0;
    let open = () => {};
    const bothLoaded = new Promise<void>((resolve) => {
      open = resolve;
    });
    const holdFirstLoad = (store: RoomStore): RoomStore => {
      let first = true;
      return {
        ...store,
        loadRoom: async (code) => {
          const loaded = await store.loadRoom(code);
          if (first) {
            first = false;
            if (++arrived === 2) open();
            await bothLoaded;
          }
          return loaded;
        },
      };
    };
    const seen = { a: [] as RoomState[], b: [] as RoomState[] };
    const [ra, rb] = await Promise.all([
      createCommandRunner(holdFirstLoad(a.store)).run(room.code, (state) => {
        seen.a.push(state);
        return apply(state, { type: "rename", name: "Ada L" }, { actor: "u1", now: T0 + 50 });
      }),
      createCommandRunner(holdFirstLoad(b.store)).run(room.code, (state) => {
        seen.b.push(state);
        return apply(state, { type: "retractVote" }, { actor: "u2", now: T0 + 50 });
      }),
    ]);
    expect(ra.ok && rb.ok).toBe(true);
    if (!ra.ok || !rb.ok) return;
    expect([ra.version, rb.version].sort()).toEqual([2, 3]);
    const [winner, loser] = ra.version === 2 ? [seen.a, seen.b] : [seen.b, seen.a];
    expect(winner).toHaveLength(1);
    // The loser ran again, on the state the winner stored.
    expect(loser).toHaveLength(2);
    expect(loser[1]).not.toEqual(loser[0]);
    const final = await a.store.loadRoom(room.code);
    expect(final?.version).toBe(3);
    expect(final?.state.participants.u1?.name).toBe("Ada L");
    expect(final?.state.round?.votes).toEqual({ u3: { card: "8" } });
  });
});

describe("history", () => {
  it("writes a named round with who, name and card, in the commit's transaction", async () => {
    const room = await insert(revealedRoom());
    const outcome = await createCommandRunner(a.store, { now: () => T0 + 99 }).run(
      room.code,
      (state) =>
        apply(
          state,
          { type: "startRound", subject: { kind: "none" } },
          { actor: "u1", now: T0 + 90 },
        ),
    );
    expect(outcome).toMatchObject({ ok: true, version: 2 });
    const rows = await historyOf(room.id);
    expect(rows.map(({ text: _, ...row }) => row)).toEqual([
      {
        number: 1,
        votes: {
          kind: "named",
          votes: [
            { who: "u2", name: "Bob", card: "5" },
            { who: "u3", name: "Cy", card: "8" },
          ],
        },
        stats: expect.objectContaining({ mode: "5", spread: ["5", "8"] }),
        final: null,
      },
    ]);
  });

  it("writes an anonymous round with the cards only: no user id or name anywhere in the row", async () => {
    const room = await insert(revealedRoom({ anonymous: true }));
    const { state: next, ended } = nextRound(room.state);
    const participants = room.state.participants;
    expect(
      await a.store.commitRoom(room.id, 1, next, { round: ended, participants, finishedAt: T0 }),
    ).toBe(true);
    const [row] = await historyOf(room.id);
    expect(row?.votes).toEqual({ kind: "anonymous", cards: ["5", "8"] });
    for (const leak of ["u1", "u2", "u3", "Ada", "Bob", "Cy"]) {
      expect(row?.text).not.toContain(leak);
    }
  });

  it("writes nothing for a lost commit or a round that was not revealed, and never twice", async () => {
    const room = await insert(revealedRoom());
    const { state: next, ended } = nextRound(room.state);
    const entry = { round: ended, participants: room.state.participants, finishedAt: T0 };
    expect(await a.store.commitRoom(room.id, 7, next, entry)).toBe(false);
    expect(await historyOf(room.id)).toEqual([]);

    const abandoned = nextRound(votingRoom()).ended;
    expect(await a.store.commitRoom(room.id, 1, room.state, { ...entry, round: abandoned })).toBe(
      true,
    );
    expect(await historyOf(room.id)).toEqual([]);

    // The same round written again (a later write of the same ended round) updates its row.
    expect(await a.store.commitRoom(room.id, 2, next, entry)).toBe(true);
    const final = { ...entry, round: { ...ended, final: "5" } };
    expect(await a.store.commitRoom(room.id, 3, next, final)).toBe(true);
    const rows = await historyOf(room.id);
    expect(rows.map((r) => [r.number, r.final])).toEqual([[1, "5"]]);
  });

  it("is deleted with its room", async () => {
    const room = await insert(revealedRoom());
    const { state: next, ended } = nextRound(room.state);
    await a.store.commitRoom(room.id, 1, next, { round: ended, participants: {}, finishedAt: T0 });
    const sql = testClient(t.url);
    try {
      await sql.query("delete from room where id = $1", [room.id]);
    } finally {
      await sql.end();
    }
    expect(await historyOf(room.id)).toEqual([]);
  });
});

describe("a restart", () => {
  it("AC 3: keeps a voting round with hidden votes, a deadline and anonymity, snapshots included", async () => {
    const state = votingRoom({ anonymous: true, timer: true });
    expect(state.round).toMatchObject({ phase: "voting", anonymous: true });
    expect(state.round?.deadlineAt).toBe(T0 + 4 + 60_000);
    const before = await open();
    const room = await insert(state, before.store);
    await before.close();

    const after = await open();
    try {
      const loaded = await after.store.loadRoom(room.code);
      expect(loaded).toEqual({ ...room, state });
      const meta = { code: room.code, version: room.version, now: T0 + 30_000 };
      for (const viewer of ["u1", "u2", "u3", "someone-else"]) {
        expect(JSON.stringify(toSnapshot(loaded?.state as RoomState, viewer, meta))).toBe(
          JSON.stringify(toSnapshot(state, viewer, meta)),
        );
      }
    } finally {
      await after.close();
    }
  });
});

describe("setupDatabase", () => {
  it("starts the server on a migrated database, reports it healthy and ends the pool on shutdown", async () => {
    const logs = collectLogs();
    const exits: number[] = [];
    let signal: (s: "SIGTERM") => void = () => {};
    const server = await run(
      { DATABASE_URL: t.url, BASE_URL: "http://localhost:3000", PORT: "0", LOG_LEVEL: "info" },
      {
        exit: (code) => exits.push(code),
        onSignal: (handler) => {
          signal = handler;
        },
        onCrash: () => {},
        destination: logs.destination,
        setup: setupDatabase,
      },
    );
    expect(server).toBeDefined();
    const health = await server?.app.request("/api/health");
    expect(await health?.json()).toMatchObject({ status: "ok", db: "ok" });
    signal("SIGTERM");
    await expect.poll(() => exits).toEqual([0]);
    expect(logs.messages()).toContain("shutdown: resources released");
    const text = logs.raw.join("");
    expect(text).not.toContain(t.url);
    expect(text).not.toContain(`:${new URL(t.url).password}@`);
  });

  it("answers error from checkDb once the pool has ended", async () => {
    const setup = await setupDatabase(testConfig({ DATABASE_URL: t.url }), collectLogs().logger);
    expect(await setup.deps?.checkDb?.()).toBe("ok");
    await setup.dispose?.();
    expect(await setup.deps?.checkDb?.()).toBe("error");
  });

  it("stops at once on a wrong password and never logs it", async () => {
    const url = new URL(t.url);
    url.password = SECRET;
    const logs = collectLogs();
    const started = Date.now();
    await expect(
      setupDatabase(testConfig({ DATABASE_URL: url.toString() }), logs.logger),
    ).rejects.toMatchObject({
      name: "DatabaseError",
      code: "28P01",
    });
    expect(Date.now() - started).toBeLessThan(5000);
    expect(logs.raw.join("")).not.toContain(SECRET);
  });
});
