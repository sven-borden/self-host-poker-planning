/**
 * Opening the database at start: wait until Postgres answers, apply the migrations under
 * an advisory lock, then open the pool the server uses. `setupDatabase` is the `setup`
 * hook `main.ts` hands to `run()`. Nothing here connects at import time. The driver is
 * node-postgres (`pg`), through drizzle's `node-postgres` driver.
 *
 * Secrets: the connection string holds a password. It is never logged and never put in
 * an error; driver errors are reduced to their code (`db/errors.ts`).
 */
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import type { DbStatus } from "./app.ts";
import type { Config } from "./config.ts";
import { DatabaseError, errorCode, guard } from "./db/errors.ts";
import { createRetentionStore, type RetentionStore } from "./db/retention.ts";
import {
  type AccessStore,
  createRoomStore,
  type Db,
  type HistoryStore,
  type RoomStore,
} from "./db/rooms.ts";
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

/** How long a start waits for Postgres (Coolify may start the app first), attempts included. */
export const CONNECT_BUDGET_MS = 30_000;

/** The longest single connection attempt, TLS and login included. */
export const CONNECT_TIMEOUT_MS = 10_000;

/** `application_name` of the pool's sessions, and of the one session that migrates. */
export const APP_NAME = "poker-planning";
export const MIGRATE_APP_NAME = "poker-planning-migrate";

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
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Aborts the wait: a signal during the start. */
  signal?: AbortSignal;
}

const sleep = async (ms: number, signal?: AbortSignal): Promise<void> => {
  await delay(ms, undefined, signal ? { signal } : undefined);
};

/**
 * Runs `probe` until it resolves, and resolves with its value. `probe` gets the time one
 * attempt may take, so the whole wait, attempts included, stays within the budget (the
 * driver adds no backoff of its own). Each failure logs one line with the attempt and the
 * error code (never a message, which could name the host or the user). Gives up with a
 * `DatabaseError` when the next wait would pass the budget, or at once when Postgres
 * refused the login.
 */
export async function waitForDatabase<T>(
  probe: (timeoutMs: number) => Promise<T>,
  logger: Logger,
  { budgetMs = CONNECT_BUDGET_MS, now = Date.now, sleep: wait = sleep, signal }: WaitOptions = {},
): Promise<T> {
  const start = now();
  for (let attempt = 1; ; attempt++) {
    signal?.throwIfAborted();
    try {
      const left = budgetMs - (now() - start);
      const value = await probe(Math.max(1, Math.min(CONNECT_TIMEOUT_MS, left)));
      if (attempt > 1) logger.info({ attempt }, "database: reachable");
      return value;
    } catch (error) {
      signal?.throwIfAborted();
      const code = errorCode(error);
      const pause = retryDelay(attempt);
      if (isFinal(code)) {
        throw new DatabaseError("connect", code, "the server refused the connection");
      }
      if (now() - start + pause > budgetMs) {
        throw new DatabaseError("connect", code, `not reachable after ${attempt} attempts`);
      }
      logger.warn({ attempt, code, retryInMs: pause }, "database: not reachable, retrying");
      await wait(pause, signal);
    }
  }
}

/**
 * The connection string with libpq's meaning of `sslmode`: `require` encrypts without
 * checking the certificate (a self-signed one works) and `verify-full` checks it.
 * node-postgres 8 otherwise reads `require` as `verify-full` and warns about it. Only
 * appends a parameter: the URL is never rewritten, and never logged.
 */
export function libpqUrl(url: string): string {
  let params: URLSearchParams;
  try {
    params = new URL(url).searchParams;
  } catch {
    return url;
  }
  if (!params.has("sslmode") || params.has("uselibpqcompat")) return url;
  return `${url}${url.includes("?") ? "&" : "?"}uselibpqcompat=true`;
}

