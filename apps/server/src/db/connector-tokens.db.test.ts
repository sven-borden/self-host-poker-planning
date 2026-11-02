/**
 * The connectors' tokens against a real Postgres (#53): what a dump holds, who may hold a
 * token, what happens to a row that no longer opens, and a rotation under a running server.
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { inspect } from "node:util";
import type pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { migrateDatabase } from "../database.ts";
import { collectLogs, VALID_ENV } from "../test-support.ts";
import { Secret, Vault, vaultKeyId } from "../vault.ts";
import { runVaultRotation } from "../vault-rotation.ts";
import {
  type ConnectorTokenStore,
  createConnectorTokenStore,
  MAX_TOKEN_BYTES,
  rotateTokens,
} from "./connector-tokens.ts";
import { DatabaseError } from "./errors.ts";
import { createRetentionStore } from "./retention.ts";
import { createTestDatabase, type TestDatabase, testClient } from "./test-db.ts";

const MAIN = resolve(import.meta.dirname, "../../dist/main.mjs");

const newKey = () => randomBytes(32).toString("base64");
const newToken = () => `fake-access-${randomBytes(24).toString("hex")}`;

const OLD_KEY = newKey();
const NEW_KEY = newKey();

let t: TestDatabase;
let sql: pg.Pool;
let tokens: ConnectorTokenStore;

beforeAll(async () => {
  t = await createTestDatabase();
  await migrateDatabase(t.url, resolve(import.meta.dirname, "../../drizzle"), collectLogs().logger);
  sql = testClient(t.url);
  tokens = createConnectorTokenStore(sql, new Vault(NEW_KEY));
});
afterAll(async () => {
  await sql?.end();
  await t?.drop();
});
beforeEach(async () => {
  await sql.query(`truncate "user" cascade`);
});

async function user(id: string, anonymous: boolean | null = false) {
  await sql.query(
    `insert into "user" (id, name, email, is_anonymous, created_at, updated_at)
     values ($1, 'Fake Person', $1 || '@example.test', $2, now() - interval '30 days', now())`,
    [id, anonymous],
  );
}

const storeWith = (current: string, old: string[] = []) =>
  createConnectorTokenStore(sql, new Vault(current, old));

const sealedOf = async (userId: string, connector = "jira") =>
  (
    await sql.query<{ sealed_token: string }>(
      "select sealed_token from connector_token where user_id = $1 and connector = $2",
      [userId, connector],
    )
  ).rows[0]?.sealed_token;

const keyIdOfRow = async (userId: string, connector = "jira") =>
  (await sealedOf(userId, connector))?.split(".")[1];

const rowCount = async () =>
  (await sql.query<{ n: number }>("select count(*)::int as n from connector_token")).rows[0]?.n;

async function readBack(store: ConnectorTokenStore, userId: string, connector: "jira" = "jira") {
  const read = await store.readToken(userId, connector);
  return read.status === "ok" ? read.token.reveal() : read;
}

/** Every row of every table outside Postgres's own schemas, as text: a dump without pg_dump. */
async function dump(): Promise<string> {
  const { rows: tables } = await sql.query<{ table_schema: string; table_name: string }>(
    `select table_schema, table_name from information_schema.tables
     where table_type = 'BASE TABLE' and table_schema not in ('pg_catalog', 'information_schema')`,
  );
  const parts = await Promise.all(
    tables.map(async ({ table_schema: schema, table_name: name }) => {
      const { rows } = await sql.query<{ row: string }>(
        `select t::text as row from "${schema}"."${name}" t`,
      );
      return { name, text: rows.map((r) => r.row).join("\n") };
    }),
  );
  expect(parts.map((p) => p.name)).toEqual(expect.arrayContaining(["connector_token", "user"]));
  return parts.map((p) => p.text).join("\n");
}

