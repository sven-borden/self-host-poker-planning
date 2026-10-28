/**
 * The tables (architecture, section 6). drizzle-kit reads this file to generate the SQL
 * migrations under `apps/server/drizzle/` (`pnpm --filter @pp/server db:generate`); the
 * server applies them at start (`database.ts`). Migrations are additive: a new column is
 * nullable or has a default, nothing is renamed or dropped while an older instance may
 * still run.
 */
import type { Card, DeckSpec, Results, RoomState, SpecialCard, Subject, UserId } from "@pp/domain";
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
 * One row per room. `live` is the room's whole state (settings, people, the round) and
 * the single source of truth for it; every change goes through `apply` and a
 * compare-and-set on `version`. `name`, `password_hash` and the timestamps live beside
 * it because no command changes them through `apply`, and the hash must never reach a
 * snapshot. `owner_user_id` copies `live.ownerId` on every commit, for queries such as
 * "my rooms" (W5).
 */
export const room = pgTable(
  "room",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    code: text("code").notNull().unique(),
    name: text("name"),
    ownerUserId: text("owner_user_id").notNull(),
    live: jsonb("live").$type<RoomState>().notNull(),
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
  // The retention purge (ROOM_TTL_DAYS) deletes by `last_active_at`.
  (t) => [index("room_last_active_at_idx").on(t.lastActiveAt)],
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
  (t) => [primaryKey({ columns: [t.roomId, t.userId] })],
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
  (t) => [unique("round_history_room_id_number_unique").on(t.roomId, t.number)],
);
