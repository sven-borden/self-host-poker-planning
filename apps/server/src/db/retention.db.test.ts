/**
 * The retention purge against Postgres, on a fake clock (#35): what goes with an idle
 * room, what is never deleted (a room active a minute ago, visited, with a socket here,
 * of a signed-in owner, held by a commit in progress), orphan guests, two instances at
 * once, batches, a shutdown, and the log line of a run.
 */
import { createRoom, type RoomState } from "@pp/domain";
import type pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type Database, openDatabase } from "../database.ts";
import { startRetention } from "../retention.ts";
import { collectLogs, testConfig } from "../test-support.ts";
import { nextRound, revealedRoom, T0 } from "./fixtures.ts";
import { cutoffOf, type PurgeOptions, RETENTION_LOCK_KEY } from "./retention.ts";
import { createTestDatabase, type TestDatabase, testClient } from "./test-db.ts";

const DAY = 24 * 60 * 60 * 1000;
const MINUTE = 60_000;
/** The fake clock: every timestamp below is set relative to it. */
const NOW = new Date("2031-06-01T12:00:00Z");
const ago = (ms: number, from = NOW) => new Date(from.getTime() - ms);

let t: TestDatabase;
let a: Database;
let b: Database;
let sql: pg.Pool;
let codes = 0;
const newCode = () => `P${String(++codes).padStart(9, "0")}`;

beforeAll(async () => {
  t = await createTestDatabase();
  // Two pools, as two server instances would hold them.
  a = await openDatabase(t.url, collectLogs().logger, { max: 3 });
  b = await openDatabase(t.url, collectLogs().logger, { max: 3 });
  sql = testClient(t.url);
});
afterAll(async () => {
  await Promise.all([a?.close(), b?.close(), sql?.end()]);
  await t?.drop();
});
beforeEach(async () => {
  await sql.query(`truncate room, "user" cascade`);
});

const purge = (options: Partial<PurgeOptions> = {}, db: Database = a) =>
  db.retention.purge({ now: NOW, ttlDays: 90, ...options });

/** A room last active at `lastActive`, owned by `owner` (a user id that may not exist). */
async function room(
  lastActive: Date,
  { owner = "u1", state }: { owner?: string; state?: RoomState } = {},
) {
  const stored = await a.store.insertRoom({
    code: newCode(),
    name: "Sprint 42",
    state: state ?? createRoom({ ownerId: owner }),
  });
  if (!stored) throw new Error("code taken");
  await setLastActive(stored.id, lastActive);
  return stored;
}

/** Starts the next round on a room stored at its first version: one history row. */
async function endRound(db: Database, id: string, revealed: RoomState) {
  const { state, ended } = nextRound(revealed);
  const entry = { round: ended, participants: revealed.participants, finishedAt: T0 };
  expect(await db.store.commitRoom(id, 1, state, entry)).toBe(true);
}

async function setLastActive(id: string, at: Date) {
  await sql.query("update room set last_active_at = $2 where id = $1", [id, at]);
}

async function lastActiveOf(id: string): Promise<Date | undefined> {
  const { rows } = await sql.query<{ at: Date }>(
    "select last_active_at as at from room where id = $1",
    [id],
  );
  return rows[0]?.at;
}

async function exists(id: string): Promise<boolean> {
  return (await lastActiveOf(id)) !== undefined;
}

async function count(text: string, params: unknown[] = []): Promise<number> {
  const { rows } = await sql.query<{ n: number }>(`select count(*)::int as n ${text}`, params);
  return rows[0]?.n ?? 0;
}

/** A user: a guest unless `anonymous` says otherwise (null: the column left empty). */
async function user(
  id: string,
  {
    anonymous = true,
    createdAt = ago(30 * DAY),
  }: { anonymous?: boolean | null; createdAt?: Date } = {},
) {
  await sql.query(
    `insert into "user" (id, name, email, is_anonymous, created_at, updated_at)
     values ($1, '', $1 || '@anonymous.test', $2, $3, $3)`,
    [id, anonymous, createdAt],
  );
}

