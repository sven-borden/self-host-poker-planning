/**
 * What the account page and the export read (#51, ADR-029): one person's rows, through the indexes
 * a guest's move reads (`guest-links.ts`). Nothing here writes. `room.code` is read by neither: a
 * code is a bearer capability, and neither answer holds one.
 *
 * A room with a rule (#50, ADR-028) tells someone it refuses no more here than at its door, as "My
 * rooms" does: no seated name, no room's name, nothing but that a right or a card was there. Who
 * may take a room goes by the one test, `mayHoldRole`, at one read per person. A room with no rule
 * reads nothing more.
 */
import { type HeirReason, heirsOf, type Restriction } from "@pp/domain";
import { eq, sql } from "drizzle-orm";
import { mayHoldRole, type RoleCandidate, type RoomRules, ruledRoom } from "../room-rule.ts";
import { account, user } from "./auth-schema.ts";
import { guard } from "./errors.ts";
import { namedRoundsOf, namesPerson } from "./guest-links.ts";
import type { Db } from "./rooms.ts";
import { ROOM_KEEPER, ROOM_RULE, room, roomAccess, roundHistory } from "./schema.ts";

/** Someone in a room the person keeps: a choice of who takes it. */
export interface RoomSeat {
  id: string;
  name: string;
}

/** Why a room's first seat is the default, or that a rule allows nobody seated. */
export type DefaultReason = Exclude<HeirReason, "chosen"> | "nobody";

/** A room the person keeps, with other people in it: who may take it, the default first. */
export interface SharedRoom {
  id: string;
  name: string | null;
  lastActiveAt: Date;
  /** Only people who may take it: empty when a room's rule allows none of those seated. */
  seats: RoomSeat[];
  /** Why the first seat is the default, or `nobody`: the page says it. */
  why: DefaultReason;
}

