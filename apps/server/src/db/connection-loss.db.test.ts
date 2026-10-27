/**
 * A Postgres restart or failover terminates the server's backends. Whatever the server
 * was doing at that moment, the call rejects with a `DatabaseError` (or succeeds), the
 * process never sees an uncaught exception, and the pool serves the next command. These
 * tests terminate backends with `pg_terminate_backend`, as a restart does.
 *
 * Everything runs as a role created here with a distinctive name and password, so the
 * log checks can tell that neither, nor the host, port or URL, reached any line.
 */
import { randomBytes } from "node:crypto";
import { apply, type RoomState } from "@pp/domain";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  APP_NAME,
  type Database,
  MIGRATE_APP_NAME,
  openDatabase,
  setupDatabase,
} from "../database.ts";
import { run } from "../run.ts";
import { collectLogs } from "../test-support.ts";
import { DatabaseError } from "./errors.ts";
import { revealedRoom, T0, votingRoom } from "./fixtures.ts";
import { createTestDatabase, serverUrl, type TestDatabase, testClient } from "./test-db.ts";

const role = `pp_loss_${randomBytes(4).toString("hex")}`;
const password = `loss-${randomBytes(8).toString("hex")}`;
let t: TestDatabase;
let url: string;
let admin: ReturnType<typeof testClient>;
let d: Database;
const logs = collectLogs("trace");

const crashes: unknown[] = [];
const onCrash = (error: unknown) => {
  crashes.push(error);
};

beforeAll(async () => {
  process.on("uncaughtException", onCrash);
  process.on("unhandledRejection", onCrash);
  t = await createTestDatabase();
  const server = testClient(serverUrl());
  try {
    await server.query(`create role ${role} login password '${password}'`);
    await server.query(`alter database ${new URL(t.url).pathname.slice(1)} owner to ${role}`);
  } finally {
    await server.end();
  }
  const roleUrl = new URL(t.url);
  roleUrl.username = role;
  roleUrl.password = password;
  url = roleUrl.toString();
  admin = testClient(t.url);
  d = await openDatabase(url, logs.logger, { max: 3 });
});

afterAll(async () => {
  await d?.close();
  await admin?.end();
  await t?.drop();
  const server = testClient(serverUrl());
  try {
    await server.query(`drop role if exists ${role}`);
  } finally {
    await server.end();
  }
  process.off("uncaughtException", onCrash);
  process.off("unhandledRejection", onCrash);
});

afterEach(async () => {
  // Late events (a socket's end after the query failed) arrive within a few ticks.
  await new Promise((resolve) => setTimeout(resolve, 200));
  expect(crashes).toEqual([]);
  const text = logs.raw.join("");
  const { host, port } = new URL(t.url);
  for (const secret of [password, role, url, host, `:${port}`]) {
    expect(text).not.toContain(secret);
  }
});

let codes = 0;
async function insert(state: RoomState) {
  const room = await d.store.insertRoom({ code: `L${++codes}`, name: null, state });
  if (!room) throw new Error("code taken");
  return room;
}

/** The pid of one of our backends matching `where`, once there is one. */
async function backend(app: string, where: string): Promise<number> {
  for (let i = 0; i < 250; i++) {
    const { rows } = await admin.query<{ pid: number }>(
      `select pid from pg_stat_activity
       where datname = current_database() and application_name = $1 and ${where}`,
      [app],
    );
    if (rows[0]) return rows[0].pid;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`no ${app} backend where ${where}`);
}

const terminate = (pid: number) => admin.query("select pg_terminate_backend($1)", [pid]);

/** A transaction on another session holding `lock` until `release`. */
async function holding(lock: string, params: unknown[]) {
  const client = await admin.connect();
  await client.query("begin");
  await client.query(lock, params);
  return async () => {
    await client.query("rollback");
    client.release();
  };
}

const startRound = (state: RoomState) =>
  apply(state, { type: "startRound", subject: { kind: "none" } }, { actor: "u1", now: T0 + 50 });
const rename = (state: RoomState) =>
  apply(state, { type: "rename", name: "Ada L" }, { actor: "u1", now: T0 + 50 });

async function historyCount(roomId: string): Promise<number> {
  const { rows } = await admin.query<{ n: number }>(
    "select count(*)::int as n from round_history where room_id = $1",
    [roomId],
  );
  return rows[0]?.n ?? -1;
}

/** Settles `promise` into what the test checks: the error, or the value. */
const settle = <T>(promise: Promise<T>) =>
  promise.then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );

