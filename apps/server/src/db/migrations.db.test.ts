import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  DEFAULT_MIGRATIONS_DIR,
  MIGRATE_APP_NAME,
  MIGRATION_LOCK_KEY,
  migrateDatabase,
  setupDatabase,
} from "../database.ts";
import { run, type Signal } from "../run.ts";
import { collectLogs, VALID_ENV } from "../test-support.ts";
import { createTestDatabase, type TestDatabase, testClient } from "./test-db.ts";

/** Everything a migration can change, in a fixed order, plus the applied migrations. */
async function schemaOf(url: string) {
  const sql = testClient(url);
  try {
    const rows = async (text: string) => (await sql.query(text)).rows;
    const columns = await rows(`
      select table_schema, table_name, column_name, data_type, is_nullable, column_default
      from information_schema.columns where table_schema in ('public', 'drizzle')
      order by 1, 2, 3`);
    const indexes = await rows(`
      select schemaname, indexname, indexdef from pg_indexes
      where schemaname in ('public', 'drizzle') order by 1, 2`);
    const constraints = await rows(`
      select conname, pg_get_constraintdef(oid) as def from pg_constraint
      where connamespace = 'public'::regnamespace order by 1`);
    const migrations = await rows(
      "select hash, created_at from drizzle.__drizzle_migrations order by id",
    );
    return { columns, indexes, constraints, migrations };
  } finally {
    await sql.end();
  }
}

const migrate = (url: string) => migrateDatabase(url, DEFAULT_MIGRATIONS_DIR, collectLogs().logger);

describe("migrations", () => {
  let first: TestDatabase;
  let second: TestDatabase;
  beforeAll(async () => {
    [first, second] = await Promise.all([createTestDatabase(), createTestDatabase()]);
  });
  afterAll(async () => {
    await Promise.all([first?.drop(), second?.drop()]);
  });

  it("create both tables, and running them again changes nothing", async () => {
    await migrate(first.url);
    const once = await schemaOf(first.url);
    expect(
      once.columns.map(
        (c: { table_name: string; column_name: string }) => `${c.table_name}.${c.column_name}`,
      ),
    ).toEqual(expect.arrayContaining(["room.live", "room.version", "round_history.votes"]));
    expect(once.migrations.length).toBeGreaterThan(0);
    await migrate(first.url);
    expect(await schemaOf(first.url)).toEqual(once);
  });

  it("run by several instances at once apply each migration once", async () => {
    await Promise.all([migrate(second.url), migrate(second.url), migrate(second.url)]);
    const fresh = await schemaOf(second.url);
    expect(fresh).toEqual(await schemaOf(first.url));
    // Again, concurrently, on a migrated database.
    await Promise.all([migrate(second.url), migrate(second.url)]);
    expect(await schemaOf(second.url)).toEqual(fresh);
  });

  it("wait for the advisory lock held by another instance", async () => {
    const other = testClient(first.url);
    const held = await other.connect();
    try {
      await held.query("select pg_advisory_lock($1::bigint)", [MIGRATION_LOCK_KEY]);
      let done = false;
      const migrating = migrate(first.url).then(() => {
        done = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(done).toBe(false);
      await held.query("select pg_advisory_unlock($1::bigint)", [MIGRATION_LOCK_KEY]);
      await migrating;
      expect(done).toBe(true);
    } finally {
      held.release();
      await other.end();
    }
  });

  /** Another session holding the migration lock (or a table lock) until `release`. */
  async function holding(url: string, statements: string[]) {
    const other = testClient(url);
    const held = await other.connect();
    for (const statement of statements) await held.query(statement);
    return async () => {
      held.release(true);
      await other.end();
    };
  }

  it("give up after the lock budget, with a waiting line every interval", async () => {
    const release = await holding(first.url, [`select pg_advisory_lock(${MIGRATION_LOCK_KEY})`]);
    const logs = collectLogs();
    try {
      await expect(
        migrateDatabase(first.url, DEFAULT_MIGRATIONS_DIR, logs.logger, {
          lock: { budgetMs: 1200, logEveryMs: 500, pollMs: 100 },
        }),
      ).rejects.toMatchObject({ name: "DatabaseError", code: "migration_lock_busy" });
    } finally {
      await release();
    }
    const waiting = logs.messages().filter((m) => m.includes("another instance's migrations"));
    expect(waiting.length).toBeGreaterThanOrEqual(2);
    expect(waiting.length).toBeLessThanOrEqual(4);
  });

  it("fail on lock_timeout when a migration waits too long for a table lock", async () => {
    await migrate(first.url);
    const release = await holding(first.url, [
      "begin",
      "lock table drizzle.__drizzle_migrations in access exclusive mode",
    ]);
    try {
      await expect(
        migrateDatabase(first.url, DEFAULT_MIGRATIONS_DIR, collectLogs().logger, {
          lock: { lockTimeoutMs: 300 },
        }),
      ).rejects.toMatchObject({ name: "DatabaseError", code: "55P03" });
    } finally {
      await release();
    }
  });

  it("stop on SIGTERM while waiting for the lock: one line, exit 0, the session closed", async () => {
    const release = await holding(first.url, [`select pg_advisory_lock(${MIGRATION_LOCK_KEY})`]);
    const logs = collectLogs();
    const exits: number[] = [];
    let signal: (s: Signal) => void = () => {};
    try {
      const starting = run(
        { DATABASE_URL: first.url, BASE_URL: "http://localhost:3000", BETTER_AUTH_SECRET: VALID_ENV.BETTER_AUTH_SECRET, PORT: "0" },
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
      await expect
        .poll(() => logs.messages().some((m) => m.includes("another instance's migrations")))
        .toBe(true);
      const before = logs.lines.length;
      signal("SIGTERM");
      expect(await starting).toBeUndefined();
      expect(exits).toEqual([0]);
      expect(logs.lines.slice(before)).toEqual([
        expect.objectContaining({ msg: "shutdown: stopped while starting", signal: "SIGTERM" }),
      ]);
      const admin = testClient(first.url);
      try {
        await expect
          .poll(async () => {
            const { rows } = await admin.query(
              `select count(*)::int as n from pg_stat_activity
               where datname = current_database() and application_name = $1`,
              [MIGRATE_APP_NAME],
            );
            return rows[0]?.n;
          })
          .toBe(0);
      } finally {
        await admin.end();
      }
    } finally {
      await release();
    }
  });
});
