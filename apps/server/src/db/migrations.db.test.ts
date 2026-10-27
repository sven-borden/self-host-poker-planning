import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_MIGRATIONS_DIR, MIGRATION_LOCK_KEY, migrateDatabase } from "../database.ts";
import { collectLogs } from "../test-support.ts";
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
});
