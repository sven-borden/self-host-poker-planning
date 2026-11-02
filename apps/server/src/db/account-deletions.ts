/**
 * The SQL of an account's deletion (#51, ADR-029); `account-deletion.ts` holds the order of it. A
 * room that lives on changes through its runner, never here: only a whole room goes here, by a
 * statement judged on the row's latest version.
 *
 * Rooms and named rounds are found as a guest's are (`guest-links.ts`), through their indexes, so
 * a deletion reads that person's rows however many the instance holds.
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import { session, user } from "./auth-schema.ts";
import { guard } from "./errors.ts";
import { type GuestRoom, namedRoundsOf, namesPerson } from "./guest-links.ts";
import type { Db } from "./rooms.ts";
import {
  accountDeletion,
  connectorToken,
  guestLink,
  ROOM_KEEPER,
  type RoomChoice,
  room,
} from "./schema.ts";

/** Named rounds rewritten in one statement: no statement holds many row locks for long. */
export const ROUNDS_BATCH = 200;

export type RoomChoices = Readonly<Record<string, RoomChoice>>;

export interface AccountDeletionStore {
  /**
   * Writes that `account` is going, ends its sessions and deletes its connectors' tokens, in one
   * transaction: from here nobody acts as this person, nothing needs the tokens, and the deletion
   * can always be run again. The first request's choices stand. A guest gets no row, and keeps its
   * sessions.
   */
  begin(account: string, choices: RoomChoices): Promise<void>;
  /** What the person chose and since when, or null when no deletion is pending. */
  markerOf(account: string): Promise<{ choices: RoomChoices; since: Date } | null>;
  /** Every account still going. */
  pending(): Promise<string[]>;
  /** Ends any session that came up since: a sign-in that read no marker just before `begin`. */
  endSessions(account: string): Promise<void>;
  /** Guests still on their way to this account (#48): they are this person, and go with it. */
  guestsOf(account: string): Promise<string[]>;
  /** The rooms that name `who`. */
  roomsOf(who: string): Promise<GuestRoom[]>;
  /** Deletes the room if `who` keeps it, whoever else is in it. Resolves whether it did. */
  deleteKept(id: string, who: string): Promise<boolean>;
  /**
   * Deletes the room if `who` keeps it and nobody else has a seat, judged on the row's latest
   * version: a join that commits first keeps the room, and any commit after finds no room.
   */
  deleteAlone(id: string, who: string): Promise<boolean>;
  /** Takes `who` out of every named round, in batches. Running it again changes nothing. */
  anonymiseRounds(who: string): Promise<void>;
  /**
   * The end, in one transaction, the `user` row last: rows of a sign-in in progress that name the
   * person, the guests still on their way, and the person, whose cascade takes the marker and every
   * row keyed to the id. It locks the person first, and in a statement of its own, then looks
   * again: if a room or a round names them after all, it changes nothing and resolves false.
   * With the row gone already it resolves true.
   */
  finish(account: string): Promise<boolean>;
}

/**
 * A named round without `who`: the entry keeps its card and nothing else, and with any earlier
 * entry of the kind it moves behind the names, by card, so that neither a place in the list nor
 * the order of two deletions says whose it was. The other entries keep their order.
 */
function anonymise(who: string, limit: number) {
  return sql`
    with doomed as (
      select h.id from round_history h
      where h.votes @> ${namedRoundsOf(who)}::jsonb
      limit ${limit}
      for update
    )
    update round_history h set votes = jsonb_set(h.votes, '{votes}', (
      select jsonb_agg(
        case when e.gone then jsonb_build_object('who', null, 'name', null, 'card', e.value -> 'card')
          else e.value end
        order by e.gone, case when e.gone then e.value ->> 'card' end collate "C", e.ordinality)
      from (
        select v.value, v.ordinality, coalesce(v.value ->> 'who', ${who}) = ${who} as gone
        from jsonb_array_elements(h.votes -> 'votes') with ordinality v
      ) e))
    from doomed d where h.id = d.id`;
}

