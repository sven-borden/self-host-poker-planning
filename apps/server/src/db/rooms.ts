/**
 * The room repository: the only code that reads or writes `room`, `round_history` and
 * `room_access`. Every write of `live` is a compare-and-set on `version`, so several
 * server instances stay correct without a lock; the command runner (runner.ts) retries a
 * lost one.
 */
import type { RoomState, UserId } from "@pp/domain";
import { and, desc, eq, inArray, lt, ne, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { guard } from "./errors.ts";
import { type EndedRound, historyRow, isHistory, type StoredHistoryRound } from "./history.ts";
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
  /**
   * The commit needs this user's grant (#31): a join by someone neither in the room nor
   * its PO, while it has a password. Checked in the commit's transaction, after the
   * compare-and-set took the room's row, so a kick or a new password that dropped the
   * grant has committed first; without the grant nothing is written (`password_required`).
   */
  requireGrant?: UserId;
  passwordHash?: string | null;
  revokeAll?: boolean;
  revoke?: readonly UserId[];
  grant?: readonly UserId[];
}

/** A room's password, for the access check: its id and hash (null: none). */
export interface StoredPassword {
  id: string;
  hash: string | null;
  /** The caller needs no password: the PO, a participant or a grant holder. */
  free: boolean;
  /** Seconds until the window of wrong tries ends (0 when none runs). */
  retryAfter: number;
}

/** A try reserved on the room's count (`reserveTry`): the window it was counted in. */
export interface ReservedTry {
  since: string;
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
   * transaction too; when it requires a grant the user lacks, nothing is written and it
   * resolves `password_required`.
   */
  commitRoom(
    id: string,
    expectedVersion: number,
    next: RoomState,
    ended?: EndedRound,
    access?: AccessWrite,
  ): Promise<boolean | "password_required">;
}

/** Grants and wrong tries (#31): what the access check reads and writes beside a commit. */
export interface AccessStore {
  /** Whether `user` holds a grant for the room (by id). */
  hasAccess(roomId: string, user: UserId): Promise<boolean>;
  /**
   * Grants `user` access to the room for a correct password, but only while the room
   * still holds `checked`, the hash the password was checked against: a change committed
   * meanwhile dropped every grant, and this one must not outlive it. The room's row is
   * read `for share`, so a change in progress is waited for. Resolves whether `user`
   * holds a grant under `checked` (a second grant changes nothing).
   */
  grantAccess(roomId: string, user: UserId, checked: string): Promise<boolean>;
  /** The room's hash, whether `user` needs none, and its window of wrong tries. */
  loadPassword(code: string, user: UserId, windowSeconds: number): Promise<StoredPassword | null>;
  /**
   * Reserves one try on the room's count before the check: a fixed window of
   * `windowSeconds` that starts with the first try after the last one ended, at most `max`
   * tries in it. Atomic, so every instance counts in the same row and tries at once are
   * counted exactly. Null when the window is full.
   */
  reserveTry(roomId: string, windowSeconds: number, max: number): Promise<ReservedTry | null>;
  /** Takes a reserved try back (the password was right), if its window still runs. */
  releaseTry(roomId: string, reserved: ReservedTry): Promise<void>;
}

/** One page of a room's history (#33), newest first. */
export interface HistoryPage {
  rounds: StoredHistoryRound[];
  /** Older rounds remain below the page's last one. */
  more: boolean;
}

/** What `loadHistory` reads: the rounds below `before`, at most `limit`, never `exclude`. */
export interface HistoryQuery {
  before?: number | undefined;
  limit: number;
  /** The round still on the table: it may already have a row, and is left out (#33). */
  exclude?: number | undefined;
}

/** The history panel's read side (#33). */
export interface HistoryStore {
  /** One page of the room's (by id) `round_history`, newest first. */
  loadHistory(roomId: string, query: HistoryQuery): Promise<HistoryPage>;
}

const hasHash = sql<boolean>`${room.passwordHash} is not null`;

/** Thrown inside a commit's transaction to roll it back: the grant it needs is gone. */
const NO_GRANT = Symbol("no grant");

