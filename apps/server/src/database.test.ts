import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { DrizzleQueryError } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import {
  CONNECT_BUDGET_MS,
  DEFAULT_MIGRATIONS_DIR,
  openDatabase,
  retryDelay,
  waitForDatabase,
} from "./database.ts";
import { DatabaseError, errorCode, guard } from "./db/errors.ts";
import { run } from "./run.ts";
import { collectLogs, SECRET, VALID_ENV } from "./test-support.ts";

const refused = () =>
  Object.assign(new Error("connect ECONNREFUSED 10.0.0.5:5432"), {
    code: "ECONNREFUSED",
  });

/** A clock that only moves when the code under test sleeps. */
function fakeTime() {
  let t = 0;
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms;
    },
  };
}

describe("retryDelay", () => {
  it("doubles from 0.5 s up to 5 s", () => {
    expect([1, 2, 3, 4, 5, 6, 9].map(retryDelay)).toEqual([
      500, 1000, 2000, 4000, 5000, 5000, 5000,
    ]);
  });
});

describe("waitForDatabase", () => {
  it("retries until the database answers, one log line per failed attempt", async () => {
    const logs = collectLogs();
    let calls = 0;
    await waitForDatabase(
      async () => {
        if (++calls < 4) throw refused();
      },
      logs.logger,
      fakeTime(),
    );
    expect(calls).toBe(4);
    expect(logs.lines.map(({ msg, attempt, code }) => ({ msg, attempt, code }))).toEqual([
      { msg: "database: not reachable, retrying", attempt: 1, code: "ECONNREFUSED" },
      { msg: "database: not reachable, retrying", attempt: 2, code: "ECONNREFUSED" },
      { msg: "database: not reachable, retrying", attempt: 3, code: "ECONNREFUSED" },
      { msg: "database: reachable", attempt: 4, code: undefined },
    ]);
  });

  it(`gives up within ${CONNECT_BUDGET_MS / 1000} s`, async () => {
    const logs = collectLogs();
    const time = fakeTime();
    let calls = 0;
    const waiting = waitForDatabase(
      async () => {
        calls++;
        throw refused();
      },
      logs.logger,
      time,
    );
    await expect(waiting).rejects.toThrow(DatabaseError);
    await expect(waiting).rejects.toMatchObject({ code: "ECONNREFUSED" });
    // Waits of 0.5 + 1 + 2 + 4 + 5 × 4 = 27.5 s; one more 5 s wait would pass 30 s.
    expect(time.now()).toBe(27_500);
    expect(calls).toBe(9);
    expect(logs.lines).toHaveLength(8);
  });

  it("stops at once when Postgres refuses the login", async () => {
    const logs = collectLogs();
    const denied = Object.assign(new Error(`password authentication failed`), { code: "28P01" });
    await expect(
      waitForDatabase(() => Promise.reject(denied), logs.logger, fakeTime()),
    ).rejects.toMatchObject({ name: "DatabaseError", code: "28P01" });
    expect(logs.lines).toEqual([]);
  });
});

describe("database errors", () => {
  it("reduce a failed query to its code: no SQL, no parameters, no cause", async () => {
    const cause = Object.assign(new Error("duplicate key"), { code: "23505" });
    const failed = guard("commit room", () =>
      Promise.reject(
        new DrizzleQueryError("update room set live = $1", [`{"card":"${SECRET}"}`], cause),
      ),
    );
    const error = await failed.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DatabaseError);
    expect(error).toMatchObject({ code: "23505", message: "database: commit room failed (23505)" });
    expect((error as Error).cause).toBeUndefined();
    expect(`${(error as Error).stack} ${JSON.stringify(error)}`).not.toContain(SECRET);
  });

  it("find a code on the error or its causes, else unknown", () => {
    expect(errorCode({ code: "57P01" })).toBe("57P01");
    expect(errorCode(new Error("x", { cause: { code: "ECONNRESET" } }))).toBe("ECONNRESET");
    expect(errorCode(new Error("no code"))).toBe("unknown");
    expect(errorCode({ code: "not a code: with spaces" })).toBe("unknown");
    expect(errorCode("text")).toBe("unknown");
  });

  it("pass a DatabaseError through unchanged", async () => {
    const original = new DatabaseError("connect", "ECONNREFUSED");
    await expect(guard("other", () => Promise.reject(original))).rejects.toBe(original);
  });
});

describe("openDatabase", () => {
  it("finds the migrations next to the server, from src/ as from dist/", () => {
    expect(DEFAULT_MIGRATIONS_DIR).toBe(resolve(import.meta.dirname, "../drizzle"));
    expect(existsSync(join(DEFAULT_MIGRATIONS_DIR, "meta", "_journal.json"))).toBe(true);
  });

  it("refuses a folder without migrations before connecting", async () => {
    await expect(
      openDatabase(VALID_ENV.DATABASE_URL, collectLogs().logger, {
        migrationsDir: join(import.meta.dirname, "no-such-folder"),
      }),
    ).rejects.toMatchObject({ name: "DatabaseError", code: "missing_migrations" });
  });

  it("never logs the connection string when the database is unreachable", async () => {
    const logs = collectLogs();
    const exits: number[] = [];
    // Port 1 refuses the connection; the URL carries the fake password.
    const server = await run(
      { ...VALID_ENV, PORT: "0", DATABASE_URL: `postgres://pp:${SECRET}@127.0.0.1:1/pp` },
      {
        exit: (code) => exits.push(code),
        onSignal: () => {},
        onCrash: () => {},
        destination: logs.destination,
        setup: (config, logger) =>
          openDatabase(config.databaseUrl, logger, { wait: { budgetMs: 1000 } }).then(() => ({})),
      },
    );
    expect(server).toBeUndefined();
    expect(exits).toEqual([1]);
    const fatal = logs.lines.at(-1);
    expect(fatal).toMatchObject({ msg: "setup failed", err: { type: "DatabaseError" } });
    expect(logs.raw.join("")).not.toContain(SECRET);
    expect(logs.raw.join("")).not.toContain("127.0.0.1:1/");
  }, 20_000);
});
