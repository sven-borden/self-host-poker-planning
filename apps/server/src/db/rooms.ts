/**
 * The room repository: the only code that reads or writes `room`, `round_history` and
 * `room_access`. Every write of `live` is a compare-and-set on `version`, so several
 * server instances stay correct without a lock; the command runner (runner.ts) retries a
 * lost one.
 */
import type { RoomState, UserId } from "@pp/domain";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { guard } from "./errors.ts";
import { type EndedRound, historyRow, isHistory } from "./history.ts";
import { room, roomAccess, roundHistory } from "./schema.ts";

export type Db = NodePgDatabase;

/** A room as loaded: `state` is `live`, `version` the value the next commit must expect. */
export interface StoredRoom {
  id: string;
  code: string;
  version: number;
  state: RoomState;
}

export interface NewRoom {
  /** Random, unique (architecture section 8). */
  code: string;
  name: string | null;
  state: RoomState;
  /** argon2id hash; never part of `state`. */
  passwordHash?: string | null;
}

/** What anyone holding a room's code may read without entering it: never its state. */
export interface RoomHeader {
  code: string;
  name: string | null;
  /** Whether the room asks for a password (#31): the join screen shows its field. */
  hasPassword: boolean;
}

/**
 * The access side of a commit (#31), written in the commit's transaction, so the room's
 * `hasPassword` and its hash and grants never disagree. `passwordHash`: the new hash, or
 * null to remove it (left out, the column stays); either one also starts the per-room
 * count of wrong tries afresh. `revokeAll` drops every grant of the room before `grant`
 * writes its users; `revoke` drops those users' grants (a kick).
 */
export interface AccessWrite {
  passwordHash?: string | null;
  revokeAll?: boolean;
  revoke?: readonly UserId[];
  grant?: readonly UserId[];
}

/** A room's password, for the access check: its id and hash (null: none). */
export interface StoredPassword {
  id: string;
  hash: string | null;
  /** The room's PO: always lets in, password or not. */
  ownerId: UserId;
  /** Wrong tries in the current window, and seconds until it ends (0 when none runs). */
  failures: number;
  retryAfter: number;
}

/** The version a new room starts at. */
export const FIRST_VERSION = 1;

export interface RoomStore {
  /** Creates a room at `FIRST_VERSION`. Resolves `null` when the code is taken: draw another. */
  insertRoom(room: NewRoom): Promise<StoredRoom | null>;
  loadRoom(code: string): Promise<StoredRoom | null>;
  /** The room's code, name and whether it has a password, without loading `live`. */
  loadRoomHeader(code: string): Promise<RoomHeader | null>;
  /**
   * Writes `next` when the room is still at `expectedVersion`, bumps the version and
   * `last_active_at`, and copies `next.ownerId` to `owner_user_id`. Resolves false when
   * another write came first (nothing is written). When `ended` holds a revealed round,
   * its history row is written in the same transaction; writing the same round again
   * updates that row, so a retry never duplicates it. `access` (#31) is written in that
   * transaction too.
   */
  commitRoom(
    id: string,
    expectedVersion: number,
    next: RoomState,
    ended?: EndedRound,
    access?: AccessWrite,
  ): Promise<boolean>;
}

/** Grants and wrong tries (#31): what the access check reads and writes beside a commit. */
export interface AccessStore {
  /** Whether `user` holds a grant for the room (by id). */
  hasAccess(roomId: string, user: UserId): Promise<boolean>;
  /** Grants `user` access to the room (a correct password); a second grant changes nothing. */
  grantAccess(roomId: string, user: UserId): Promise<void>;
  /** The room's hash and its count of wrong tries in a window of `windowSeconds`. */
  loadPassword(code: string, windowSeconds: number): Promise<StoredPassword | null>;
  /**
   * Counts one wrong try on the room: a fixed window of `windowSeconds` that starts with
   * the first try after the last one ended. Atomic, so every instance counts in the same
   * row. Resolves the count in the window, with this try.
   */
  recordFailure(roomId: string, windowSeconds: number): Promise<number>;
}

const hasHash = sql<boolean>`${room.passwordHash} is not null`;