export function createRoomStore(db: Db): RoomStore & AccessStore & HistoryStore {
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
              if (access?.requireGrant !== undefined) {
                const held = await tx
                  .select({ userId: roomAccess.userId })
                  .from(roomAccess)
                  .where(
                    and(eq(roomAccess.roomId, id), eq(roomAccess.userId, access.requireGrant)),
                  );
                if (held.length === 0) throw NO_GRANT;
              }
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
          .catch((error: unknown): "password_required" => {
            if ((first ?? error) === NO_GRANT) return "password_required";
            throw first ?? error;
          });
      }),

    loadHistory: (roomId, { before, limit, exclude }) =>
      guard("load history", async () => {
        // One more than the page, to tell whether older rounds remain. The unique index on
        // (room_id, number) serves both the filter and the order.
        const rows = await db
          .select({
            number: roundHistory.number,
            subject: roundHistory.subject,
            votes: roundHistory.votes,
            stats: roundHistory.stats,
            final: roundHistory.final,
            startedAt: roundHistory.startedAt,
            revealedAt: roundHistory.revealedAt,
            finishedAt: roundHistory.finishedAt,
          })
          .from(roundHistory)
          .where(
            and(
              eq(roundHistory.roomId, roomId),
              before === undefined ? undefined : lt(roundHistory.number, before),
              exclude === undefined ? undefined : ne(roundHistory.number, exclude),
            ),
          )
          .orderBy(desc(roundHistory.number))
          .limit(limit + 1);
        return { rounds: rows.slice(0, limit), more: rows.length > limit };
      }),

    hasAccess: (roomId, who) =>
      guard("load access", async () => {
        const rows = await db
          .select({ userId: roomAccess.userId })
          .from(roomAccess)
          .where(and(eq(roomAccess.roomId, roomId), eq(roomAccess.userId, who)));
        return rows.length > 0;
      }),

    grantAccess: (roomId, who, checked) =>
      guard("grant access", async () => {
        // One statement: the room's row is locked `for share` while its hash is compared,
        // so a change in progress commits first and the comparison sees its new hash.
        // Only users that exist: a guest purged since gets no row.
        const { rows } = await db.execute<{ granted: number }>(sql`
          with checked as (
            select ${room.id} as id from ${room}
            where ${room.id} = ${roomId}::uuid and ${room.passwordHash} = ${checked}
            for share
          ),
          added as (
            insert into ${roomAccess} (room_id, user_id)
            select checked.id, u.id from checked join "user" u on u.id = ${who}
            on conflict do nothing
            returning 1
          )
          select (select count(*) from added)::int
            + (select count(*) from ${roomAccess} a join checked on a.room_id = checked.id
               where a.user_id = ${who})::int as granted`);
        return Number(rows[0]?.granted ?? 0) > 0;
      }),

    loadPassword: (code, who, windowSeconds) =>
      guard("load password", async () => {
        const rows = await db
          .select({
            id: room.id,
            hash: room.passwordHash,
            free: sql<boolean>`(${room.ownerUserId} = ${who}
              or jsonb_exists(${room.live} -> 'participants', ${who})
              or exists (select 1 from ${roomAccess} a where a.room_id = ${room.id} and a.user_id = ${who}))`,
            retryAfter: sql<number>`case when ${inWindow(windowSeconds)} then ceil(extract(epoch from ${room.passwordFailuresSince} + make_interval(secs => ${windowSeconds}) - now()))::int else 0 end`,
          })
          .from(room)
          .where(eq(room.code, code));
        const row = rows[0];
        return row ? { ...row, free: row.free === true, retryAfter: Number(row.retryAfter) } : null;
      }),

    reserveTry: (roomId, windowSeconds, max) =>
      guard("reserve password try", async () => {
        // Every SET expression reads the row as it was, so both see the same window. A try
        // at once waits for this row and checks the count again on the new one.
        const rows = await db
          .update(room)
          .set({
            passwordFailures: sql`case when ${inWindow(windowSeconds)} then ${room.passwordFailures} + 1 else 1 end`,
            passwordFailuresSince: sql`case when ${inWindow(windowSeconds)} then ${room.passwordFailuresSince} else now() end`,
          })
          .where(
            and(
              eq(room.id, roomId),
              sql`(not ${inWindow(windowSeconds)} or ${room.passwordFailures} < ${max})`,
            ),
          )
          .returning({ since: sql<string>`${room.passwordFailuresSince}::text` });
        const since = rows[0]?.since;
        return since === undefined ? null : { since };
      }),

    releaseTry: (roomId, { since }) =>
      guard("release password try", async () => {
        // Only in the window it was counted in: a new window, or a new password, is left alone.
        await db
          .update(room)
          .set({ passwordFailures: sql`${room.passwordFailures} - 1` })
          .where(
            and(
              eq(room.id, roomId),
              sql`${room.passwordFailuresSince} = ${since}::timestamptz`,
              sql`${room.passwordFailures} > 0`,
            ),
          );
      }),
  };
}