describe("a database dump", () => {
  it("holds neither the token nor any recognisable slice of it", async () => {
    await user("user-a");
    const token = newToken();
    expect(await tokens.saveToken("user-a", "jira", new Secret(token))).toEqual({
      status: "saved",
    });

    const text = await dump();
    expect(text).toContain(await sealedOf("user-a"));
    expect(text).toContain("Fake Person"); // The dump does read the rows.
    for (let at = 0; at + 8 <= token.length; at++) {
      expect(text).not.toContain(token.slice(at, at + 8));
    }
    for (const encoding of ["base64", "base64url", "hex"] as const) {
      const encoded = Buffer.from(token).toString(encoding).replace(/=+$/, "");
      for (let at = 0; at + 12 <= encoded.length; at += 4) {
        expect(text).not.toContain(encoded.slice(at, at + 12));
      }
    }
    expect(await readBack(tokens, "user-a")).toBe(token);
  });

  it("holds about the row only its owner, connector, dates and sealed value", async () => {
    const { rows } = await sql.query<{ column_name: string }>(
      `select column_name from information_schema.columns
       where table_name = 'connector_token' order by ordinal_position`,
    );
    expect(rows.map((r) => r.column_name)).toEqual([
      "user_id",
      "connector",
      "sealed_token",
      "created_at",
      "updated_at",
    ]);
  });

  it("two seals of one token look unrelated", async () => {
    await user("user-a");
    await user("user-b");
    const token = new Secret(newToken());
    await tokens.saveToken("user-a", "jira", token);
    await tokens.saveToken("user-b", "jira", token);
    const [a, b] = [await sealedOf("user-a"), await sealedOf("user-b")];
    expect(a?.split(".")[4]).not.toBe(b?.split(".")[4]);
  });
});

describe("who holds a token", () => {
  it("an account does, one per connector, replaced by a later save", async () => {
    await user("user-a");
    const first = newToken();
    const jira = newToken();
    const azure = newToken();
    await tokens.saveToken("user-a", "jira", new Secret(first));
    await sql.query(
      "update connector_token set created_at = '2026-01-01', updated_at = '2026-01-01'",
    );
    await tokens.saveToken("user-a", "jira", new Secret(jira));
    await tokens.saveToken("user-a", "azure-devops", new Secret(azure));

    expect(await rowCount()).toBe(2);
    expect(await readBack(tokens, "user-a")).toBe(jira);
    const read = await tokens.readToken("user-a", "azure-devops");
    expect(read.status === "ok" && read.token.reveal()).toBe(azure);
    const list = await tokens.listConnections("user-a");
    expect(list.map((c) => c.connector)).toEqual(["azure-devops", "jira"]);
    const row = list[1];
    expect(row?.connectedAt.toISOString()).toBe(new Date("2026-01-01").toISOString());
    expect(row?.updatedAt.getTime()).toBeGreaterThan(row?.connectedAt.getTime() ?? 0);
    expect(JSON.stringify(list)).not.toContain("v1.");
  });

  it("is_anonymous null counts as an account, as in the purge", async () => {
    await user("user-a", null);
    expect(await tokens.saveToken("user-a", "jira", new Secret(newToken()))).toEqual({
      status: "saved",
    });
  });

  it("a guest does not, and neither does someone who does not exist", async () => {
    await user("guest", true);
    for (const id of ["guest", "nobody"]) {
      expect(await tokens.saveToken(id, "jira", new Secret(newToken()))).toEqual({
        status: "no_account",
      });
      expect(await tokens.readToken(id, "jira")).toEqual({ status: "not_connected" });
    }
    expect(await rowCount()).toBe(0);
  });

  it("a token past the limit is refused, and one at it stored", async () => {
    await user("user-a");
    const atLimit = new Secret("x".repeat(MAX_TOKEN_BYTES));
    expect(await tokens.saveToken("user-a", "jira", atLimit)).toEqual({ status: "saved" });
    const over = new Secret("é".repeat(MAX_TOKEN_BYTES / 2 + 1));
    expect(await tokens.saveToken("user-a", "azure-devops", over)).toEqual({
      status: "too_large",
    });
    expect(await rowCount()).toBe(1);
  });

  it("nobody after deleting, and deleting twice is no error", async () => {
    await user("user-a");
    await tokens.saveToken("user-a", "jira", new Secret(newToken()));
    expect(await tokens.deleteToken("user-a", "jira")).toBe(true);
    expect(await tokens.deleteToken("user-a", "jira")).toBe(false);
    expect(await tokens.readToken("user-a", "jira")).toEqual({ status: "not_connected" });
  });
});