export function createAccountDeletionStore(db: Db): AccountDeletionStore {
  return {
    begin: (account, choices) =>
      guard("begin account deletion", () =>
        db.transaction(async (tx) => {
          await tx.execute(sql`
            insert into ${accountDeletion} (user_id, choices)
            select u.id, ${JSON.stringify(choices)}::jsonb from "user" u
            where u.id = ${account} and u.is_anonymous is not true
            on conflict (user_id) do nothing`);
          await tx.execute(sql`
            delete from ${session} s
            where s.user_id = ${account} and exists (
              select 1 from ${accountDeletion} d where d.user_id = s.user_id)`);
          await tx.execute(sql`
            delete from ${connectorToken} c
            where c.user_id = ${account} and exists (
              select 1 from ${accountDeletion} d where d.user_id = c.user_id)`);
        }),
      ),

    markerOf: (account) =>
      guard("read account deletion", async () => {
        const rows = await db
          .select({ choices: accountDeletion.choices, since: accountDeletion.createdAt })
          .from(accountDeletion)
          .where(eq(accountDeletion.userId, account));
        return rows[0] ?? null;
      }),

    pending: () =>
      guard("read account deletions", async () => {
        const rows = await db.select({ id: accountDeletion.userId }).from(accountDeletion);
        return rows.map((row) => row.id);
      }),

    endSessions: (account) =>
      guard("end sessions", async () => {
        await db.delete(session).where(eq(session.userId, account));
      }),

    guestsOf: (account) =>
      guard("read guest links", async () => {
        const rows = await db
          .select({ guest: guestLink.guestUserId })
          .from(guestLink)
          .where(eq(guestLink.accountUserId, account));
        return rows.map((row) => row.guest);
      }),

    roomsOf: (who) =>
      guard("find rooms", () =>
        db.select({ id: room.id, code: room.code }).from(room).where(namesPerson(who)),
      ),

    deleteKept: (id, who) =>
      guard("delete kept room", async () => {
        const rows = await db
          .delete(room)
          .where(and(eq(room.id, id), sql`${ROOM_KEEPER} = ${who}`))
          .returning({ id: room.id });
        return rows.length === 1;
      }),

    deleteAlone: (id, who) =>
      guard("delete room", async () => {
        const rows = await db
          .delete(room)
          .where(
            and(
              eq(room.id, id),
              sql`${ROOM_KEEPER} = ${who}`,
              sql`(${room.live} -> 'participants') - ${who}::text = '{}'::jsonb`,
            ),
          )
          .returning({ id: room.id });
        return rows.length === 1;
      }),

    anonymiseRounds: (who) =>
      guard("anonymise rounds", async () => {
        for (;;) {
          const { rowCount } = await db.execute(anonymise(who, ROUNDS_BATCH));
          if ((rowCount ?? 0) < ROUNDS_BATCH) return;
        }
      }),

    finish: (account) =>
      guard("finish account deletion", () =>
        db.transaction(async (tx) => {
          const lock = (ids: readonly string[]) =>
            tx.execute<{ id: string; email: string }>(sql`
              select id, email from "user"
              where id in (${sql.join(
                ids.map((id) => sql`${id}`),
                sql`, `,
              )})
              for update`);
          // A statement of its own: a lock taken inside a read does not make it read again, and
          // what follows must see any commit that held this lock: a seat (`requireAccount`), or a
          // guest's link, which takes this row too, and which the cascade would otherwise cut.
          const { rows: found } = await lock([account]);
          const guests = await tx
            .select({ id: guestLink.guestUserId })
            .from(guestLink)
            .where(eq(guestLink.accountUserId, account));
          const others = guests.map(({ id }) => id);
          if (others.length > 0) found.push(...(await lock(others)).rows);
          const people = [account, ...others];
          for (const who of people) {
            // No `limit`: it would pull the plan off the indexes, on reads that usually find nothing.
            const named = await tx.execute(sql`select id from room where ${namesPerson(who)}`);
            const rounds = await tx.execute(sql`
              select h.id from round_history h where h.votes @> ${namedRoundsOf(who)}::jsonb`);
            if (named.rows.length > 0 || rounds.rows.length > 0) return false;
          }
          // Few rows, gone within ten minutes or at the next purge: a scan reads a small table.
          for (const { id, email } of found) {
            await tx.execute(sql`
              delete from verification
              where strpos(value, ${id}) > 0 or strpos(identifier, ${id}) > 0
                or strpos(value, ${email}) > 0 or strpos(identifier, ${email}) > 0`);
          }
          if (others.length > 0) {
            await tx.delete(user).where(and(inArray(user.id, others), eq(user.isAnonymous, true)));
          }
          await tx.delete(user).where(eq(user.id, account));
          return true;
        }),
      ),
  };
}
