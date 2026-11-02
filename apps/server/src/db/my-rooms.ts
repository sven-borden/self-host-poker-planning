/**
 * The SQL of "My rooms" (#49, ADR-027). A person's rooms are read the way a guest's are found
 * (`guest-links.ts`): `owner_user_id` has its btree index, everyone `live` names has the GIN
 * index on `ROOM_PEOPLE`, and a keeper who is not the PO has `room_keeper_apart_idx`. So one
 * person's list reads index entries and that person's rooms, however many rooms the instance
 * holds, as the filter runs alone in a materialized CTE: left to itself, the planner takes the
 * `limit` as a reason to walk `room_last_active_at_idx` backward through everybody's rooms, which
 * cost 150 ms on 118,000 rooms. The sort is then of that person's rooms, each page: a list costs
 * in proportion to the rooms a person has (9 ms at 5,000), never to the instance's.
 *
 * `ROOM_PEOPLE` also names a departed voter's kept card, so a row the index finds must still hold
 * a seat. A PO by claim who gave up the seat is off the list too: nothing there to leave.
 *
 * A row's rounds are `live.round.number`, a number the row already holds: no room's history is
 * read for a list. It counts rounds started, the one on the table included.
 */
import { and, eq, type SQL, sql } from "drizzle-orm";
import { guard } from "./errors.ts";
import type { Db } from "./rooms.ts";
import { IS_KEEPER_APART, KEEPER_APART, ROOM_KEEPER, ROOM_PEOPLE, room } from "./schema.ts";

/** One row of a person's list. Nothing here says who else is in the room. */
export interface MyRoom {
  id: string;
  code: string;
  name: string | null;
  /** The person holds the PO role. */
  owned: boolean;
  /** The person holds the right to delete the room, which takes the PO role too. */
  keeper: boolean;
  /** The person holds a seat. */
  seated: boolean;
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

/** A room found by its id, and what the asking person is to it. */
export interface FoundRoom {
  id: string;
  code: string;
  ownerId: string;
  keeper: boolean;
  seated: boolean;
}

export interface MyRoomsStore {
  /** The rooms `user` owns or holds a seat in now, last active first. */
  list(user: string, limit: number, after?: MyRoomsCursor): Promise<MyRoomsPage>;
  /** The room with this id, or null. */
  find(id: string, user: string): Promise<FoundRoom | null>;
  /**
   * Deletes the room if `user` is its PO and its keeper now, judged by the statement on the row's
   * latest version: a claim or hand-over that commits first refuses this, and a commit after this
   * finds no room. Its history and grants go by their cascades, in the statement; the queue is a
   * column of the row. Resolves whether it deleted one.
   */
  deleteOwned(id: string, user: string): Promise<boolean>;
}

/** What a row of the list reads. */
interface ListRow {
  id: string;
  code: string;
  name: string | null;
  owned: boolean;
  keeper: boolean;
  seated: boolean;
  rounds: number;
  micros: string;
  [column: string]: unknown;
}

/** The list's one statement, exported for the test that reads its plan. */
export function myRoomsQuery(user: string, limit: number, after?: MyRoomsCursor): SQL {
  const seated = sql`${room.live} -> 'participants' ? ${user}`;
  const keeper = sql`${ROOM_KEEPER} = ${user}`;
  // A timestamp in microseconds, exact in both directions: a JavaScript Date keeps
  // milliseconds, and a cursor rounded to those would repeat a row or skip one.
  const micros = sql`(extract(epoch from ${room.lastActiveAt}) * 1000000)::bigint::text`;
  // Only `live` says, and nothing but `apply` writes it: still, one odd row must not fail a list.
  const rounds = sql`case when ${room.live} #>> '{round,number}' ~ '^[0-9]{1,9}$'
    then (${room.live} #>> '{round,number}')::int else 0 end`;
  const past = after
    ? sql`and (${room.lastActiveAt}, ${room.id}) < (timestamptz 'epoch' + ${after.micros}::bigint * interval '1 microsecond', ${after.id}::uuid)`
    : sql``;
  return sql`
    with mine as materialized (
      select ${room.id} as id, ${room.code} as code, ${room.name} as name,
        ${room.ownerUserId} = ${user} as owned, ${keeper} as keeper,
        coalesce(${seated}, false) as seated, ${rounds} as rounds,
        ${room.lastActiveAt} as last_active_at, ${micros} as micros
      from ${room}
      where ((${room.ownerUserId} = ${user} and ${keeper})
        or (${ROOM_PEOPLE} ? ${user} and ${seated})
        or (${KEEPER_APART} = ${user} and ${IS_KEEPER_APART}))
        ${past}
    )
    select id, code, name, owned, keeper, seated, rounds, micros from mine
    order by last_active_at desc, id desc
    limit ${limit + 1}`;
}

export function createMyRoomsStore(db: Db): MyRoomsStore {
  return {
    list: (user, limit, after) =>
      guard("list my rooms", async () => {
        const { rows } = await db.execute<ListRow>(myRoomsQuery(user, limit, after));
        const page = rows.slice(0, limit);
        const last = page.at(-1);
        return {
          rooms: page.map(({ id, code, name, owned, keeper, seated, rounds, micros }) => ({
            id,
            code,
            name,
            owned,
            keeper,
            seated,
            rounds,
            lastActiveAt: new Date(Number(micros) / 1000),
          })),
          ...(rows.length > limit && last && { next: { micros: last.micros, id: last.id } }),
        };
      }),

    find: (id, user) =>
      guard("find room", async () => {
        const rows = await db
          .select({
            id: room.id,
            code: room.code,
            ownerId: room.ownerUserId,
            keeper: sql<boolean>`${ROOM_KEEPER} = ${user}`,
            seated: sql<boolean>`coalesce(${room.live} -> 'participants' ? ${user}, false)`,
          })
          .from(room)
          .where(eq(room.id, id));
        return rows[0] ?? null;
      }),

    deleteOwned: (id, user) =>
      guard("delete room", async () => {
        const rows = await db
          .delete(room)
          .where(and(eq(room.id, id), eq(room.ownerUserId, user), sql`${ROOM_KEEPER} = ${user}`))
          .returning({ id: room.id });
        return rows.length === 1;
      }),
  };
}