async function session(userId: string, expiresAt: Date) {
  await sql.query(`insert into session (id, token, user_id, expires_at) values ($1, $1, $2, $3)`, [
    `s-${userId}-${expiresAt.getTime()}`,
    userId,
    expiresAt,
  ]);
}

const userExists = async (id: string) => (await count(`from "user" where id = $1`, [id])) === 1;

describe("an idle room", () => {
  it("goes with its history, its grants and its password counters", async () => {
    const revealed = revealedRoom();
    const idle = await room(ago(91 * DAY), { state: revealed });
    await endRound(a, idle.id, revealed);
    await setLastActive(idle.id, ago(91 * DAY));
    await user("guest-a");
    await session("guest-a", new Date(NOW.getTime() + DAY));
    await sql.query("insert into room_access (room_id, user_id) values ($1, 'guest-a')", [idle.id]);
    await sql.query(
      "update room set password_failures = 3, password_failures_since = $2 where id = $1",
      [idle.id, ago(91 * DAY)],
    );
    expect(await count("from round_history where room_id = $1", [idle.id])).toBe(1);

    expect(await purge()).toMatchObject({ rooms: 1, history: 1, guests: 0, interrupted: false });
    expect(await exists(idle.id)).toBe(false);
    expect(await count("from round_history")).toBe(0);
    expect(await count("from room_access")).toBe(0);
    // The guest has a live session: only the grant went.
    expect(await userExists("guest-a")).toBe(true);
  });

  it.each([1, 90])("goes after %i days and not a minute before (ROOM_TTL_DAYS)", async (days) => {
    const gone = await room(ago(days * DAY + MINUTE));
    const kept = await room(ago(days * DAY - MINUTE));
    expect(await purge({ ttlDays: days })).toMatchObject({ rooms: 1 });
    expect(await exists(gone.id)).toBe(false);
    expect(await exists(kept.id)).toBe(true);
    expect(cutoffOf(NOW, days).getTime()).toBe(NOW.getTime() - days * DAY);
  });

  it("follows ROOM_TTL_DAYS from the environment through the job", async () => {
    const config = testConfig({ ROOM_TTL_DAYS: "1" });
    expect(config.roomTtlDays).toBe(1);
    const twoDays = await room(ago(2 * DAY));
    const fresh = await room(ago(12 * 60 * MINUTE));
    const retention = startRetention({
      store: a.retention,
      ttlDays: config.roomTtlDays,
      logger: collectLogs().logger,
      now: () => NOW.getTime(),
    });
    expect(await retention.runNow()).toMatchObject({ rooms: 1 });
    await retention.stop();
    expect(await exists(twoDays.id)).toBe(false);
    expect(await exists(fresh.id)).toBe(true);
    expect(testConfig().roomTtlDays).toBe(90);
  });
});

