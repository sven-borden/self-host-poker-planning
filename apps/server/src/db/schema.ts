/**
 * The tables (architecture, section 6). drizzle-kit reads this file to generate the SQL
 * migrations under `apps/server/drizzle/` (`pnpm --filter @pp/server db:generate`); the
 * server applies them at start (`database.ts`). Migrations are additive: a new column is
 * nullable or has a default, nothing is renamed or dropped while an older instance may
 * still run.
 */
import type {
  Card,
  DeckSpec,
  Queue,
  Results,
  RoomState,
  SpecialCard,
  Subject,
  UserId,
} from "@pp/domain";
import { sql } from "drizzle-orm";
import {
  bigint,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { user } from "./auth-schema.ts";

const instant = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

/**
 * Everyone a room's `live` names: its seats and the votes of the round on the table, whose
 * keys are user ids, as one JSON object. `(…) ? id` finds a person's rooms through
 * `room_people_idx`, and only this exact expression can use that index.
 */
export const ROOM_PEOPLE = sql`((live -> 'participants') || coalesce(live #> '{round,votes}', '{}'::jsonb))`;

/**
 * One row per room. `live` is the room's whole state (settings, people, the round) and
 * the single source of truth for it; every change goes through `apply` and a
 * compare-and-set on `version`. `name`, `password_hash` and the timestamps live beside
 * it because no command changes them through `apply`, and the hash must never reach a
 * snapshot. `owner_user_id` copies `live.ownerId` on every commit, for queries such as
 * "my rooms" (W5). `queue` is the one part of the state outside `live` (#52, ADR-024): a
 * full queue is hundreds of kB at worst, and a commit that leaves it alone does not write
 * it, so a vote stays the small write it always was.
 */
export const room = pgTable(
  "room",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    code: text("code").notNull().unique(),
    name: text("name"),
    ownerUserId: text("owner_user_id").notNull(),
    live: jsonb("live").$type<Omit<RoomState, "queue">>().notNull(),
    queue: jsonb("queue").$type<Queue>(),
    version: integer("version").notNull(),
    passwordHash: text("password_hash"),
    /**
     * Wrong passwords tried on this room in the window that started at
     * `password_failures_since` (#31): the per-room limit, shared by every instance.
     */
    passwordFailures: integer("password_failures").notNull().default(0),
    passwordFailuresSince: instant("password_failures_since"),
    createdAt: instant("created_at").notNull().defaultNow(),
    lastActiveAt: instant("last_active_at").notNull().defaultNow(),
  },
  // The retention purge (ROOM_TTL_DAYS) deletes by `last_active_at`, and keeps a room
  // whose owner is signed in; "my rooms" (W5) reads by owner too.
  (t) => [
    index("room_last_active_at_idx").on(t.lastActiveAt),
    index("room_owner_user_id_idx").on(t.ownerUserId),
    // A guest who signs in (#48) and "my rooms" (W5) find a person's seats through this.
    index("room_people_idx").using("gin", ROOM_PEOPLE),
  ],
);

/**
 * Who may enter a room that has a password without typing it (#31): one row per room and
 * user, written by a correct password, and for everyone in the room (and its PO) when the
 * PO sets or changes it. Changing it drops every row first, removing it drops them all,
 * and a kick drops the removed person's. Keyed by the session's user, so a guest's access
 * holds on that device (its session cookie), and an account's (W5) everywhere.
 */
export const roomAccess = pgTable(
  "room_access",
  {
    roomId: uuid("room_id")
      .notNull()
      .references(() => room.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    grantedAt: instant("granted_at").notNull().defaultNow(),
  },
  // Deleting a user (a purged guest) finds its grants by `user_id`.
  (t) => [
    primaryKey({ columns: [t.roomId, t.userId] }),
    index("room_access_user_id_idx").on(t.userId),
  ],
);

/** The deck a round was played with: its spec and the special cards it allowed. */
export type HistoryDeck = { spec: DeckSpec; specials: SpecialCard[] };

/** One vote of a named round. `name` is null when the voter had left the room. */
export type NamedHistoryVote = {
  who: UserId;
  name: string | null;
  card: Card;
  changedAfterReveal?: true;
};

/**
 * The votes of a round. An anonymous round keeps the cards alone, in display order (the
 * order of `stats.distribution`), never in an order that follows the people.
 */
export type HistoryVotes =
  | { kind: "named"; votes: NamedHistoryVote[] }
  | { kind: "anonymous"; cards: Card[] };

/**
 * One row per revealed round that ended (started over, replaced by the next round).
 * `(room_id, number)` is unique: writing the same round again updates its row.
 */
export const roundHistory = pgTable(
  "round_history",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    roomId: uuid("room_id")
      .notNull()
      .references(() => room.id, { onDelete: "cascade" }),
    number: integer("number").notNull(),
    subject: jsonb("subject").$type<Subject>().notNull(),
    deck: jsonb("deck").$type<HistoryDeck>().notNull(),
    votes: jsonb("votes").$type<HistoryVotes>().notNull(),
    stats: jsonb("stats").$type<Results>().notNull(),
    final: text("final"),
    startedAt: instant("started_at").notNull(),
    revealedAt: instant("revealed_at").notNull(),
    finishedAt: instant("finished_at").notNull(),
  },
  (t) => [
    unique("round_history_room_id_number_unique").on(t.roomId, t.number),
    // A person's named rounds, by containment: a guest who signs in (#48), account deletion (#51).
    index("round_history_votes_idx").using("gin", t.votes.op("jsonb_path_ops")),
  ],
);

/**
 * A guest who signed in, and the account everything they hold is moving to (#48, ADR-025). The
 * row is written before anything moves, in one transaction with the end of the guest's sessions,
 * and goes with the guest once all of it has moved. While it exists the move can always be run
 * again, and the purge leaves the guest and the guest's rooms alone. Nothing else ever links a
 * guest to an account, and this row never leaves the server.
 */
export const guestLink = pgTable(
  "guest_link",
  {
    guestUserId: text("guest_user_id")
      .primaryKey()
      .references(() => user.id, { onDelete: "cascade" }),
    accountUserId: text("account_user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    createdAt: instant("created_at").notNull().defaultNow(),
  },
  (t) => [index("guest_link_account_user_id_idx").on(t.accountUserId)],
);

/**
 * The token of one account at one connector (#53, ADR-026). `sealed_token` is `vault.ts`'s
 * text, bound to this `user_id` and `connector`, and the row holds nothing else about the
 * token. It goes with the account by cascade (#51, and the purge, though a guest holds none:
 * `connector-tokens.ts` refuses one). The primary key also serves that cascade.
 */
export const connectorToken = pgTable(
  "connector_token",
  {
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    connector: text("connector").notNull(),
    sealedToken: text("sealed_token").notNull(),
    createdAt: instant("created_at").notNull().defaultNow(),
    updatedAt: instant("updated_at").notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.connector] })],
);