/** What a deletion would do, for the page to say. */
export interface AccountOverview {
  /** Rooms the person keeps with nobody else in them: they go. */
  alone: number;
  /** Rooms someone else keeps where the person holds a seat or the PO role: those go. */
  seats: number;
  /** Rooms the person keeps that their rule refuses them: a number, and nothing about them. */
  held: number;
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

/** A room whose rule refuses the person: that it names them, and nothing about it. */
export interface WithheldRoom {
  id: string;
  withheld: true;
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
  /** The Google Workspace domain the token named, if any. */
  hostedDomain?: string;
}

export interface AccountDataStore {
  overview(who: string): Promise<AccountOverview>;
  profile(who: string): Promise<{ profile: ExportProfile; signIns: ExportSignIn[] } | null>;
  rooms(who: string): Promise<(ExportRoom | WithheldRoom)[]>;
  grants(who: string): Promise<ExportGrant[]>;
  votes(who: string): Promise<ExportVote[]>;
}

interface Seat {
  name: string;
  role: string;
  joinedAt: number;
  connected: boolean;
}

/** What a row brings for a room's rule. */
interface Ruled {
  ownerId: string;
  rule: Restriction | null;
}

export function createAccountDataStore(
  db: Db,
  rules: Pick<RoomRules, "providers" | "candidateOf">,
): AccountDataStore {
  /** One read per person, however many rooms ask, and none while no room has a rule. */
  function readerFor() {
    const read = new Map<string, Promise<RoleCandidate>>();
    const candidate = (who: string) => {
      const known = read.get(who);
      if (known) return known;
      const reading = rules.candidateOf(who);
      read.set(who, reading);
      return reading;
    };
    /** Whether this person may hold this room's role, by the one test. */
    return async (room: Ruled, who: string) =>
      room.rule === null ||
      who === room.ownerId ||
      mayHoldRole(ruledRoom(room), who, await candidate(who), rules.providers, Date.now());
  }

  /** The person's rooms, with who sits in them. */
  const roomsNaming = (who: string) =>
    db
      .select({
        id: room.id,
        name: room.name,
        ownerId: room.ownerUserId,
        rule: sql<Restriction | null>`${ROOM_RULE}`,
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
        const overview: AccountOverview = { alone: 0, seats: 0, held: 0, shared: [] };
        const may = readerFor();
        for (const row of await roomsNaming(who)) {
          const seated = Object.hasOwn(row.people, who);
          if (!row.keeper) {
            if (seated || row.productOwner) overview.seats += 1;
            continue;
          }
          if (!(await may(row, who))) {
            overview.held += 1;
            continue;
          }
          const others = Object.keys(row.people).filter((id) => id !== who);
          if (others.length === 0) {
            overview.alone += 1;
            continue;
          }
          const allowed = await Promise.all(others.map((id) => may(row, id)));
          const mayTake = row.rule === null ? undefined : others.filter((_, i) => allowed[i]);
          const participants = row.people;
          const heirs = heirsOf({ ownerId: row.ownerId, participants }, who, { mayTake });
          const { id, name, lastActiveAt } = row;
          overview.shared.push({
            id,
            name,
            lastActiveAt,
            seats: heirs.map((heir) => ({ id: heir.id, name: participants[heir.id]?.name ?? "" })),
            why: (heirs[0]?.why ?? "nobody") as DefaultReason,
          });
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
            ...(row.hostedDomain !== null && { hostedDomain: row.hostedDomain }),
          })),
        };
      }),

    rooms: (who) =>
      guard("read account rooms", async () => {
        const may = readerFor();
        const shown: (ExportRoom | WithheldRoom)[] = [];
        for (const row of await roomsNaming(who)) {
          if (!(await may(row, who))) {
            shown.push({ id: row.id, withheld: true });
            continue;
          }
          const { id, name, productOwner, keeper, people, cardOnTable, lastActiveAt } = row;
          const seat = Object.hasOwn(people, who) ? people[who] : undefined;
          shown.push({
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
          });
        }
        return shown;
      }),

    grants: (who) =>
      guard("read account grants", async () => {
        const rows = await db
          .select({
            id: room.id,
            name: room.name,
            since: roomAccess.grantedAt,
            ownerId: room.ownerUserId,
            rule: sql<Restriction | null>`${ROOM_RULE}`,
          })
          .from(roomAccess)
          .innerJoin(room, eq(room.id, roomAccess.roomId))
          .where(eq(roomAccess.userId, who))
          .orderBy(roomAccess.grantedAt);
        const may = readerFor();
        const grants: ExportGrant[] = [];
        for (const row of rows) {
          const name = (await may(row, who)) ? row.name : null;
          grants.push({ room: { id: row.id, name }, since: row.since.toISOString() });
        }
        return grants;
      }),

    votes: (who) =>
      guard("read account votes", async () => {
        const rows = await db
          .select({
            roomId: roundHistory.roomId,
            roomName: room.name,
            ownerId: room.ownerUserId,
            rule: sql<Restriction | null>`${ROOM_RULE}`,
            round: roundHistory.number,
            subject: roundHistory.subject,
            votes: roundHistory.votes,
            revealedAt: roundHistory.revealedAt,
          })
          .from(roundHistory)
          .innerJoin(room, eq(room.id, roundHistory.roomId))
          .where(sql`${roundHistory.votes} @> ${namedRoundsOf(who)}::jsonb`)
          .orderBy(roundHistory.revealedAt);
        const may = readerFor();
        const cards: ExportVote[] = [];
        for (const row of rows) {
          if (row.votes.kind !== "named") continue;
          const shown = await may(row, who);
          for (const { who: voter, card, name, changedAfterReveal } of row.votes.votes) {
            if (voter !== who) continue;
            cards.push({
              room: { id: row.roomId, name: shown ? row.roomName : null },
              round: row.round,
              subject: shown ? row.subject : null,
              card,
              name,
              ...(changedAfterReveal && { changedAfterReveal }),
              revealedAt: row.revealedAt.toISOString(),
            });
          }
        }
        return cards;
      }),
  };
}