describe("never an active room", () => {
  it("keeps a room active a minute ago", async () => {
    const active = await room(ago(MINUTE));
    expect(await purge()).toMatchObject({ rooms: 0 });
    expect(await exists(active.id)).toBe(true);
  });

  it("keeps a room visited within the period: an enter touches a day-old last_active_at", async () => {
    // `touchRoom` writes Postgres's now(), so this test runs on the real clock.
    const now = new Date();
    const visited = await room(ago(100 * DAY, now));
    const untouched = await room(ago(100 * DAY, now));
    await a.retention.touchRoom(visited.id);
    expect(await purge({ now })).toMatchObject({ rooms: 1 });
    expect(await exists(visited.id)).toBe(true);
    expect(await exists(untouched.id)).toBe(false);
    // A visit less than a day after the last one writes nothing.
    const touched = await lastActiveOf(visited.id);
    expect(touched?.getTime()).toBeGreaterThan(now.getTime() - MINUTE);
    await setLastActive(visited.id, ago(23 * 60 * MINUTE, now));
    await a.retention.touchRoom(visited.id);
    expect((await lastActiveOf(visited.id))?.getTime()).toBe(ago(23 * 60 * MINUTE, now).getTime());
  });

  it("keeps a room with a socket on this instance", async () => {
    const occupied = await room(ago(200 * DAY));
    const empty = await room(ago(200 * DAY));
    expect(await purge({ occupied: [occupied.id] })).toMatchObject({ rooms: 1 });
    expect(await exists(occupied.id)).toBe(true);
    expect(await exists(empty.id)).toBe(false);
  });

  it("keeps a signed-in owner's room (ADR-014); a guest's or a deleted owner's goes", async () => {
    await user("signed-in", { anonymous: false });
    await user("unknown-kind", { anonymous: null });
    await user("guest-owner");
    await session("guest-owner", new Date(NOW.getTime() + DAY));
    const signedIn = await room(ago(400 * DAY), { owner: "signed-in" });
    const unknownKind = await room(ago(400 * DAY), { owner: "unknown-kind" });
    const guests = await room(ago(400 * DAY), { owner: "guest-owner" });
    const orphan = await room(ago(400 * DAY), { owner: "deleted-long-ago" });
    expect(await purge()).toMatchObject({ rooms: 2 });
    expect(await exists(signedIn.id)).toBe(true);
    expect(await exists(unknownKind.id)).toBe(true);
    expect(await exists(guests.id)).toBe(false);
    expect(await exists(orphan.id)).toBe(false);
  });

  it("keeps a room whose commit is in progress, and the commit lands", async () => {
    const idle = await room(ago(91 * DAY));
    const other = await room(ago(91 * DAY));
    const commit = await sql.connect();
    try {
      await commit.query("begin");
      await commit.query(
        "update room set version = version + 1, last_active_at = $2 where id = $1",
        [idle.id, NOW],
      );
      // The purge skips the locked row instead of waiting for it.
      expect(await purge()).toMatchObject({ rooms: 1 });
      await commit.query("commit");
    } finally {
      commit.release();
    }
    expect(await exists(idle.id)).toBe(true);
    expect(await exists(other.id)).toBe(false);
    // The next run sees the commit's last_active_at.
    expect(await purge()).toMatchObject({ rooms: 0 });
    expect(await exists(idle.id)).toBe(true);
  });

  it("keeps a room a commit moved after the run read the clock", async () => {
    // The commit writes Postgres's now(), later than the cutoff of a run on the real clock.
    const now = new Date();
    const revealed = revealedRoom();
    const idle = await room(ago(91 * DAY, now), { state: revealed });
    await endRound(b, idle.id, revealed);
    expect(await purge({ now })).toMatchObject({ rooms: 0, history: 0 });
    expect(await count("from round_history where room_id = $1", [idle.id])).toBe(1);
  });
});

describe("orphan guests", () => {
  it("go without a live session or a room; guests with either, and signed-in users, stay", async () => {
    await user("expired");
    await session("expired", ago(60 * MINUTE));
    await user("no-session");
    await user("live");
    await session("live", ago(-DAY));
    await user("expired-and-live");
    await session("expired-and-live", ago(DAY));
    await session("expired-and-live", ago(-DAY));
    await user("owns-active");
    await room(ago(DAY), { owner: "owns-active" });
    await user("owns-idle");
    await room(ago(100 * DAY), { owner: "owns-idle" });
    await user("signing-in", { createdAt: ago(60 * MINUTE) });
    await user("signed-in", { anonymous: false });
    await user("unknown-kind", { anonymous: null });

    // The idle room goes first, so its owner goes in the same run.
    expect(await purge()).toMatchObject({ rooms: 1, guests: 3 });
    for (const id of ["expired", "no-session", "owns-idle"]) {
      expect(await userExists(id)).toBe(false);
    }
    for (const id of [
      "live",
      "expired-and-live",
      "owns-active",
      "signing-in",
      "signed-in",
      "unknown-kind",
    ]) {
      expect(await userExists(id)).toBe(true);
    }
    // Their sessions went with them.
    expect(await count(`from session where user_id = 'expired'`)).toBe(0);
  });
});