describe("when the user goes", () => {
  it("deleting the account takes every token (#51)", async () => {
    await user("user-a");
    await user("user-b");
    await tokens.saveToken("user-a", "jira", new Secret(newToken()));
    await tokens.saveToken("user-a", "azure-devops", new Secret(newToken()));
    await tokens.saveToken("user-b", "jira", new Secret(newToken()));
    await sql.query(`delete from "user" where id = 'user-a'`);
    const { rows } = await sql.query("select user_id from connector_token");
    expect(rows).toEqual([{ user_id: "user-b" }]);
  });

  it("the purge cannot leave a token behind (#35), and takes none from an account", async () => {
    await user("user-a");
    await user("guest", true);
    await tokens.saveToken("user-a", "jira", new Secret(newToken()));
    // The store refuses a guest, so only a row written around it can be here.
    await sql.query(
      `insert into connector_token (user_id, connector, sealed_token)
       values ('guest', 'jira', 'v1.planted')`,
    );
    const counts = await createRetentionStore(sql).purge({ ttlDays: 90 });
    expect(counts?.guests).toBe(1);
    const { rows } = await sql.query("select user_id from connector_token");
    expect(rows).toEqual([{ user_id: "user-a" }]);
  });
});

describe("a row that does not open", () => {
  const firstToken = newToken();

  beforeEach(async () => {
    await user("user-a");
    await user("user-b");
    await tokens.saveToken("user-a", "jira", new Secret(firstToken));
  });

  it("copied onto another user or connector: a state, and the row stays", async () => {
    await sql.query(
      `insert into connector_token (user_id, connector, sealed_token)
       select 'user-b', connector, sealed_token from connector_token where user_id = 'user-a'`,
    );
    await sql.query(
      `insert into connector_token (user_id, connector, sealed_token)
       select user_id, 'azure-devops', sealed_token from connector_token where user_id = 'user-a'`,
    );
    const copied = await sealedOf("user-b");
    expect(await tokens.readToken("user-b", "jira")).toEqual({
      status: "unreadable",
      cause: "corrupt",
    });
    expect(await tokens.readToken("user-a", "azure-devops")).toEqual({
      status: "unreadable",
      cause: "corrupt",
    });
    expect(await sealedOf("user-b")).toBe(copied);
    expect(await readBack(tokens, "user-a")).toBe(firstToken);
  });

  it("changed in place: a state, and the row stays", async () => {
    const tampered = (await sealedOf("user-a"))?.replace(/.$/, (last) =>
      last === "A" ? "B" : "A",
    );
    await sql.query("update connector_token set sealed_token = $1", [tampered]);
    expect(await tokens.readToken("user-a", "jira")).toEqual({
      status: "unreadable",
      cause: "corrupt",
    });
    expect(await sealedOf("user-a")).toBe(tampered);
  });

  it("with its key gone: a state, the row stays, and the key coming back opens it", async () => {
    const without = storeWith(newKey());
    const sealed = await sealedOf("user-a");
    expect(await without.readToken("user-a", "jira")).toEqual({
      status: "unreadable",
      cause: "unknown_key",
    });
    expect(await sealedOf("user-a")).toBe(sealed);
    expect(await readBack(tokens, "user-a")).toBe(firstToken);
  });

  it("is overwritten by connecting again", async () => {
    const without = storeWith(newKey());
    const again = newToken();
    expect(await without.saveToken("user-a", "jira", new Secret(again))).toEqual({
      status: "saved",
    });
    expect(await readBack(without, "user-a")).toBe(again);
  });
});