describe("a backend terminated", () => {
  it("while the commit with history waits on the row lock: rejects, writes nothing, recovers", async () => {
    const room = await insert(revealedRoom());
    const release = await holding("select 1 from room where id = $1 for update", [room.id]);
    const running = settle(d.runner.run(room.code, startRound));
    await terminate(await backend(APP_NAME, "wait_event_type = 'Lock'"));
    const outcome = await running;
    await release();
    expect(outcome).toMatchObject({ error: expect.any(DatabaseError) });
    expect((await d.store.loadRoom(room.code))?.version).toBe(1);
    expect(await historyCount(room.id)).toBe(0);

    expect(await d.runner.run(room.code, startRound)).toMatchObject({ ok: true, version: 2 });
    expect(await historyCount(room.id)).toBe(1);
  });

  it("mid-commit, after the room update and before the history row: rolls both back", async () => {
    const room = await insert(revealedRoom());
    // An uncommitted history row for the same round: our insert waits on it, inside the
    // transaction that already updated the room.
    const release = await holding(
      `insert into round_history
         (room_id, number, subject, deck, votes, stats, started_at, revealed_at, finished_at)
       values ($1, 1, '{}', '{}', '{}', '{}', now(), now(), now())`,
      [room.id],
    );
    const running = settle(d.runner.run(room.code, startRound));
    await terminate(await backend(APP_NAME, "wait_event_type = 'Lock'"));
    const outcome = await running;
    await release();
    expect(outcome).toMatchObject({ error: expect.any(DatabaseError) });
    expect((await d.store.loadRoom(room.code))?.version).toBe(1);
    expect(await historyCount(room.id)).toBe(0);

    expect(await d.runner.run(room.code, startRound)).toMatchObject({ ok: true, version: 2 });
    expect(await historyCount(room.id)).toBe(1);
  });

  it("during a plain commit: rejects and recovers", async () => {
    const room = await insert(votingRoom());
    const release = await holding("select 1 from room where id = $1 for update", [room.id]);
    const running = settle(d.runner.run(room.code, rename));
    await terminate(await backend(APP_NAME, "wait_event_type = 'Lock'"));
    const outcome = await running;
    await release();
    expect(outcome).toMatchObject({ error: expect.any(DatabaseError) });
    expect((await d.store.loadRoom(room.code))?.version).toBe(1);

    expect(await d.runner.run(room.code, rename)).toMatchObject({ ok: true, version: 2 });
  });

  it("while its pooled client is idle: one log line with the code, then the next command works", async () => {
    const room = await insert(votingRoom());
    await d.checkDb();
    const pid = await backend(APP_NAME, "state = 'idle'");
    const before = logs.lines.length;
    await terminate(pid);
    await expect
      .poll(() => logs.lines.slice(before).map(({ msg, code }) => ({ msg, code })))
      .toEqual([{ msg: "database: an idle connection was lost", code: "57P01" }]);

    expect(await d.runner.run(room.code, rename)).toMatchObject({ ok: true, version: 2 });
    expect(await d.checkDb()).toBe("ok");
  });
});

describe("the migrating session terminated during the start", () => {
  it("logs one fatal line and exits 1, never crashes", async () => {
    // A migrated database whose journal table is locked: the migration waits on it.
    const release = await holding(
      "lock table drizzle.__drizzle_migrations in access exclusive mode",
      [],
    );
    const exits: number[] = [];
    const starting = run(
      { DATABASE_URL: url, BASE_URL: "http://localhost:3000", PORT: "0", LOG_LEVEL: "trace" },
      {
        exit: (code) => exits.push(code),
        onSignal: () => {},
        onCrash: () => {},
        destination: logs.destination,
        setup: setupDatabase,
      },
    );
    const before = logs.lines.length;
    await terminate(await backend(MIGRATE_APP_NAME, "wait_event_type = 'Lock'"));
    expect(await starting).toBeUndefined();
    await release();
    expect(exits).toEqual([1]);
    const lines = logs.lines.slice(before);
    const fatal = lines.filter((line) => line.level === 60);
    expect(fatal).toEqual([
      expect.objectContaining({
        msg: "setup failed",
        err: expect.objectContaining({
          type: "DatabaseError",
          message: expect.stringMatching(/^database: migrate failed \(/),
        }),
      }),
    ]);
    expect(lines.map((line) => line.msg)).not.toContain("listening");
  });
});