/**
 * A connection's `error` event: node-postgres emits it when the backend goes away, also
 * on a client checked out of the pool (inside a transaction, say), and an unhandled one
 * crashes the process. The query in flight, or the next one, rejects on its own, and the
 * pool drops a broken client when it is released, so there is nothing more to do here.
 */
const ignoreClientError = () => {};

export interface LockOptions {
  /** Give up when another instance held the migration lock this long. Default 60 s. */
  budgetMs?: number;
  /** One "waiting" log line this often. Default 5 s. */
  logEveryMs?: number;
  /** Try again this often. Default 0.5 s. */
  pollMs?: number;
  /**
   * `lock_timeout` of the migrating session: a migration that waits longer for a table
   * lock fails the start instead of stalling the live queries queued behind it, and a
   * killed instance's session never waits longer than this. Default 10 s.
   */
  lockTimeoutMs?: number;
}

export const LOCK_BUDGET_MS = 60_000;
export const LOCK_LOG_EVERY_MS = 5000;

export interface MigrateOptions {
  wait?: WaitOptions;
  lock?: LockOptions;
  /** A signal during the start: stop waiting, end the session, reject. */
  signal?: AbortSignal;
}

/** Opens the one session that locks and migrates. */
async function connectMigrator(
  url: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<pg.Client> {
  const client = new pg.Client({
    connectionString: libpqUrl(url),
    application_name: MIGRATE_APP_NAME,
    connectionTimeoutMillis: timeoutMs,
  });
  client.on("error", ignoreClientError);
  const abort = () => {
    void client.end().catch(ignoreClientError);
  };
  signal?.addEventListener("abort", abort, { once: true });
  try {
    await client.connect();
    return client;
  } catch (error) {
    await client.end().catch(ignoreClientError);
    throw error;
  } finally {
    signal?.removeEventListener("abort", abort);
  }
}

/**
 * Takes `MIGRATION_LOCK_KEY` with `pg_try_advisory_lock` in a loop, never with a blocking
 * call: a session blocked in `pg_advisory_lock` notices that its instance died only once
 * it gets the lock, and then holds it.
 */
async function takeMigrationLock(
  client: pg.Client,
  logger: Logger,
  { budgetMs = LOCK_BUDGET_MS, logEveryMs = LOCK_LOG_EVERY_MS, pollMs = 500 }: LockOptions,
  signal?: AbortSignal,
): Promise<void> {
  const start = Date.now();
  let logged = Number.NEGATIVE_INFINITY;
  for (;;) {
    const { rows } = await guard("lock migrations", () =>
      client.query<{ locked: boolean }>("select pg_try_advisory_lock($1::bigint) as locked", [
        MIGRATION_LOCK_KEY,
      ]),
    );
    if (rows[0]?.locked) return;
    const waited = Date.now() - start;
    if (waited >= budgetMs) {
      throw new DatabaseError(
        "lock migrations",
        "migration_lock_busy",
        `another instance held the migration lock for ${Math.round(waited / 1000)} s`,
      );
    }
    if (Date.now() - logged >= logEveryMs) {
      logger.warn({ waitedMs: waited }, "database: waiting for another instance's migrations");
      logged = Date.now();
    }
    await sleep(pollMs, signal);
  }
}

/**
 * Applies the pending migrations from `migrationsDir`, under `MIGRATION_LOCK_KEY`, on one
 * session of its own that ends right after. drizzle runs the pending migrations in one
 * transaction, so a crash or a signal in the middle rolls them back, and the lock dies
 * with the session. Applying again changes nothing. An abort ends the session at once.
 */
export async function migrateDatabase(
  url: string,
  migrationsDir: string,
  logger: Logger,
  { wait = {}, lock = {}, signal }: MigrateOptions = {},
): Promise<void> {
  if (!existsSync(join(migrationsDir, "meta", "_journal.json"))) {
    throw new DatabaseError("migrate", "missing_migrations", `no migrations in ${migrationsDir}`);
  }
  const client = await waitForDatabase(
    (timeoutMs) => connectMigrator(url, timeoutMs, signal),
    logger,
    {
      signal,
      ...wait,
    },
  );
  const abort = () => {
    void client.end().catch(ignoreClientError);
  };
  signal?.addEventListener("abort", abort, { once: true });
  try {
    signal?.throwIfAborted();
    await guard("lock migrations", () =>
      client.query("select set_config('lock_timeout', $1, false)", [
        `${lock.lockTimeoutMs ?? 10_000}ms`,
      ]),
    );
    await takeMigrationLock(client, logger, lock, signal);
    await guard("migrate", () => migrate(drizzle({ client }), { migrationsFolder: migrationsDir }));
    logger.info("database: migrations applied");
  } finally {
    signal?.removeEventListener("abort", abort);
    await client.end().catch(ignoreClientError);
  }
}

/** What the server holds while it runs. */
export interface Database {
  /** drizzle on the pool: the room store's, and Better Auth's (#10). */
  readonly db: Db;
  readonly store: RoomStore & AccessStore & HistoryStore;
  readonly runner: CommandRunner;
  /** The retention purge and the visit touch (#35), on the pool. */
  readonly retention: RetentionStore;
  /** `select 1`: `ok`, or `error` on any failure. `/api/health` gives it 2 s. */
  checkDb(): Promise<DbStatus>;
  /** Ends the pool once the running queries are done; calling it again changes nothing. */
  close(): Promise<void>;
}

export interface DatabaseOptions extends MigrateOptions {
  migrationsDir?: string;
  /** Pool size. */
  max?: number;
}

/** Migrates, then opens the pool. Rejects with a `DatabaseError` and leaves nothing open. */
export async function openDatabase(
  url: string,
  logger: Logger,
  { migrationsDir = DEFAULT_MIGRATIONS_DIR, max = 10, ...migrateOptions }: DatabaseOptions = {},
): Promise<Database> {
  await migrateDatabase(url, migrationsDir, logger, migrateOptions);
  migrateOptions.signal?.throwIfAborted();
  const pool = new pg.Pool({
    connectionString: libpqUrl(url),
    application_name: APP_NAME,
    max,
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
    keepAlive: true,
  });
  // An idle client whose backend went away (a Postgres restart, a failover): the pool
  // drops it and opens a new one for the next query. Unhandled, this event would crash
  // the process. One line with the code alone: the driver's message names user and host.
  pool.on("error", (error) => {
    logger.warn({ code: errorCode(error) }, "database: an idle connection was lost");
  });
  pool.on("connect", (client) => {
    client.on("error", ignoreClientError);
  });
  const db = drizzle({ client: pool });
  const store = createRoomStore(db);
  let closing: Promise<void> | undefined;
  return {
    db,
    store,
    runner: createCommandRunner(store),
    retention: createRetentionStore(pool),
    checkDb: async () => {
      try {
        await pool.query("select 1");
        return "ok";
      } catch {
        return "error";
      }
    },
    close: () => {
      closing ??= pool.end();
      return closing;
    },
  };
}

/**
 * The `setup` hook of `run()`: the database is migrated and open before the server
 * listens; `/api/health` pings it; `dispose` ends the pool after the server closed.
 * `database` is for the hooks that build on it (#10, W1). A signal during the start
 * aborts the wait for Postgres, for the lock or for the migrations.
 */
export async function setupDatabase(
  config: Config,
  logger: Logger,
  signal?: AbortSignal,
): Promise<Setup & { database: Database }> {
  const database = await openDatabase(config.databaseUrl, logger, {
    migrationsDir: config.migrationsDir ? resolve(config.migrationsDir) : DEFAULT_MIGRATIONS_DIR,
    signal,
  });
  return {
    database,
    deps: { checkDb: database.checkDb },
    dispose: database.close,
  };
}