describe("with no key set", () => {
  const off = () => createConnectorTokenStore(sql, undefined);

  it("says it is off, keeps what is there, and still lists and deletes", async () => {
    await user("user-a");
    const token = newToken();
    await tokens.saveToken("user-a", "jira", new Secret(token));

    expect(off().enabled).toBe(false);
    expect(tokens.enabled).toBe(true);
    expect(await off().saveToken("user-a", "jira", new Secret(newToken()))).toEqual({
      status: "vault_off",
    });
    expect(await off().readToken("user-a", "jira")).toEqual({ status: "vault_off" });
    expect(await readBack(tokens, "user-a")).toBe(token);
    expect((await off().listConnections("user-a")).map((c) => c.connector)).toEqual(["jira"]);
    expect(await off().deleteToken("user-a", "jira")).toBe(true);
  });
});

describe("a failed query", () => {
  it("keeps the token and the sealed value out of the error and the logs", async () => {
    await user("user-a");
    const token = newToken();
    const logs = collectLogs();
    await sql.query("alter table connector_token rename to connector_token_away");
    try {
      const failures = await Promise.all([
        tokens.saveToken("user-a", "jira", new Secret(token)).catch((error: unknown) => error),
        tokens.readToken("user-a", "jira").catch((error: unknown) => error),
        tokens.deleteToken("user-a", "jira").catch((error: unknown) => error),
        tokens.listConnections("user-a").catch((error: unknown) => error),
      ]);
      for (const failure of failures) {
        expect(failure).toBeInstanceOf(DatabaseError);
        expect((failure as DatabaseError).cause).toBeUndefined();
        logs.logger.error({ err: failure }, "connector failed");
        const text = `${String(failure)} ${inspect(failure, { depth: 5 })}`;
        expect(text).not.toContain(token);
        expect(text).not.toContain("v1.");
        expect(text).not.toContain("connector_token");
      }
      const output = logs.raw.join("");
      expect(logs.lines).toHaveLength(4);
      expect(output).not.toContain(token);
      expect(output).not.toContain(`v1.${vaultKeyId(NEW_KEY)}`);
    } finally {
      await sql.query("alter table connector_token_away rename to connector_token");
    }
  });
});

describe("re-encryption on use", () => {
  it("moves a token on an old key to the current one and leaves updated_at", async () => {
    await user("user-a");
    const token = newToken();
    await storeWith(OLD_KEY).saveToken("user-a", "jira", new Secret(token));
    await sql.query("update connector_token set updated_at = '2026-01-01'");

    const rotated = storeWith(NEW_KEY, [OLD_KEY]);
    expect(await keyIdOfRow("user-a")).toBe(vaultKeyId(OLD_KEY));
    expect(await readBack(rotated, "user-a")).toBe(token);
    expect(await keyIdOfRow("user-a")).toBe(vaultKeyId(NEW_KEY));
    expect(await readBack(storeWith(NEW_KEY), "user-a")).toBe(token);
    const { rows } = await sql.query<{ updated_at: Date }>(
      "select updated_at from connector_token",
    );
    expect(rows[0]?.updated_at.toISOString()).toBe(new Date("2026-01-01").toISOString());
  });

  it("gives the token even when the write fails", async () => {
    await user("user-a");
    const token = newToken();
    await storeWith(OLD_KEY).saveToken("user-a", "jira", new Secret(token));
    const refusesUpdates = {
      query: (text: string, params: unknown[]) =>
        text.includes("update connector_token")
          ? Promise.reject(new Error("the write failed"))
          : sql.query(text, params),
    } as unknown as pg.Pool;
    const store = createConnectorTokenStore(refusesUpdates, new Vault(NEW_KEY, [OLD_KEY]));
    expect(await readBack(store, "user-a")).toBe(token);
    expect(await keyIdOfRow("user-a")).toBe(vaultKeyId(OLD_KEY));
  });
});

