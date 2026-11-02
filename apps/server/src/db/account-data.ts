/**
 * What the account page and the export read (#51, ADR-029): one person's rows, through the indexes
 * a guest's move reads (`guest-links.ts`). Nothing here writes. `room.code` is read by neither: a
 * code is a bearer capability, and neither answer holds one.
 */
import { type HeirReason, heirsOf } from "@pp/domain";
import { eq, sql } from "drizzle-orm";
import { account, user } from "./auth-schema.ts";
import { guard } from "./errors.ts";
import { namedRoundsOf, namesPerson } from "./guest-links.ts";
import type { Db } from "./rooms.ts";
import { ROOM_KEEPER, room, roomAccess, roundHistory } from "./schema.ts";

/** Someone in a room the person keeps: a choice of who takes it. */
export interface RoomSeat {
  id: string;
  name: string;
}

/** A room the person keeps, with other people in it: `heirsOf`'s order, the default first. */
export interface SharedRoom {
  id: string;
  name: string | null;
  lastActiveAt: Date;
  seats: RoomSeat[];
  /** Why the first seat is the default: the page says it. */
  why: HeirReason;
}

/** What a deletion would do, for the page to say. */
export interface AccountOverview {
  /** Rooms the person keeps with nobody else in them: they go. */
  alone: number;
  /** Rooms someone else keeps where the person holds a seat or the PO role: those go. */
  seats: number;
  shared: SharedRoom[];
}

/** One room in the export. */
export interface ExportRoom {
  id: string;
  name: string | null;
  productOwner: boolean;
  keeper: boolean;
  /** The person's own seat, as it stands now. */
  seat: { name: string; role: string; joinedAt: string } | null;
  /**
   * Whether a card of the person's lies on the table now. Not the card: the round may be anonymous,
   * and no file maps a person to a value there. A named round's card comes with `votes` once it ends.
   */
  cardOnTable: boolean;
  lastActiveAt: string;
}

/** A room a correct password let the person into. */
export interface ExportGrant {
  room: { id: string; name: string | null };
  since: string;
}

/** One of the person's own cards in a named round. */
export interface ExportVote {
  room: { id: string; name: string | null };
  round: number;
  subject: unknown;
  card: string;
  /** The name the person went by in that round. */
  name: string | null;
  changedAfterReveal?: true;
  revealedAt: string;
}

export interface ExportProfile {
  name: string;
  /** The address the person signs in with; a Microsoft account stores none (ADR-025). */
  email: string | null;
  avatar: string | null;
  createdAt: string;
}

export interface ExportSignIn {
  provider: string;
  since: string;
  /** What a Microsoft token claimed: the person's to see, and proof of nothing. */
  claimedEmail?: string;
}

export interface AccountDataStore {
  overview(who: string): Promise<AccountOverview>;
  profile(who: string): Promise<{ profile: ExportProfile; signIns: ExportSignIn[] } | null>;
  rooms(who: string): Promise<ExportRoom[]>;
  grants(who: string): Promise<ExportGrant[]>;
  votes(who: string): Promise<ExportVote[]>;
}

interface Seat {
  name: string;
  role: string;
  joinedAt: number;
  connected: boolean;
}