export function createRoomStore(db: Db): RoomStore & AccessStore {
  /** Whether the window of wrong tries that started at `password_failures_since` still runs. */
  const inWindow = (seconds: number) =>
    sql`(${room.passwordFailuresSince} is not null and ${room.passwordFailuresSince} > now() - make_interval(secs => ${seconds}))`;

  async function writeAccess(tx: Db, id: string, access: AccessWrite) {
    if (access.passwordHash !== undefined) {
      await tx
        .update(room)
        .set({
          passwordHash: access.passwordHash,
          passwordFailures: 0,
          passwordFailuresSince: null,
        })
        .where(eq(room.id, id));
    }
    if (access.revokeAll) {
      await tx.delete(roomAccess).where(eq(roomAccess.roomId, id));
    } else if (access.revoke && access.revoke.length > 0) {
      await tx
        .delete(roomAccess)
        .where(and(eq(roomAccess.roomId, id), inArray(roomAccess.userId, [...access.revoke])));
    }
    if (access.grant && access.grant.length > 0) {
      // Only users that exist: a guest purged since (or a test's made-up id) gets no row.
      await tx.execute(sql`
        insert into ${roomAccess} (room_id, user_id)
        select ${id}::uuid, u.id from "user" u where u.id in (${sql.join(
          access.grant.map((who) => sql`${who}`),
          sql`, `,
        )})
        on conflict do nothing`);
    }
  }

  return {
    insertRoom: ({ code, name, state, passwordHash = null }) =>
      guard("insert room", async () => {
        const rows = await db
          .insert(room)
          .values({
            code,
            name,
            ownerUserId: state.ownerId,
            live: state,
            version: FIRST_VERSION,
            passwordHash,
          })
          .onConflictDoNothing({ target: room.code })
          .returning({ id: room.id });
        const row = rows[0];
        return row ? { id: row.id, code, version: FIRST_VERSION, state } : null;
      }),

    loadRoom: (code) =>
      guard("load room", async () => {
        const rows = await db
          .select({ id: room.id, code: room.code, version: room.version, state: room.live })
          .from(room)
          .where(eq(room.code, code));
        return rows[0] ?? null;
      }),

    loadRoomHeader: (code) =>
      guard("load room header", async () => {
        const rows = await db
          .select({ code: room.code, name: room.name, hasPassword: hasHash })
          .from(room)
          .where(eq(room.code, code));
        return rows[0] ?? null;
      }),

    commitRoom: (id, expectedVersion, next, ended, access) =>
      guard("commit room", async () => {
        const write = async (tx: Db) => {
          const rows = await tx
            .update(room)
            .set({
              live: next,
              ownerUserId: next.ownerId,
              version: sql`${room.version} + 1`,
              lastActiveAt: sql`now()`,
            })
            .where(and(eq(room.id, id), eq(room.version, expectedVersion)))
            .returning({ id: room.id });
          return rows.length === 1;
        };
        const history = isHistory(ended);
        if (!history && access === undefined) return write(db);
        // When the connection dies mid-transaction, drizzle's ROLLBACK fails too and its
        // error (no SQLSTATE) replaces the first one. Keep the first, for its code.
        let first: unknown;
        return db
          .transaction(async (tx) => {
            try {
              if (!(await write(tx))) return false;
              if (history) {
                const row = historyRow(id, ended);
                await tx
                  .insert(roundHistory)
                  .values(row)
                  .onConflictDoUpdate({
                    target: [roundHistory.roomId, roundHistory.number],
                    set: {
                      subject: row.subject,
                      deck: row.deck,
                      votes: row.votes,
                      stats: row.stats,
                      final: row.final,
                      startedAt: row.startedAt,
                      revealedAt: row.revealedAt,
                      finishedAt: row.finishedAt,
                    },
                  });
              }
              if (access !== undefined) await writeAccess(tx, id, access);
              return true;
            } catch (error) {
              first = error;
              throw error;
            }
          })
          .catch((error: unknown) => {
            throw first ?? error;
          });
      }),

    hasAccess: (roomId, who) =>
      guard("load access", async () => {
        const rows = await db
          .select({ userId: roomAccess.userId })
          .from(roomAccess)
          .where(and(eq(roomAccess.roomId, roomId), eq(roomAccess.userId, who)));
        return rows.length > 0;
      }),

    grantAccess: (roomId, who) =>
      guard("grant access", async () => {
        await writeAccess(db, roomId, { grant: [who] });
      }),

    loadPassword: (code, windowSeconds) =>
      guard("load password", async () => {
        const rows = await db
          .select({
            id: room.id,
            hash: room.passwordHash,
            ownerId: room.ownerUserId,
            failures: sql<number>`case when ${inWindow(windowSeconds)} then ${room.passwordFailures} else 0 end`,
            retryAfter: sql<number>`case when ${inWindow(windowSeconds)} then ceil(extract(epoch from ${room.passwordFailuresSince} + make_interval(secs => ${windowSeconds}) - now()))::int else 0 end`,
          })
          .from(room)
          .where(eq(room.code, code));
        const row = rows[0];
        return row
          ? { ...row, failures: Number(row.failures), retryAfter: Number(row.retryAfter) }
          : null;
      }),

    recordFailure: (roomId, windowSeconds) =>
      guard("record password failure", async () => {
        // Every SET expression reads the row as it was, so both see the same window.
        const rows = await db
          .update(room)
          .set({
            passwordFailures: sql`case when ${inWindow(windowSeconds)} then ${room.passwordFailures} + 1 else 1 end`,
            passwordFailuresSince: sql`case when ${inWindow(windowSeconds)} then ${room.passwordFailuresSince} else now() end`,
          })
          .where(eq(room.id, roomId))
          .returning({ failures: room.passwordFailures });
        return rows[0]?.failures ?? 0;
      }),
  };
}
