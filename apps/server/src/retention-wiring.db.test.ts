/**
 * The retention job as `setupServer` wires it (#35), at `ROOM_TTL_DAYS=1` with a real
 * server and a real guest: a room someone sits in stays however idle (the job asks the
 * room sync for its sockets), a two-day-old room someone entered stays, and so does one
 * entered 23 h 58 min after its last change (the enter records the visit at the config's
 * TTL), and an idle room goes (the job reads the TTL from the config). The job's
 * first run and its clock come through `SetupTuning`, which production never sets; the
 * purge itself is tested in `db/retention.db.test.ts`.
 */
import { apply, createRoom } from "@pp/domain";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createTestDatabase, testClient as sqlClient, type TestDatabase } from "./db/test-db.ts";
import { createServer, type PokerServer } from "./server.ts";
import { setupServer } from "./setup.ts";
import { type Guest, roomCode, signInGuest, testClient } from "./sync/test-support.ts";
import { collectLogs, testConfig, VALID_ENV } from "./test-support.ts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

let t: TestDatabase;
let setup: Awaited<ReturnType<typeof setupServer>>;
let server: PokerServer;
let sql: pg.Pool;
let base: string;
let ada: Guest;

beforeAll(async () => {
  t = await createTestDatabase();
  const config = testConfig({ DATABASE_URL: t.url, ROOM_TTL_DAYS: "1" });
  const logger = collectLogs().logger;
  setup = await setupServer(config, logger, undefined, {
    // No scheduled run during the test: it runs the job with `runNow`.
    retentionStartDelayMs: 24 * HOUR,
    // The run comes an hour after the visits.
    retentionNow: () => Date.now() + HOUR,
  });
  server = createServer(config, { ...setup.deps, logger });
  const { port } = await server.listen();
  base = `http://localhost:${port}`;
  sql = sqlClient(t.url);
  ada = await signInGuest(base, VALID_ENV.BASE_URL);
});

afterAll(async () => {
  await setup?.beforeClose?.();
  await server?.close();
  await setup?.dispose?.();
  await sql?.end();
  await t?.drop();
});

/** A room Ada owns and sits at, last active `idle` ago (a Postgres interval). */
async function idleRoom(idle = "2 days") {
  const joined = apply(
    createRoom({ ownerId: ada.id }),
    { type: "join", name: "Adelheidqz", role: "voter" },
    { actor: ada.id, now: Date.now() },
  );
  if (!joined.ok) throw new Error(`fixture refused: ${joined.error}`);
  const code = roomCode();
  const stored = await setup.database.store.insertRoom({ code, name: null, state: joined.state });
  if (!stored) throw new Error("code taken");
  await setIdle(stored.id, idle);
  return stored;
}

async function setIdle(id: string, idle = "2 days") {
  await sql.query("update room set last_active_at = now() - $2::interval where id = $1", [
    id,
    idle,
  ]);
}

async function lastActiveAt(id: string): Promise<number | undefined> {
  const { rows } = await sql.query<{ at: Date }>(
    "select last_active_at as at from room where id = $1",
    [id],
  );
  return rows[0]?.at.getTime();
}

/** Ada enters the room, and the visit lands (the enter does not wait for it). */
async function enter(id: string, code: string) {
  const ada1 = testClient(base, { cookie: ada.cookie });
  expect(await ada1.enter(code)).toMatchObject({ ok: true });
  await vi.waitFor(async () => {
    expect(await lastActiveAt(id)).toBeGreaterThan(Date.now() - MINUTE);
  });
  return ada1;
}

describe("the retention job in setupServer, at ROOM_TTL_DAYS=1", () => {
  it("keeps an occupied idle room and the rooms Ada entered, and purges an idle one", async () => {
    const occupied = await idleRoom();
    const entered = await idleRoom();
    // A visit 23 h 58 min after the last change counts at a one-day period.
    const enteredLate = await idleRoom("23 hours 58 minutes");
    const idle = await idleRoom();

    // Ada sits in the occupied room; it then stays idle for two days.
    const sitting = await enter(occupied.id, occupied.code);
    await setIdle(occupied.id);
    // Ada opened the other rooms, then left.
    (await enter(entered.id, entered.code)).close();
    (await enter(enteredLate.id, enteredLate.code)).close();

    try {
      expect(await setup.retention.runNow()).toMatchObject({ rooms: 1 });
    } finally {
      sitting.close();
    }
    expect(await lastActiveAt(occupied.id)).toBeDefined();
    expect(await lastActiveAt(entered.id)).toBeDefined();
    expect(await lastActiveAt(enteredLate.id)).toBeDefined();
    expect(await lastActiveAt(idle.id)).toBeUndefined();
  });
});
