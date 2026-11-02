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

/** A provider's access and refresh tokens fit many times over; anything longer is a mistake. */
export const MAX_TOKEN_BYTES = 16 * 1024;

export type SaveTokenResult =
  | { readonly status: "saved" }
  | { readonly status: "vault_off" }
  /** A guest, or no such user: only a signed-in account holds tokens. */
  | { readonly status: "no_account" }
  | { readonly status: "too_large" };

export type ReadTokenResult =
  | { readonly status: "ok"; readonly token: Secret }
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
  /** Stores or replaces the token of this account and connector. */
  saveToken(userId: string, connector: Connector, token: Secret): Promise<SaveTokenResult>;
  /** Opens the token; one still on an old key moves to the current key on the way. */
  readToken(userId: string, connector: Connector): Promise<ReadTokenResult>;
  /** True when there was a row. */
  deleteToken(userId: string, connector: Connector): Promise<boolean>;
  listConnections(userId: string): Promise<Connection[]>;
}

/**
 * `is_anonymous` as the purge reads it: anything but true is an account. One statement, so a
 * guest cannot slip in between a check and the write.
 */
const SAVE_TOKEN = `
  insert into connector_token (user_id, connector, sealed_token)
  select u.id, $2, $3 from "user" u where u.id = $1 and u.is_anonymous is not true
  on conflict (user_id, connector)
  do update set sealed_token = excluded.sealed_token, updated_at = now()`;

/**
 * A compare-and-set on the sealed value, which no two writes share (each has its own IV): a
 * token saved since the row was read is never overwritten by an older one. `updated_at` says
 * when the token last changed, and this does not change it.
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

    saveToken: async (userId, connector, token) => {
      if (!vault) return { status: "vault_off" };
      if (Buffer.byteLength(token.reveal(), "utf8") > MAX_TOKEN_BYTES) {
        return { status: "too_large" };
      }
      const sealed = vault.seal(token, { userId, connector });
      const { rowCount } = await guard("save connector token", () =>
        pool.query(SAVE_TOKEN, [userId, connector, sealed]),
      );
      return rowCount === 1 ? { status: "saved" } : { status: "no_account" };
    },

    readToken: async (userId, connector) => {
      if (!vault) return { status: "vault_off" };
      const { rows } = await guard("read connector token", () =>
        pool.query<{ sealed_token: string }>(
          "select sealed_token from connector_token where user_id = $1 and connector = $2",
          [userId, connector],
        ),
      );
      const sealed = rows[0]?.sealed_token;
      if (sealed === undefined) return { status: "not_connected" };
      const context = { userId, connector };
      const opened = vault.open(sealed, context);
      if (!opened.ok) return { status: "unreadable", cause: opened.cause };
      if (!opened.onCurrentKey) {
        // A convenience: the token is already open, and `rotateTokens` moves what this misses.
        await pool
          .query(RESEAL_TOKEN, [userId, connector, sealed, vault.seal(opened.token, context)])
          .catch(() => {});
      }
      return { status: "ok", token: opened.token };
    },

    deleteToken: async (userId, connector) => {
      const { rowCount } = await guard("delete connector token", () =>
        pool.query("delete from connector_token where user_id = $1 and connector = $2", [
          userId,
          connector,
        ]),
      );
      return rowCount === 1;
    },

    listConnections: async (userId) => {
      const { rows } = await guard("list connections", () =>
        pool.query<{ connector: Connector; created_at: Date; updated_at: Date }>(
          `select connector, created_at, updated_at from connector_token
           where user_id = $1 order by connector`,
          [userId],
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

export interface RotationCounts {
  scanned: number;
  /** Moved to the current key by this run. */
  rotated: number;
  /** On the current key already, or saved anew while this ran. */
  current: number;
  /** Left in place: see `OpenFailure`. They stay until the person connects again. */
  unreadable: number;
}

/**
 * Re-encrypts every row to the current key, one row per statement, while the server runs.
 * Every row is opened, including those on the current key, so `unreadable` is the true count.
 * Stopped halfway or run twice, it changes nothing it should not: a row on the current key is
 * left alone, and `RESEAL_TOKEN` loses to a token saved in the meantime.
 */
export async function rotateTokens(
  pool: pg.Pool,
  vault: Vault,
  batchSize = ROTATION_BATCH,
): Promise<RotationCounts> {
  const counts: RotationCounts = { scanned: 0, rotated: 0, current: 0, unreadable: 0 };
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
        counts.unreadable += 1;
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
        if (rowCount === 1) counts.rotated += 1;
        else counts.current += 1;
      }
      after = context;
    }
    if (rows.length < batchSize) return counts;
  }
}