describe("rotateTokens", () => {
  const vault = new Vault(NEW_KEY, [OLD_KEY]);

  async function seed(count: number) {
    const old = storeWith(OLD_KEY);
    const seeded = new Map<string, string>();
    for (let i = 0; i < count; i++) {
      const id = `user-${String(i).padStart(3, "0")}`;
      await user(id);
      const token = newToken();
      await old.saveToken(id, "jira", new Secret(token));
      seeded.set(id, token);
    }
    return seeded;
  }

  it("moves every row, across batches, and the old key can then go", async () => {
    const seeded = await seed(7);
    await sql.query(
      `insert into connector_token (user_id, connector, sealed_token)
       values ('user-000', 'azure-devops', $1)`,
      [
        new Vault(OLD_KEY).seal(new Secret("fake-other"), {
          userId: "user-000",
          connector: "azure-devops",
        }),
      ],
    );
    expect(await rotateTokens(sql, vault, 3)).toEqual({
      scanned: 8,
      rotated: 8,
      current: 0,
      unreadable: 0,
    });
    const onlyNew = storeWith(NEW_KEY);
    for (const [id, token] of seeded) expect(await readBack(onlyNew, id)).toBe(token);
    const read = await onlyNew.readToken("user-000", "azure-devops");
    expect(read.status === "ok" && read.token.reveal()).toBe("fake-other");
  });

  it("run again, or after stopping halfway, changes nothing it should not", async () => {
    await seed(4);
    await tokens.saveToken("user-000", "jira", new Secret(newToken())); // Already current.
    const first = await rotateTokens(sql, vault, 2);
    expect(first).toEqual({ scanned: 4, rotated: 3, current: 1, unreadable: 0 });
    const before = await sql.query("select * from connector_token order by user_id");
    expect(await rotateTokens(sql, vault)).toEqual({
      scanned: 4,
      rotated: 0,
      current: 4,
      unreadable: 0,
    });
    const after = await sql.query("select * from connector_token order by user_id");
    expect(after.rows).toEqual(before.rows);
  });

  it("does not need a batch's worth of rows, and handles none", async () => {
    expect(await rotateTokens(sql, vault)).toEqual({
      scanned: 0,
      rotated: 0,
      current: 0,
      unreadable: 0,
    });
    await seed(3);
    expect((await rotateTokens(sql, vault, 3)).rotated).toBe(3);
  });

  it("never overwrites a token saved while it ran", async () => {
    await seed(1);
    const newer = newToken();
    let raced = false;
    const racing = {
      query: async (text: string, params: unknown[]) => {
        if (!raced && text.includes("update connector_token")) {
          raced = true;
          await tokens.saveToken("user-000", "jira", new Secret(newer));
        }
        return sql.query(text, params);
      },
    } as unknown as pg.Pool;
    expect(await rotateTokens(racing, vault)).toEqual({
      scanned: 1,
      rotated: 0,
      current: 1,
      unreadable: 0,
    });
    expect(await readBack(tokens, "user-000")).toBe(newer);
  });

  it("leaves a row it cannot open byte for byte, and moves the others", async () => {
    await seed(3);
    await sql.query(
      "update connector_token set user_id = 'user-002', connector = 'x' where user_id = 'user-000'",
    );
    const foreign = new Vault(newKey());
    const lost = foreign.seal(new Secret("fake-lost"), { userId: "user-001", connector: "jira" });
    await sql.query(`update connector_token set sealed_token = $1 where user_id = 'user-001'`, [
      lost,
    ]);
    const moved = await sealedOf("user-002", "x");
    expect(await rotateTokens(sql, vault)).toEqual({
      scanned: 3,
      rotated: 1,
      current: 0,
      unreadable: 2,
    });
    expect(await sealedOf("user-002", "x")).toBe(moved);
    expect(await sealedOf("user-001")).toBe(lost);
  });
});

