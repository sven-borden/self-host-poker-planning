/**
 * The SQL of a guest's way to an account (#48, ADR-025); `guest-link.ts` holds the order of it.
 * A room's own state moves through the room's runner, never here.
 *
 * A person's rooms: `owner_user_id` has its btree index, and everyone `live` names (seats and
 * the votes on the table) has a GIN index on the expression `ROOM_PEOPLE`. A person's named
 * rounds: `votes` has a GIN index for containment. So a sign-in reads index entries, however
 * many rooms the instance holds, and an instance's rounds and rooms are never scanned.
 */
import { and, eq, exists, sql } from "drizzle-orm";
import { session, user } from "./auth-schema.ts";
import { guard } from "./errors.ts";
import type { Db } from "./rooms.ts";
import { guestLink, ROOM_PEOPLE, room, roomAccess, roundHistory } from "./schema.ts";

export interface GuestLinkStore {
  /**
   * Writes that `guest` is moving to `account`, and ends the guest's sessions, in one
   * transaction: from here the guest cannot act any more, and the move can always be run again.
   * A guest already on its way keeps the account it had. A row that is no guest gets no link,
   * and keeps its sessions.
   */
  begin(guest: string, account: string): Promise<void>;
  /** Where a guest is moving and since when, or null when no move is pending. */
  linkOf(guest: string): Promise<{ account: string; since: Date } | null>;
  /** The guests still moving to this account. One read by index. */
  guestsOf(account: string): Promise<string[]>;
  /** Every guest still moving. */
  pending(): Promise<string[]>;
  /** The rooms that name `guest`: as owner, in a seat, or by a vote on the table. */
  roomsOf(guest: string): Promise<GuestRoom[]>;
  /**
   * Everything left outside the rooms, and the end of the guest, in one transaction, after every
   * room moved: the remaining grants, the named rounds, an avatar or a name the account lacks,
   * then the guest's row, which takes the link and the old grants with it. Running it again
   * changes nothing. A new password in progress commits first, as for `grantAccess`, so a grant
   * it dropped is not copied.
   */
  complete(guest: string, account: string): Promise<void>;
}

/** A room by its id, for log lines and channels, and by its code, for its runner. */
export interface GuestRoom {
  id: string;
  code: string;
}

export function createGuestLinkStore(db: Db): GuestLinkStore {
  return {
    begin: (guest, account) =>
      guard("begin guest link", () =>
        db.transaction(async (tx) => {
          await tx.execute(sql`
            insert into ${guestLink} (guest_user_id, account_user_id)
            select u.id, ${account} from "user" u where u.id = ${guest} and u.is_anonymous = true
            on conflict (guest_user_id) do nothing`);
          const isGuest = tx
            .select({ id: user.id })
            .from(user)
            .where(and(eq(user.id, guest), eq(user.isAnonymous, true)));
          await tx.delete(session).where(and(eq(session.userId, guest), exists(isGuest)));
        }),
      ),

    linkOf: (guest) =>
      guard("read guest link", async () => {
        const rows = await db
          .select({ account: guestLink.accountUserId, since: guestLink.createdAt })
          .from(guestLink)
          .where(eq(guestLink.guestUserId, guest));
        return rows[0] ?? null;
      }),

    guestsOf: (account) =>
      guard("read guest links", async () => {
        const rows = await db
          .select({ guest: guestLink.guestUserId })
          .from(guestLink)
          .where(eq(guestLink.accountUserId, account));
        return rows.map((row) => row.guest);
      }),

    pending: () =>
      guard("read guest links", async () => {
        const rows = await db.select({ guest: guestLink.guestUserId }).from(guestLink);
        return rows.map((row) => row.guest);
      }),

    roomsOf: (guest) =>
      guard("find guest rooms", () =>
        db
          .select({ id: room.id, code: room.code })
          .from(room)
          .where(sql`${room.ownerUserId} = ${guest} or ${ROOM_PEOPLE} ? ${guest}`),
      ),

    complete: (guest, account) =>
      guard("complete guest link", () =>
        db.transaction(async (tx) => {
          // A statement of its own: a lock taken inside the insert would wait for a new password
          // and then copy the grant it dropped, as a joined row is not read again. The insert
          // below reads the grants after that change has committed.
          await tx.execute(sql`
            select r.id from ${room} r
            where r.id in (select a.room_id from ${roomAccess} a where a.user_id = ${guest})
            for share`);
          await tx.execute(sql`
            insert into ${roomAccess} (room_id, user_id, granted_at)
            select a.room_id, ${account}, a.granted_at from ${roomAccess} a
            where a.user_id = ${guest}
            on conflict do nothing`);
          // Only a named round says who; an anonymous round's cards have nobody to move, and the
          // containment below cannot match one. A round both of them played keeps both entries:
          // it is a record, and the stats beside it were counted from both.
          const named = JSON.stringify({ kind: "named", votes: [{ who: guest }] });
          await tx.execute(sql`
            update ${roundHistory} h set votes = jsonb_set(h.votes, '{votes}', (
              select jsonb_agg(
                case when v.value ->> 'who' = ${guest}
                  then jsonb_set(v.value, '{who}', to_jsonb(${account}::text))
                  else v.value end
                order by v.ordinality)
              from jsonb_array_elements(h.votes -> 'votes') with ordinality v))
            where h.votes @> ${named}::jsonb`);
          await tx.execute(sql`
            update "user" a set
              avatar = coalesce(a.avatar, g.avatar),
              name = case when a.name = '' then g.name else a.name end
            from "user" g where a.id = ${account} and g.id = ${guest}`);
          await tx.delete(user).where(and(eq(user.id, guest), eq(user.isAnonymous, true)));
        }),
      ),
  };
}
