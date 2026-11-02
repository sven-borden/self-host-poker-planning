/**
 * What the server sends: the snapshot (the room as one viewer may see it), its causes,
 * and the acknowledgements. The server's tests parse every frame with these schemas. The
 * web app checks messages by shape only (`realtime/room-connection.ts`): zod would cost
 * the room route about 27 kB gzipped, and its only peer is the server of the same build.
 */
import { WHO_CAN_REVEAL } from "@pp/domain";
import { z } from "zod";
import {
  cardSchema,
  deckSpecSchema,
  roleSchema,
  specialCardSchema,
  userIdSchema,
  WIRE_LIMITS,
} from "./commands.ts";
import { ACK_ERROR_CODES } from "./errors.ts";

export const ackErrorCodeSchema = z.enum(ACK_ERROR_CODES);

/**
 * A room's rule as a viewer may read it (#50): the domains are shown to anyone let in, a
 * tenant's id to the PO alone, whose panel edits it. Everyone else reads `organisation`.
 */
export const restrictionViewSchema = z.object({
  domains: z.array(z.string()),
  organisation: z.boolean(),
  tenants: z.array(z.string()).optional(),
});

/** What a refused `enter` may say (#50): what would pass, never who passes. */
export const requirementSchema = z.object({
  domains: z.array(z.string()),
  organisation: z.boolean(),
});

export const roomSettingsSchema = z.object({
  deck: deckSpecSchema,
  specials: z.array(specialCardSchema),
  whoCanReveal: z.enum(WHO_CAN_REVEAL),
  revealNames: z.boolean(),
  revealWhenAllVoted: z.boolean(),
  timer: z.object({ seconds: z.number().nullable(), revealAtEnd: z.boolean() }),
  allowChangeAfterReveal: z.boolean(),
  poVotes: z.boolean(),
  observersCount: z.boolean(),
  /**
   * The room has a password (#31): everyone sees whether, never more. Optional, so adding
   * it kept protocol version 4; the server always sends it.
   */
  hasPassword: z.boolean().optional(),
  /** The next item starts by itself after a recorded final (#52). */
  autoAdvance: z.boolean(),
  /** Only some accounts may enter (#50). Left out for a room anyone may enter. */
  restriction: restrictionViewSchema.optional(),
});

export const subjectSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("none") }),
  z.object({ kind: z.literal("title"), text: z.string() }),
  z.object({
    kind: z.literal("link"),
    url: z.string(),
    key: z.string().optional(),
    /** The title of the queue item the round came from (#52). */
    title: z.string().optional(),
  }),
]);

/** One person at the table. Nothing private: no session, no vote, no timestamps of presence. */
export const participantViewSchema = z.object({
  id: userIdSchema,
  name: z.string(),
  role: roleSchema,
  avatar: z.string().optional(),
  connected: z.boolean(),
  /** The presence grace period has passed since the person's last socket closed. */
  away: z.boolean(),
  isOwner: z.boolean(),
});

/** The domain's `Results` (`computeResults`). */
export const resultsSchema = z.object({
  distribution: z.array(z.object({ card: cardSchema, count: z.number().int() })),
  core: z.array(cardSchema),
  mode: cardSchema.nullable(),
  agreement: z.number(),
  spread: z.tuple([cardSchema, cardSchema]).nullable(),
  consensus: z.boolean(),
  average: z.number().nullable(),
  median: z.number().nullable(),
  suggested: cardSchema.nullable(),
});

const roundFields = {
  number: z.number().int(),
  subject: subjectSchema,
  startedAt: z.number(),
  /** How many times a deck change restarted the round (#26); absent for none. */
  restarts: z.number().int().optional(),
  deadlineAt: z.number().optional(),
  /** When the running timer started (#27); the ring drains over `deadlineAt - timerStartedAt`. */
  timerStartedAt: z.number().optional(),
  /** A deadline that passed without a reveal (#27): "Time is up" until the reveal. */
  timeUpAt: z.number().optional(),
  deck: deckSpecSchema,
  specials: z.array(specialCardSchema),
  /** Who has a card on the table, in participant order (never in voting order). */
  voted: z.array(userIdSchema),
  /** The viewer's own card; nobody else's card is ever here. */
  yourVote: cardSchema.optional(),
};