describe("password windows", () => {
  it("clears the ended windows of rooms that stay, and leaves running ones", async () => {
    const ended = await room(ago(DAY));
    const running = await room(ago(DAY));
    await sql.query(
      "update room set password_failures = 4, password_failures_since = $2 where id = $1",
      [ended.id, ago(11 * MINUTE)],
    );
    await sql.query(
      "update room set password_failures = 2, password_failures_since = $2 where id = $1",
      [running.id, ago(5 * MINUTE)],
    );
    expect(await purge()).toMatchObject({ rooms: 0, passwordWindows: 1 });
    const { rows } = await sql.query(
      "select id, password_failures as n, password_failures_since as since from room",
    );
    expect(rows.find((r) => r.id === ended.id)).toMatchObject({ n: 0, since: null });
    expect(rows.find((r) => r.id === running.id)).toMatchObject({ n: 2 });
    // Clearing a window is not activity.
    expect((await lastActiveOf(ended.id))?.getTime()).toBe(ago(DAY).getTime());
  });
});

describe("two instances", () => {
  it("skip the run while another holds the lock, and run once it is free", async () => {
    const idle = await room(ago(91 * DAY));
    const holder = await sql.connect();
    try {
      await holder.query("select pg_advisory_lock($1::bigint)", [RETENTION_LOCK_KEY]);
      expect(await purge()).toBeNull();
      expect(await exists(idle.id)).toBe(true);
      await holder.query("select pg_advisory_unlock($1::bigint)", [RETENTION_LOCK_KEY]);
    } finally {
      holder.release();
    }
    expect(await purge({}, b)).toMatchObject({ rooms: 1 });
  });

  it("at the same moment: every idle room is deleted once, and the lock is released", async () => {
    for (let i = 0; i < 12; i++) await room(ago((91 + i) * DAY));
    const results = await Promise.all([purge({ batchSize: 2 }), purge({ batchSize: 2 }, b)]);
    const deleted = results.reduce((sum, r) => sum + (r?.rooms ?? 0), 0);
    expect(deleted).toBe(12);
    expect(await count("from room")).toBe(0);
    expect(
      await count(
        `from pg_locks where locktype = 'advisory'
         and database = (select oid from pg_database where datname = current_database())`,
      ),
    ).toBe(0);
  });
});

describe("batches", () => {
  it("delete a few rows per statement until none is left", async () => {
    for (let i = 0; i < 5; i++) await room(ago((91 + i) * DAY));
    // Rooms: 2, 2, 1; guests: one statement.
    expect(await purge({ batchSize: 2 })).toMatchObject({ rooms: 5, batches: 4 });
    expect(await count("from room")).toBe(0);
  });

  it("stop at a shutdown before the next batch, and release the lock", async () => {
    const idle = await room(ago(91 * DAY));
    const aborter = new AbortController();
    aborter.abort();
    expect(await purge({ signal: aborter.signal })).toEqual({
      rooms: 0,
      history: 0,
      guests: 0,
      passwordWindows: 0,
      batches: 0,
      interrupted: true,
    });
    expect(await exists(idle.id)).toBe(true);
    expect(await purge({}, b)).toMatchObject({ rooms: 1 });
  });
});

describe("the run's log line", () => {
  it("carries the counts and the duration, never a code, a name or a user id", async () => {
    const revealed = revealedRoom();
    const idle = await room(ago(91 * DAY), { state: revealed });
    await endRound(a, idle.id, revealed);
    await setLastActive(idle.id, ago(91 * DAY));
    await user("orphan-guest");
    const logs = collectLogs("info");
    const retention = startRetention({
      store: a.retention,
      ttlDays: 90,
      logger: logs.logger,
      now: () => NOW.getTime(),
    });
    await retention.runNow();
    await retention.stop();
    expect(logs.lines).toHaveLength(1);
    expect(logs.lines[0]).toMatchObject({
      msg: "retention: purge done",
      rooms: 1,
      history: 1,
      guests: 1,
      passwordWindows: 0,
      interrupted: false,
    });
    expect(typeof logs.lines[0]?.durationMs).toBe("number");
    const raw = logs.raw.join("");
    for (const secret of [idle.code, idle.id, "Sprint 42", "Login page", "orphan-guest"]) {
      expect(raw).not.toContain(secret);
    }
  });
});
