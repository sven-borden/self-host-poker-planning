/**
 * The tokens of the connectors (#53, ADR-026): one sealed value per account and connector.
 * Only `vault.ts` sees a token in the clear: what reaches a query, and so a driver error or
 * a database log, is the sealed value. Nothing here logs, and a failure comes back as a typed
 * result or a `DatabaseError`, whose text holds no value at all.
 *
 * With no key set (`vault` undefined) saving and reading say `vault_off`, and rows already
 * there stay. Listing and deleting need no key.
 */
import type pg from "pg";
import type { OpenFailure, Secret, Vault } from "../vault.ts";
import { guard } from "./errors.ts";

export const CONNECTORS = ["jira", "azure-devops"] as const;
export type Connector = (typeof CONNECTORS)[number];

/**
 * The name is a literal in the code that calls the store; this is for the day it is not. Only
 * the names above ever reach the database or a sealed value, and the text of a wrong one is
 * not repeated, since it came from outside.
 */
function checkConnector(connector: string): void {
  if (!(CONNECTORS as readonly string[]).includes(connector)) {
    throw new Error("connector tokens: not a known connector");
  }
}

declare const accountIdBrand: unique symbol;
/**
 * The id of the signed-in account whose session is making the request. The store trusts it:
 * the sealed value is bound to the id it is given, so a wrong id reads the wrong person's
 * token, and nothing below can tell. The only way to get one is `accountOf`, on the user that
 * `sessionUser` (auth.ts) read from the cookie. Never an id from a request body, a query, a
 * socket message or a room's seats, and never `as AccountId`.
 */
export type AccountId = string & { readonly [accountIdBrand]: true };

/** The account behind a session's user, or undefined for a guest: they hold no token. */
export function accountOf(user: {
  readonly id: string;
  readonly isAnonymous: boolean;
}): AccountId | undefined {
  return user.isAnonymous ? undefined : (user.id as AccountId);
}

declare const tokenVersionBrand: unique symbol;
/**
 * Names one state of a stored token, as `readToken` saw it. Opaque: it only goes back into
 * `replaceToken`. It changes with every save and replacement and not with a re-encryption.
 */
export type TokenVersion = string & { readonly [tokenVersionBrand]: true };

/** A provider's access and refresh tokens fit many times over; anything longer is a mistake. */
export const MAX_TOKEN_BYTES = 16 * 1024;

export type SaveTokenResult =
  | { readonly status: "saved" }
  | { readonly status: "vault_off" }
  /** A guest, or no such user: only a signed-in account holds tokens. */
  | { readonly status: "no_account" }
  | { readonly status: "too_large" };

export type ReplaceTokenResult =
  /** Written; `version` is the state it left, for the next replacement. */
  | { readonly status: "replaced"; readonly version: TokenVersion }
  /** The person disconnected meanwhile: nothing is written, and the new token is dropped. */
  | { readonly status: "gone" }
  /** Another refresh or a new connection was first: nothing is written. Read again. */
  | { readonly status: "changed" }
  | { readonly status: "vault_off" }
  | { readonly status: "too_large" };

export type ReadTokenResult =
  | { readonly status: "ok"; readonly token: Secret; readonly version: TokenVersion }
  | { readonly status: "vault_off" }
  | { readonly status: "not_connected" }
  /** The row is there and stays: the person connects again, which overwrites it. */
  | { readonly status: "unreadable"; readonly cause: OpenFailure };

/** What a connector may show about a connection without opening it. */
export interface Connection {
  readonly connector: Connector;
  readonly connectedAt: Date;
  readonly updatedAt: Date;
}

