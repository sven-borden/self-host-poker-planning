/**
 * The SQL of "My rooms" (#49, ADR-027). A person's rooms are read the way a guest's are found
 * (`guest-links.ts`): `owner_user_id` has its btree index, and everyone `live` names has the GIN
 * index on `ROOM_PEOPLE`, so one person's list reads index entries and that person's rooms,
 * however many rooms the instance holds. `ROOM_PEOPLE` also names a departed voter's kept card,
 * so a row the index finds must still hold a seat.
 *
 * A row's rounds are `live.round.number`, a number the row already holds: no room's history is
 * read for a list. It counts rounds started, the one on the table included.
 */
import { and, desc, eq, sql } from "drizzle-orm";
import { guard } from "./errors.ts";
import type { Db } from "./rooms.ts";
import { ROOM_PEOPLE, room } from "./schema.ts";

/** One row of a person's list. Nothing here says who else is in the room. */
export interface MyRoom {
  id: string;
  code: string;
  name: string | null;
  owned: boolean;
  rounds: number;
  lastActiveAt: Date;
}

/** Where a page ended: the last row's `last_active_at`, in microseconds, and id. */
export interface MyRoomsCursor {
  micros: string;
  id: string;
}

export interface MyRoomsPage {
  rooms: MyRoom[];
  /** Set when more rows follow the page's last one. */
  next?: MyRoomsCursor;
}

/** A room found by its id. */
export interface RoomOwner {
  id: string;
  code: string;
  ownerId: string;
}

export interface MyRoomsStore {
  /** The rooms `user` owns or holds a seat in now, last active first. */
  list(user: string, limit: number, after?: MyRoomsCursor): Promise<MyRoomsPage>;
  /** The room with this id, or null. */
  find(id: string): Promise<RoomOwner | null>;
  /**
   * Deletes the room if `user` owns it now, judged by the statement on the row's latest version:
   * a hand-over that commits first refuses this, and a commit after this finds no room. Its
   * history and grants go by their cascades, in the statement; the queue is a column of the row.
   * Resolves whether it deleted one.
   */
  deleteOwned(id: string, user: string): Promise<boolean>;
}

export function createMyRoomsStore(db: Db): MyRoomsStore {
  return {
    list: (user, limit, after) =>
      guard("list my rooms", async () => {
        // A timestamp in microseconds, exact in both directions: a JavaScript Date keeps
        // milliseconds, and a cursor rounded to those would repeat a row or skip one.
        const micros = sql<string>`(extract(epoch from ${room.lastActiveAt}) * 1000000)::bigint::text`;
        const mine = sql`(${room.ownerUserId} = ${user}
          or (${ROOM_PEOPLE} ? ${user} and ${room.live} -> 'participants' ? ${user}))`;
        const past = after
          ? sql`(${room.lastActiveAt}, ${room.id}) < (timestamptz 'epoch' + ${after.micros}::bigint * interval '1 microsecond', ${after.id}::uuid)`
          : undefined;
        const rows = await db
          .select({
            id: room.id,
            code: room.code,
            name: room.name,
            owned: sql<boolean>`${room.ownerUserId} = ${user}`,
            rounds: sql<number>`coalesce((${room.live} #>> '{round,number}')::int, 0)`,
            lastActiveAt: room.lastActiveAt,
            micros,
          })
          .from(room)
          .where(and(mine, past))
          .orderBy(desc(room.lastActiveAt), desc(room.id))
          .limit(limit + 1);
        const page = rows.slice(0, limit);
        const last = page.at(-1);
        return {
          rooms: page.map(({ micros: _, ...row }) => row),
          ...(rows.length > limit && last && { next: { micros: last.micros, id: last.id } }),
        };
      }),

    find: (id) =>
      guard("find room", async () => {
        const rows = await db
          .select({ id: room.id, code: room.code, ownerId: room.ownerUserId })
          .from(room)
          .where(eq(room.id, id));
        return rows[0] ?? null;
      }),

    deleteOwned: (id, user) =>
      guard("delete room", async () => {
        const rows = await db
          .delete(room)
          .where(and(eq(room.id, id), eq(room.ownerUserId, user)))
          .returning({ id: room.id });
        return rows.length === 1;
      }),
  };
}