const revealedFields = {
  ...roundFields,
  phase: z.literal("revealed"),
  revealedAt: z.number(),
  final: cardSchema.optional(),
  /** When the next queue item starts by itself (#52); the page shows the seconds left. */
  advanceAt: z.number().optional(),
  results: resultsSchema,
};

/** Voting: who voted, never what (except the viewer's own card). */
export const votingRoundViewSchema = z.object({
  ...roundFields,
  phase: z.literal("voting"),
  anonymous: z.boolean(),
});

/**
 * Revealed with names: every vote with its voter, in participant order, then the votes of
 * people who left after the reveal, by id, each with the `name` they had (#19).
 */
export const namedRoundViewSchema = z.object({
  ...revealedFields,
  anonymous: z.literal(false),
  votes: z.array(
    z.object({
      who: userIdSchema,
      card: cardSchema,
      changedAfterReveal: z.boolean(),
      /** Only for a voter who is no longer in the room. */
      name: z.string().optional(),
    }),
  ),
});

/** Revealed anonymously: the cards in deck order and who voted, with no link between them. */
export const anonymousRoundViewSchema = z.object({
  ...revealedFields,
  anonymous: z.literal(true),
  cards: z.array(cardSchema),
});

export const roundViewSchema = z.union([
  votingRoundViewSchema,
  namedRoundViewSchema,
  anonymousRoundViewSchema,
]);

/** The domain's `Cause`, field by field. Only `finalSet` carries a card (a public one). */
export const causeSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("joined"), who: userIdSchema }),
  z.object({ type: z.literal("left"), who: userIdSchema }),
  z.object({ type: z.literal("kicked"), who: userIdSchema }),
  z.object({ type: z.literal("renamed"), who: userIdSchema }),
  z.object({ type: z.literal("avatarChanged"), who: userIdSchema }),
  z.object({ type: z.literal("roleChanged"), who: userIdSchema, role: roleSchema }),
  z.object({
    type: z.literal("roundStarted"),
    number: z.number().int(),
    restarted: z.literal(true).optional(),
    /** A re-vote (#32): the same subject again. Optional, so an older client ignores it. */
    revote: z.literal(true).optional(),
  }),
  z.object({ type: z.literal("voteCast"), who: userIdSchema.optional() }),
  z.object({ type: z.literal("voteRetracted"), who: userIdSchema.optional() }),
  z.object({
    type: z.literal("revealed"),
    by: z.enum(["manual", "everyoneVoted", "timer"]),
    /** Who revealed by hand (#28). Optional, so an older client ignores it. */
    who: userIdSchema.optional(),
  }),
  z.object({ type: z.literal("timerStarted") }),
  z.object({ type: z.literal("timerStopped") }),
  z.object({ type: z.literal("timerExtended") }),
  z.object({ type: z.literal("timeUp") }),
  z.object({ type: z.literal("finalSet"), card: cardSchema }),
  z.object({
    type: z.literal("settingsUpdated"),
    /** The PO set, changed or removed the password (#31). Optional: protocol 4 still. */
    password: z.enum(["set", "changed", "removed"]).optional(),
    /** The room's rule changed (#50): that it did, never what it says. */
    restriction: z.literal(true).optional(),
  }),
  z.object({
    type: z.literal("ownerChanged"),
    by: z.enum(["transfer", "claim"]),
    to: userIdSchema,
  }),
  z.object({ type: z.literal("away"), who: userIdSchema }),
  z.object({ type: z.literal("back"), who: userIdSchema }),
  z.object({ type: z.literal("queueChanged"), added: z.number().int().optional() }),
  z.object({ type: z.literal("advanceArmed") }),
  z.object({ type: z.literal("advanceHeld") }),
]);

