/**
 * Opening the database at start: wait until Postgres answers, apply the migrations under
 * an advisory lock, then open the pool the server uses. `setupDatabase` is the `setup`
 * hook `main.ts` hands to `run()`. Nothing here connects at import time.
 *
 * Secrets: the connection string holds a password. It is never logged and never put in
 * an error; driver errors are reduced to their code (`db/errors.ts`).
 */
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres, { type Sql } from "postgres";
import type { DbStatus } from "./app.ts";
import type { Config } from "./config.ts";
import { DatabaseError, errorCode, guard } from "./db/errors.ts";
import { createRoomStore, type Db, type RoomStore } from "./db/rooms.ts";
import { type CommandRunner, createCommandRunner } from "./db/runner.ts";
import type { Logger } from "./logger.ts";
import type { Setup } from "./run.ts";

/** `apps/server/drizzle`, seen from `apps/server/src` (tsx) and `apps/server/dist` (bundle). */
export const DEFAULT_MIGRATIONS_DIR = resolve(import.meta.dirname, "../drizzle");

/**
 * The session-level advisory lock held while migrating, so instances starting together
 * migrate one after the other. Any constant works; it only has to be the same everywhere.
 */
export const MIGRATION_LOCK_KEY = 7_000_007;

/** How long a start waits for Postgres (Coolify may start the app first). */
export const CONNECT_BUDGET_MS = 30_000;

/** Postgres answered and refused: retrying cannot help (bad password, no such database). */
function isFinal(code: string): boolean {
  return code.startsWith("28") || code === "3D000";
}

/** Wait before attempt `attempt + 1`: 0.5 s, 1 s, 2 s, 4 s, then 5 s. */
export function retryDelay(attempt: number): number {
  return Math.min(500 * 2 ** (attempt - 1), 5000);
}

export interface WaitOptions {
  budgetMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

/**
 * Runs `probe` until it resolves. Each failure logs one line with the attempt and the
 * error code (never a message, which could name the host or the user). Gives up with a
 * `DatabaseError` when the next wait would pass the budget, or at once when Postgres
 * refused the login.
 */
export async function waitForDatabase(
  probe: () => Promise<unknown>,
  logger: Logger,
  { budgetMs = CONNECT_BUDGET_MS, now = Date.now, sleep: wait = sleep }: WaitOptions = {},
): Promise<void> {
  const start = now();
  for (let attempt = 1; ; attempt++) {
    try {
      await probe();
      if (attempt > 1) logger.info({ attempt }, "database: reachable");
      return;
    } catch (error) {
      const code = errorCode(error);
      const delay = retryDelay(attempt);
      if (isFinal(code)) {
        throw new DatabaseError("connect", code, "the server refused the connection");
      }
      if (now() - start + delay > budgetMs) {
        throw new DatabaseError("connect", code, `not reachable after ${attempt} attempts`);
      }
      logger.warn({ attempt, code, retryInMs: delay }, "database: not reachable, retrying");
      await wait(delay);
    }
  }
}

function client(url: string, max: number): Sql {
  return postgres(url, {
    max,
    connect_timeout: 10,
    // "schema already exists, skipping" and friends: postgres.js prints them otherwise.
    onnotice: () => {},
    connection: { application_name: "poker-planning" },
  });
}

/**
 * Applies the pending migrations from `migrationsDir`, under `MIGRATION_LOCK_KEY` on a
 * single connection that ends right after. drizzle runs the pending migrations in one
 * transaction, so a crash or SIGTERM in the middle rolls them back, and the lock dies
 * with the connection. Applying again changes nothing.
 */
export async function migrateDatabase(
  url: string,
  migrationsDir: string,
  logger: Logger,
  wait: WaitOptions = {},
): Promise<void> {
  if (!existsSync(join(migrationsDir, "meta", "_journal.json"))) {
    throw new DatabaseError("migrate", "missing_migrations", `no migrations in ${migrationsDir}`);
  }
  const sql = client(url, 1);
  try {
    await waitForDatabase(() => sql`select 1`, logger, wait);
    await guard(
      "lock migrations",
      () => sql`select pg_advisory_lock(${MIGRATION_LOCK_KEY}::bigint)`,
    );
    await guard("migrate", () =>
      migrate(drizzle({ client: sql }), { migrationsFolder: migrationsDir }),
    );
    logger.info("database: migrations applied");
  } finally {
    await sql.end({ timeout: 5 });
  }
}

/** What the server holds while it runs. */
export interface Database {
  readonly db: Db;
  readonly store: RoomStore;
  readonly runner: CommandRunner;
  /** `select 1`: `ok`, or `error` on any failure. `/api/health` gives it 2 s. */
  checkDb(): Promise<DbStatus>;
  /** Ends the pool, letting running queries finish for up to 5 s. */
  close(): Promise<void>;
}

export interface DatabaseOptions {
  migrationsDir?: string;
  wait?: WaitOptions;
  /** Pool size. */
  max?: number;
}

/** Migrates, then opens the pool. Rejects with a `DatabaseError` and leaves nothing open. */
export async function openDatabase(
  url: string,
  logger: Logger,
  { migrationsDir = DEFAULT_MIGRATIONS_DIR, wait, max = 10 }: DatabaseOptions = {},
): Promise<Database> {
  await migrateDatabase(url, migrationsDir, logger, wait);
  const sql = client(url, max);
  const db = drizzle({ client: sql });
  const store = createRoomStore(db);
  return {
    db,
    store,
    runner: createCommandRunner(store),
    checkDb: async () => {
      try {
        await sql`select 1`;
        return "ok";
      } catch {
        return "error";
      }
    },
    close: () => sql.end({ timeout: 5 }),
  };
}

/**
 * The `setup` hook of `run()`: the database is migrated and open before the server
 * listens; `/api/health` pings it; `dispose` ends the pool after the server closed.
 * `database` is for the hooks that build on it (#10, W1).
 */
export async function setupDatabase(
  config: Config,
  logger: Logger,
): Promise<Setup & { database: Database }> {
  const database = await openDatabase(config.databaseUrl, logger, {
    migrationsDir: config.migrationsDir ? resolve(config.migrationsDir) : DEFAULT_MIGRATIONS_DIR,
  });
  return {
    database,
    deps: { checkDb: database.checkDb },
    dispose: database.close,
  };
}
