/**
 * For `*.db.test.ts` only: each test file gets its own empty database on the Postgres of
 * `DATABASE_URL`, so files never see each other's rows or migrations. Never print a URL
 * from here: it holds the password.
 */
import { randomBytes } from "node:crypto";
import postgres, { type Sql } from "postgres";
import { DatabaseError, errorCode } from "./errors.ts";

const MISSING_URL =
  "DATABASE_URL is not set. `pnpm test:db` needs a running Postgres 17 and a user allowed to " +
  "create databases: see apps/server/README.md.";

export function serverUrl(): string {
  const raw = process.env.DATABASE_URL;
  if (!raw) throw new Error(MISSING_URL);
  return raw;
}

/** A small client for the tests' own queries; end it in `afterAll`. */
export function testClient(url: string): Sql {
  return postgres(url, { max: 2, onnotice: () => {} });
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
    await admin.unsafe(`create database ${name}`);
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
        await admin.unsafe(`drop database if exists ${name} with (force)`);
      } finally {
        await admin.end();
      }
    },
  };
}