export function createAccountDataStore(db: Db): AccountDataStore {
  /** The person's rooms, with who sits in them. */
  const roomsNaming = (who: string) =>
    db
      .select({
        id: room.id,
        name: room.name,
        ownerId: room.ownerUserId,
        productOwner: sql<boolean>`${room.ownerUserId} = ${who}`,
        keeper: sql<boolean>`${ROOM_KEEPER} = ${who}`,
        people: sql<Record<string, Seat>>`${room.live} -> 'participants'`,
        cardOnTable: sql<boolean>`coalesce((${room.live} #> '{round,votes}') ? ${who}, false)`,
        lastActiveAt: room.lastActiveAt,
      })
      .from(room)
      .where(namesPerson(who));

  return {
    overview: (who) =>
      guard("read account overview", async () => {
        const overview: AccountOverview = { alone: 0, seats: 0, shared: [] };
        for (const row of await roomsNaming(who)) {
          const seated = Object.hasOwn(row.people, who);
          if (!row.keeper) {
            if (seated || row.productOwner) overview.seats += 1;
            continue;
          }
          const heirs = heirsOf({ ownerId: row.ownerId, participants: row.people }, who);
          const [first] = heirs;
          if (first === undefined) overview.alone += 1;
          else {
            const { id, name, lastActiveAt } = row;
            const seats = heirs.map((heir) => ({
              id: heir.id,
              name: row.people[heir.id]?.name ?? "",
            }));
            overview.shared.push({ id, name, lastActiveAt, seats, why: first.why });
          }
        }
        overview.shared.sort((a, b) => b.lastActiveAt.getTime() - a.lastActiveAt.getTime());
        return overview;
      }),

    profile: (who) =>
      guard("read account profile", async () => {
        const [person] = await db.select().from(user).where(eq(user.id, who));
        if (!person) return null;
        const rows = await db.select().from(account).where(eq(account.userId, who));
        const claimed = rows.find((row) => row.claimedEmail !== null)?.claimedEmail ?? null;
        const stored = rows.some((row) => row.providerId === "microsoft") ? null : person.email;
        return {
          profile: {
            name: person.name,
            email: stored ?? claimed,
            avatar: person.avatar,
            createdAt: person.createdAt.toISOString(),
          },
          signIns: rows.map((row) => ({
            provider: row.providerId,
            since: row.createdAt.toISOString(),
            ...(row.claimedEmail !== null && { claimedEmail: row.claimedEmail }),
          })),
        };
      }),

    rooms: (who) =>
      guard("read account rooms", async () => {
        const rows = await roomsNaming(who);
        return rows.map(({ id, name, productOwner, keeper, people, cardOnTable, lastActiveAt }) => {
          const seat = Object.hasOwn(people, who) ? people[who] : undefined;
          return {
            id,
            name,
            productOwner,
            keeper,
            seat: seat
              ? {
                  name: seat.name,
                  role: seat.role,
                  joinedAt: new Date(seat.joinedAt).toISOString(),
                }
              : null,
            cardOnTable,
            lastActiveAt: lastActiveAt.toISOString(),
          };
        });
      }),

    grants: (who) =>
      guard("read account grants", async () => {
        const rows = await db
          .select({ id: room.id, name: room.name, since: roomAccess.grantedAt })
          .from(roomAccess)
          .innerJoin(room, eq(room.id, roomAccess.roomId))
          .where(eq(roomAccess.userId, who))
          .orderBy(roomAccess.grantedAt);
        return rows.map(({ id, name, since }) => ({
          room: { id, name },
          since: since.toISOString(),
        }));
      }),

    votes: (who) =>
      guard("read account votes", async () => {
        const rows = await db
          .select({
            roomId: roundHistory.roomId,
            roomName: room.name,
            round: roundHistory.number,
            subject: roundHistory.subject,
            votes: roundHistory.votes,
            revealedAt: roundHistory.revealedAt,
          })
          .from(roundHistory)
          .innerJoin(room, eq(room.id, roundHistory.roomId))
          .where(sql`${roundHistory.votes} @> ${namedRoundsOf(who)}::jsonb`)
          .orderBy(roundHistory.revealedAt);
        return rows.flatMap(({ roomId, roomName, round, subject, votes, revealedAt }) =>
          votes.kind !== "named"
            ? []
            : votes.votes
                .filter((vote) => vote.who === who)
                .map(({ card, name, changedAfterReveal }) => ({
                  room: { id: roomId, name: roomName },
                  round,
                  subject,
                  card,
                  name,
                  ...(changedAfterReveal && { changedAfterReveal }),
                  revealedAt: revealedAt.toISOString(),
                })),
        );
      }),
  };
}