/**
 * What the room's snapshot says of its queue (#52, ADR-024): how many items wait and the
 * next one, by its id and the one thing that names it, never the list. A snapshot goes to
 * every socket on every vote: the list comes by a `queue` request, for the PO alone.
 * `rev` tells that page when to ask again. Left out while the queue is empty.
 */
export const queueSummarySchema = z.object({
  count: z.number().int(),
  rev: z.number().int(),
  next: z.object({
    id: z.number().int(),
    key: z.string().optional(),
    title: z.string().optional(),
    url: z.string().optional(),
  }),
});

export const roomViewSchema = z.object({
  code: z.string().min(1).max(WIRE_LIMITS.roomCode),
  ownerId: userIdSchema,
  /**
   * From when (epoch ms, the server's clock) anyone else may claim the PO role (#30): set
   * only while the PO is away (`awaySince` + 120 s) or not in the room (0). Optional, so
   * adding it kept protocol version 4.
   */
  ownerClaimableAt: z.number().optional(),
  settings: roomSettingsSchema,
  /** Sorted by `joinedAt`, then by id. */
  participants: z.array(participantViewSchema),
  /** The viewer's id once they joined, `null` before. */
  you: userIdSchema.nullable(),
  /** `null` in the lobby, before the first round. */
  round: roundViewSchema.nullable(),
  queue: queueSummarySchema.optional(),
});

export const snapshotSchema = z.object({
  protocol: z.number().int(),
  /** The room's version; a client drops a snapshot older than the one it holds. */
  version: z.number().int(),
  /** The server's clock when it built the snapshot, for the countdown's clock offset. */
  serverNow: z.number(),
  room: roomViewSchema,
  /** The causes of the change this snapshot follows, in order, projected for this viewer. */
  causes: z.array(causeSchema),
});

export type RoomSettingsView = z.output<typeof roomSettingsSchema>;
export type RestrictionView = z.output<typeof restrictionViewSchema>;
export type SubjectView = z.output<typeof subjectSchema>;
export type ParticipantView = z.output<typeof participantViewSchema>;
export type ResultsView = z.output<typeof resultsSchema>;
export type VotingRoundView = z.output<typeof votingRoundViewSchema>;
export type NamedRoundView = z.output<typeof namedRoundViewSchema>;
export type AnonymousRoundView = z.output<typeof anonymousRoundViewSchema>;
export type RoundView = z.output<typeof roundViewSchema>;
export type CauseView = z.output<typeof causeSchema>;
export type RoomView = z.output<typeof roomViewSchema>;
export type QueueSummary = z.output<typeof queueSummarySchema>;
export type Snapshot = z.output<typeof snapshotSchema>;

/**
 * `enter`: subscribe this socket to a room's snapshots. Strict like every inbound object;
 * `parseEnter` checks `protocol` first, so a newer client still hears `protocol_mismatch`.
 */
export const enterPayloadSchema = z.strictObject({
  code: z.string().min(1).max(WIRE_LIMITS.roomCode),
  protocol: z.number().int(),
});
export type EnterPayload = z.output<typeof enterPayloadSchema>;

export const enterAckSchema = z.union([
  z.object({ ok: z.literal(true), snapshot: snapshotSchema }),
  z.object({
    ok: z.literal(false),
    code: ackErrorCodeSchema,
    /** With the three codes of a room's rule (#50): what the join screen asks for. */
    requirement: requirementSchema.optional(),
  }),
]);
export type EnterAck = z.output<typeof enterAckSchema>;

export const cmdAckSchema = z.union([
  z.object({ ok: z.literal(true), version: z.number().int() }),
  z.object({ ok: z.literal(false), code: ackErrorCodeSchema }),
]);
export type CmdAck = z.output<typeof cmdAckSchema>;
