/**
 * The room repository: the only code that reads or writes `room` and `round_history`.
 * Every write of `live` is a compare-and-set on `version`, so several server instances
 * stay correct without a lock; the command runner (runner.ts) retries a lost one.
 */
import type { RoomState } from "@pp/domain";
import { and, eq, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { guard } from "./errors.ts";
import { type EndedRound, historyRow, isHistory } from "./history.ts";
import { room, roundHistory } from "./schema.ts";

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
}

/** The version a new room starts at. */
export const FIRST_VERSION = 1;

export interface RoomStore {
  /** Creates a room at `FIRST_VERSION`. Resolves `null` when the code is taken: draw another. */
  insertRoom(room: NewRoom): Promise<StoredRoom | null>;
  loadRoom(code: string): Promise<StoredRoom | null>;
  /** The room's code and name, without loading `live`. */
  loadRoomHeader(code: string): Promise<RoomHeader | null>;
  /**
   * Writes `next` when the room is still at `expectedVersion`, bumps the version and
   * `last_active_at`, and copies `next.ownerId` to `owner_user_id`. Resolves false when
   * another write came first (nothing is written). When `ended` holds a revealed round,
   * its history row is written in the same transaction; writing the same round again
   * updates that row, so a retry never duplicates it.
   */
  commitRoom(
    id: string,
    expectedVersion: number,
    next: RoomState,
    ended?: EndedRound,
  ): Promise<boolean>;
}

export function createRoomStore(db: Db): RoomStore {
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
          .select({ code: room.code, name: room.name })
          .from(room)
          .where(eq(room.code, code));
        return rows[0] ?? null;
      }),

    commitRoom: (id, expectedVersion, next, ended) =>
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
        if (!isHistory(ended)) return write(db);
        const row = historyRow(id, ended);
        // When the connection dies mid-transaction, drizzle's ROLLBACK fails too and its
        // error (no SQLSTATE) replaces the first one. Keep the first, for its code.
        let first: unknown;
        return db
          .transaction(async (tx) => {
            try {
              if (!(await write(tx))) return false;
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
  };
}