export interface ConnectorTokenStore {
  /** False without `POKER_VAULT_KEY`: a connector then offers no way to connect. */
  readonly enabled: boolean;
  /**
   * The person connecting, the first time or again: stores the token and replaces whatever is
   * there, an unreadable row too, whoever wrote it last. Never for a refresh. A refresh that
   * finishes after the person disconnected, or after another refresh, would bring back a
   * token that was deleted, or put back one the provider has already retired. A refresh reads
   * with `readToken` and writes with `replaceToken`.
   */
  saveToken(account: AccountId, connector: Connector, token: Secret): Promise<SaveTokenResult>;
  /**
   * Replaces the token only if the row is still the state `readToken` gave `version` for: the
   * answer is `replaced`, `gone` (disconnected meanwhile: drop the new token) or `changed`
   * (another write was first: read again, and use that one). It never creates a row.
   */
  replaceToken(
    account: AccountId,
    connector: Connector,
    version: TokenVersion,
    token: Secret,
  ): Promise<ReplaceTokenResult>;
  /** Opens the token; one still on an old key moves to the current key on the way. */
  readToken(account: AccountId, connector: Connector): Promise<ReadTokenResult>;
  /** True when there was a row. */
  deleteToken(account: AccountId, connector: Connector): Promise<boolean>;
  /**
   * Deletes the row only if it is still the state `readToken` gave `version` for: a refresh the
   * provider refused may be the loser of a race, and the winner's token must stay. True when
   * this deleted it.
   */
  dropToken(account: AccountId, connector: Connector, version: TokenVersion): Promise<boolean>;
  /**
   * What the connection points at (`connector_token.settings`), as stored: `undefined` without
   * a row, `null` for a row with none. No key is needed: nothing here is secret.
   */
  readSettings(account: AccountId, connector: Connector): Promise<unknown>;
  /** False without a row: the person disconnected meanwhile, and nothing is written. */
  writeSettings(account: AccountId, connector: Connector, settings: unknown): Promise<boolean>;
  listConnections(account: AccountId): Promise<Connection[]>;
}

/**
 * `is_anonymous` as the purge reads it: anything but true is an account. One statement, so a
 * guest cannot slip in between a check and the write, and an account on its way out, whose
 * connection finished after its deletion began (ADR-029), saves nothing. A new `version` marks the
 * new state.
 */
const SAVE_TOKEN = `
  insert into connector_token (user_id, connector, sealed_token)
  select u.id, $2, $3 from "user" u
  where u.id = $1 and u.is_anonymous is not true
    and not exists (select 1 from account_deletion d where d.user_id = u.id)
  on conflict (user_id, connector)
  do update set sealed_token = excluded.sealed_token, version = gen_random_uuid(),
                updated_at = now()`;

/**
 * A compare-and-set on the version the caller read. It cannot create a row, so a token whose
 * owner disconnected stays deleted, and it loses to any save or replacement made since.
 * `version` is compared as text, so a value that is no uuid is simply not a match.
 */
const REPLACE_TOKEN = `
  update connector_token
  set sealed_token = $4, version = gen_random_uuid(), updated_at = now()
  where user_id = $1 and connector = $2 and version::text = $3
  returning version`;

/**
 * A compare-and-set on the sealed value, which no two writes share (each has its own IV): a
 * token saved since the row was read is never overwritten by an older one. It changes neither
 * `version` nor `updated_at`: the token is the same, only its key differs, so a refresh that
 * read the row before a re-encryption can still replace it.
 */
const RESEAL_TOKEN = `
  update connector_token set sealed_token = $4
  where user_id = $1 and connector = $2 and sealed_token = $3`;