describe("the vault:rotate command", () => {
  const env = () => ({
    ...VALID_ENV,
    DATABASE_URL: t.url,
    POKER_VAULT_KEY: NEW_KEY,
    POKER_VAULT_OLD_KEYS: OLD_KEY,
  });

  it("logs counts alone and says 0 when every row is on the current key", async () => {
    await user("user-a");
    const token = newToken();
    await storeWith(OLD_KEY).saveToken("user-a", "jira", new Secret(token));
    const logs = collectLogs();
    expect(await runVaultRotation(env(), logs.destination)).toBe(0);
    expect(logs.lines).toHaveLength(1);
    expect(logs.lines[0]).toMatchObject({ scanned: 1, rotated: 1, current: 0, unreadable: 0 });
    const output = logs.raw.join("");
    for (const secret of [token, OLD_KEY, NEW_KEY, "user-a"]) {
      expect(output).not.toContain(secret);
    }
    expect(await keyIdOfRow("user-a")).toBe(vaultKeyId(NEW_KEY));
  });

  it("says 1 while a row cannot be opened, and leaves it", async () => {
    await user("user-a");
    await storeWith(newKey()).saveToken("user-a", "jira", new Secret(newToken()));
    const sealed = await sealedOf("user-a");
    const logs = collectLogs();
    expect(await runVaultRotation(env(), logs.destination)).toBe(1);
    expect(logs.lines[0]).toMatchObject({ scanned: 1, unreadable: 1 });
    expect(await sealedOf("user-a")).toBe(sealed);
  });

  it("says 1 without a key or with a bad one, naming no value", async () => {
    const logs = collectLogs();
    const { POKER_VAULT_KEY: _, POKER_VAULT_OLD_KEYS: __, ...noKey } = env();
    expect(await runVaultRotation(noKey, logs.destination)).toBe(1);
    expect(logs.messages()[0]).toContain("POKER_VAULT_KEY is not set");
    const bad = "not-a-key-do-not-log";
    expect(await runVaultRotation({ ...env(), POKER_VAULT_KEY: bad }, logs.destination)).toBe(1);
    expect(logs.lines[1]).toMatchObject({ variables: ["POKER_VAULT_KEY"] });
    expect(logs.raw.join("")).not.toContain(bad);
  });

  it("says 1 when the database fails, with the code alone", async () => {
    const logs = collectLogs();
    const url = new URL(t.url);
    url.pathname = "/no_such_database";
    expect(
      await runVaultRotation({ ...env(), DATABASE_URL: url.toString() }, logs.destination),
    ).toBe(1);
    expect(logs.lines[0]).toMatchObject({ code: "3D000" });
    expect(logs.raw.join("")).not.toContain(url.password);
  });

  it("runs from the built server, opens no port and exits", async () => {
    await user("user-a");
    await storeWith(OLD_KEY).saveToken("user-a", "jira", new Secret(newToken()));
    const output: string[] = [];
    const childEnv: NodeJS.ProcessEnv = { ...process.env, ...env(), NODE_ENV: "production" };
    delete childEnv.NODE_OPTIONS;
    const started = spawn(process.execPath, [MAIN, "vault:rotate"], {
      env: childEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });
    started.stdout.on("data", (chunk: Buffer) => output.push(chunk.toString()));
    started.stderr.on("data", (chunk: Buffer) => output.push(chunk.toString()));
    const code = await new Promise((done) => started.once("exit", done));
    expect(code).toBe(0);
    expect(output.join("")).toContain('"rotated":1');
    expect(output.join("")).not.toContain("listening");
    expect(await keyIdOfRow("user-a")).toBe(vaultKeyId(NEW_KEY));
  });
});
