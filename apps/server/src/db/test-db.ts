/**
 * For `*.db.test.ts` only: each test file gets its own empty database on the Postgres of
 * `DATABASE_URL`, so files never see each other's rows or migrations. Never print a URL
 * from here: it holds the password.
 */
import { randomBytes } from "node:crypto";
import pg from "pg";
import { DatabaseError, errorCode } from "./errors.ts";

const MISSING_URL =
  "DATABASE_URL is not set. `pnpm test:db` needs a running Postgres 17 and a user allowed to " +
  "create databases: see apps/server/README.md.";

export function serverUrl(): string {
  const raw = process.env.DATABASE_URL;
  if (!raw) throw new Error(MISSING_URL);
  return raw;
}

/**
 * A small pool for the tests' own queries; `end()` it. Its connections may be terminated
 * on purpose, so their `error` events are swallowed.
 */
export function testClient(url: string): pg.Pool {
  const pool = new pg.Pool({ connectionString: url, max: 2, application_name: "pp-test" });
  pool.on("error", () => {});
  pool.on("connect", (client) => {
    client.on("error", () => {});
  });
  return pool;
}

export interface TestDatabase {
  readonly url: string;
  /** Drops the database, closing whatever is still connected to it. */
  drop(): Promise<void>;
}

export async function createTestDatabase(): Promise<TestDatabase> {
  const admin = testClient(serverUrl());
  const name = `pp_test_${randomBytes(6).toString("hex")}`;
  try {
    await admin.query(`create database ${name}`);
  } catch (error) {
    await admin.end();
    throw new DatabaseError("create test database", errorCode(error));
  }
  const url = new URL(serverUrl());
  url.pathname = `/${name}`;
  return {
    url: url.toString(),
    drop: async () => {
      try {
        await admin.query(`drop database if exists ${name} with (force)`);
      } finally {
        await admin.end();
      }
    },
  };
}