export function createConnectorTokenStore(
  pool: pg.Pool,
  vault: Vault | undefined,
): ConnectorTokenStore {
  return {
    enabled: vault !== undefined,

    saveToken: async (account, connector, token) => {
      checkConnector(connector);
      if (!vault) return { status: "vault_off" };
      if (Buffer.byteLength(token.reveal(), "utf8") > MAX_TOKEN_BYTES) {
        return { status: "too_large" };
      }
      const sealed = vault.seal(token, { userId: account, connector });
      const { rowCount } = await guard("save connector token", () =>
        pool.query(SAVE_TOKEN, [account, connector, sealed]),
      );
      return rowCount === 1 ? { status: "saved" } : { status: "no_account" };
    },

    replaceToken: async (account, connector, version, token) => {
      checkConnector(connector);
      if (!vault) return { status: "vault_off" };
      if (Buffer.byteLength(token.reveal(), "utf8") > MAX_TOKEN_BYTES) {
        return { status: "too_large" };
      }
      const sealed = vault.seal(token, { userId: account, connector });
      const replaced = await guard("replace connector token", () =>
        pool.query<{ version: TokenVersion }>(REPLACE_TOKEN, [account, connector, version, sealed]),
      );
      const next = replaced.rows[0]?.version;
      if (next !== undefined) return { status: "replaced", version: next };
      // Two statements: whichever of "changed" and "gone" is true by now is the answer, and
      // either one tells the caller to read again.
      const present = await guard("check connector token", () =>
        pool.query("select 1 from connector_token where user_id = $1 and connector = $2", [
          account,
          connector,
        ]),
      );
      return { status: present.rowCount === 1 ? "changed" : "gone" };
    },

    readToken: async (account, connector) => {
      checkConnector(connector);
      if (!vault) return { status: "vault_off" };
      const { rows } = await guard("read connector token", () =>
        pool.query<{ sealed_token: string; version: TokenVersion }>(
          "select sealed_token, version from connector_token where user_id = $1 and connector = $2",
          [account, connector],
        ),
      );
      const row = rows[0];
      if (row === undefined) return { status: "not_connected" };
      const context = { userId: account, connector };
      const opened = vault.open(row.sealed_token, context);
      if (!opened.ok) return { status: "unreadable", cause: opened.cause };
      if (!opened.onCurrentKey) {
        // A convenience: the token is already open, and `rotateTokens` moves what this misses.
        // It leaves `version` alone, so what the caller read can still be replaced.
        await pool
          .query(RESEAL_TOKEN, [
            account,
            connector,
            row.sealed_token,
            vault.seal(opened.token, context),
          ])
          .catch(() => {});
      }
      return { status: "ok", token: opened.token, version: row.version };
    },

    deleteToken: async (account, connector) => {
      checkConnector(connector);
      const { rowCount } = await guard("delete connector token", () =>
        pool.query("delete from connector_token where user_id = $1 and connector = $2", [
          account,
          connector,
        ]),
      );
      return rowCount === 1;
    },

    dropToken: async (account, connector, version) => {
      checkConnector(connector);
      const { rowCount } = await guard("drop connector token", () =>
        pool.query(
          "delete from connector_token where user_id = $1 and connector = $2 and version::text = $3",
          [account, connector, version],
        ),
      );
      return rowCount === 1;
    },

    readSettings: async (account, connector) => {
      checkConnector(connector);
      const { rows } = await guard("read connector settings", () =>
        pool.query<{ settings: unknown }>(
          "select settings from connector_token where user_id = $1 and connector = $2",
          [account, connector],
        ),
      );
      return rows[0]?.settings;
    },

    writeSettings: async (account, connector, settings) => {
      checkConnector(connector);
      const { rowCount } = await guard("write connector settings", () =>
        pool.query(
          "update connector_token set settings = $3 where user_id = $1 and connector = $2",
          [account, connector, settings === null ? null : JSON.stringify(settings)],
        ),
      );
      return rowCount === 1;
    },

    listConnections: async (account) => {
      const { rows } = await guard("list connections", () =>
        pool.query<{ connector: Connector; created_at: Date; updated_at: Date }>(
          `select connector, created_at, updated_at from connector_token
           where user_id = $1 order by connector`,
          [account],
        ),
      );
      return rows.map((row) => ({
        connector: row.connector,
        connectedAt: row.created_at,
        updatedAt: row.updated_at,
      }));
    },
  };
}

/** Rows read per statement during a rotation. */
export const ROTATION_BATCH = 200;

/** Scans of the whole table in one run, when rows keep appearing on an old key. */
export const ROTATION_PASSES = 3;

export interface RotationCounts {
  /** Rows opened in the last pass. The counts down to `corrupt` are that pass's. */
  scanned: number;
  /** Moved to the current key by that pass. */
  rotated: number;
  /** On the current key already when the pass reached them. */
  current: number;
  /** Lost the compare: a save, a replacement or another re-encryption was first. */
  changed: number;
  /** Cannot be opened because their key is not among this server's: add that key back. */
  unknownKey: number;
  /** Cannot be opened though their key is here: changed, moved to another row, or a format this version does not know. */
  corrupt: number;
  /** Rows not on the current key when the run ended, counted by the database, not by the scan. */
  offKey: number;
  passes: number;
}

type PassCounts = Pick<
  RotationCounts,
  "scanned" | "rotated" | "current" | "changed" | "unknownKey" | "corrupt"
>;

async function scanPass(pool: pg.Pool, vault: Vault, batchSize: number): Promise<PassCounts> {
  const counts: PassCounts = {
    scanned: 0,
    rotated: 0,
    current: 0,
    changed: 0,
    unknownKey: 0,
    corrupt: 0,
  };
  let after = { userId: "", connector: "" };
  for (;;) {
    const { rows } = await guard("read connector tokens", () =>
      pool.query<{ user_id: string; connector: string; sealed_token: string }>(
        `select user_id, connector, sealed_token from connector_token
         where (user_id, connector) > ($1::text, $2::text)
         order by user_id, connector limit $3`,
        [after.userId, after.connector, batchSize],
      ),
    );
    for (const row of rows) {
      const context = { userId: row.user_id, connector: row.connector };
      const opened = vault.open(row.sealed_token, context);
      counts.scanned += 1;
      if (!opened.ok) {
        if (opened.cause === "unknown_key") counts.unknownKey += 1;
        else counts.corrupt += 1;
      } else if (opened.onCurrentKey) {
        counts.current += 1;
      } else {
        const { rowCount } = await guard("reseal connector token", () =>
          pool.query(RESEAL_TOKEN, [
            row.user_id,
            row.connector,
            row.sealed_token,
            vault.seal(opened.token, context),
          ]),
        );
        // Not "current": the winner may have written under any key. The check at the end of
        // the run says where the row is.
        if (rowCount === 1) counts.rotated += 1;
        else counts.changed += 1;
      }
      after = context;
    }
    if (rows.length < batchSize) return counts;
  }
}

/**
 * Re-encrypts every row to the current key, one row per statement, while the server runs.
 * Every row is opened, including those on the current key, so `unknownKey` and `corrupt` are
 * true counts. Stopped halfway or run twice, it changes nothing it should not: a row on the
 * current key is left alone, and `RESEAL_TOKEN` loses to a token saved in the meantime.
 *
 * A scan cannot see a row saved behind it, nor one that an instance still on an old key moves
 * back (it reseals what it reads to its own current key). So the run ends by asking the
 * database how many rows are not on the current key (`offKey`), and while that is above 0 with
 * nothing unreadable, it scans again, up to `maxPasses` times.
 */
export async function rotateTokens(
  pool: pg.Pool,
  vault: Vault,
  batchSize = ROTATION_BATCH,
  maxPasses = ROTATION_PASSES,
): Promise<RotationCounts> {
  for (let pass = 1; ; pass++) {
    const counts = await scanPass(pool, vault, batchSize);
    const { rows } = await guard("count connector tokens off the current key", () =>
      pool.query<{ n: number }>(
        `select count(*)::int as n from connector_token
         where split_part(sealed_token, '.', 2) <> $1`,
        [vault.currentKeyId],
      ),
    );
    const offKey = rows[0]?.n ?? 0;
    // With a row unreadable the verdict is "not complete" whatever a scan does: no point in more.
    const unreadable = counts.unknownKey + counts.corrupt;
    if (offKey === 0 || unreadable > 0 || pass >= maxPasses) {
      return { ...counts, offKey, passes: pass };
    }
  }
}
