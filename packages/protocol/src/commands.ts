/**
 * Commands on the wire: `{ id, type, payload }`, one zod schema per domain command.
 *
 * zod only rejects garbage early: it checks the shape and caps every string and array
 * well above the domain's own limits. The domain (`apply`) stays the judge of the exact
 * rules (grapheme counts, deck rules, ranges), so its specific error codes reach the user.
 * Every object is strict: an unknown or misspelt field answers `bad_payload`, so a typo in
 * a settings patch never half-applies.
 */
import {
  type ClientCommand,
  type ClientCommandType,
  PRESET_DECK_IDS,
  ROLES,
  SPECIAL_CARDS,
  WHO_CAN_REVEAL,
} from "@pp/domain";
import { z } from "zod";

/** Coarse caps, in UTF-16 code units or items. Each sits well above the domain's limit. */
export const WIRE_LIMITS = {
  /** The client's correlation id. */
  commandId: 64,
  /** A user id (Better Auth ids are about 32 characters). */
  userId: 128,
  /** The domain caps a name at 512 code units (32 characters). */
  name: 1024,
  /** The domain caps a title at 3200 code units (200 characters) and a link at 2000. */
  subject: 4096,
  /** A queue item's key: 32 characters, a dash and 10 digits in the domain. */
  itemKey: 64,
  /** The domain caps a queue at 500 items, so a batch holds no more. */
  queueBatch: 500,
  /** An avatar id: the domain knows the 24 of them, each a short word. */
  avatar: 32,
  /** The domain caps a card label at 64 code units (4 characters). */
  card: 128,
  /** The domain caps a custom deck at 20 cards. */
  deckCards: 64,
  /** There are 3 special cards. */
  specials: 8,
  /** The room code (10 characters of base58). */
  roomCode: 64,
  /** A round number or a restart count: Postgres's `integer`, where history keeps them. */
  roundNumber: 2_147_483_647,
  /** The domain takes a timer of 5 to 3600 seconds. */
  timerSeconds: 86_400,
  /** The domain takes 20 entries in each list of a room's rule (#50). */
  restrictionEntries: 64,
  /** The domain takes a domain of 253 characters or a tenant's id; a raw IDN name runs longer. */
  restrictionEntry: 1024,
} as const;

export const userIdSchema = z.string().min(1).max(WIRE_LIMITS.userId);
export const cardSchema = z.string().max(WIRE_LIMITS.card);
export const roleSchema = z.enum(ROLES);
export const specialCardSchema = z.enum(SPECIAL_CARDS);

/** A deck as the server sends it (lenient, like every outbound schema). */
export const deckSpecSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("preset"), id: z.enum(PRESET_DECK_IDS) }),
  z.object({ kind: z.literal("custom"), cards: z.array(cardSchema).max(WIRE_LIMITS.deckCards) }),
]);

/** A deck as a client sends it. */
const wireDeckSpecSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("preset"), id: z.enum(PRESET_DECK_IDS) }),
  z.strictObject({
    kind: z.literal("custom"),
    cards: z.array(cardSchema).max(WIRE_LIMITS.deckCards),
  }),
]);

const nameSchema = z.string().max(WIRE_LIMITS.name);
const avatarSchema = z.string().max(WIRE_LIMITS.avatar);
const textSchema = z.string().max(WIRE_LIMITS.subject);

/**
 * A subject as a client sends it: a link never carries `key` (the server detects it), so
 * a client must not echo a snapshot's subject back as it is.
 */
const wireSubjectSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("none") }),
  z.strictObject({ kind: z.literal("title"), text: textSchema }),
  z.strictObject({ kind: z.literal("link"), url: textSchema }),
]);

/** What a room's rule lists, as a client sends it; the domain judges each entry. */
const ruleListSchema = z
  .array(z.string().max(WIRE_LIMITS.restrictionEntry))
  .max(WIRE_LIMITS.restrictionEntries);

/** Any subset of the settings, `timer` one level deep (the domain's `SettingsPatch`). */
export const settingsPatchSchema = z.strictObject({
  deck: wireDeckSpecSchema.optional(),
  specials: z.array(specialCardSchema).max(WIRE_LIMITS.specials).optional(),
  whoCanReveal: z.enum(WHO_CAN_REVEAL).optional(),
  revealNames: z.boolean().optional(),
  revealWhenAllVoted: z.boolean().optional(),
  timer: z
    .strictObject({
      seconds: z.number().min(0).max(WIRE_LIMITS.timerSeconds).nullable().optional(),
      revealAtEnd: z.boolean().optional(),
    })
    .optional(),
  allowChangeAfterReveal: z.boolean().optional(),
  poVotes: z.boolean().optional(),
  observersCount: z.boolean().optional(),
  autoAdvance: z.boolean().optional(),
  /** The room's rule (#50), whole, or null to remove it. */
  restriction: z
    .strictObject({ domains: ruleListSchema, tenants: ruleListSchema })
    .nullable()
    .optional(),
});

/** A round's number, as the snapshot gave it (rounds count from 1). */
const roundNumberSchema = z.number().int().min(1).max(WIRE_LIMITS.roundNumber);

/** The round on the table when the PO pressed "Next round" (#52), 0 in the lobby. */
const pressedForSchema = z.number().int().min(0).max(WIRE_LIMITS.roundNumber);

/** How many times the round had restarted when the press was made (#26), 0 for none. */
const restartSchema = z.number().int().min(0).max(WIRE_LIMITS.roundNumber);

/** A queue item's number, as the room gave it. */
const itemIdSchema = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);

/**
 * A queue item as a client sends it: no `id`, which the room gives, and no `source`, which
 * only a connector on the server will set.
 */
const wireQueueItemSchema = z.strictObject({
  key: z.string().max(WIRE_LIMITS.itemKey).optional(),
  title: textSchema.optional(),
  url: textSchema.optional(),
});

/** A timer's length or extension; the domain checks integer and range (`bad_seconds`). */
const secondsSchema = z.number().min(0).max(WIRE_LIMITS.timerSeconds);

/** A command without fields may omit `payload`. */
const empty = z.strictObject({}).default({});

/**
 * The payload of every command a client may send: the domain command without `type`.
 * The `satisfies` keeps this map complete and each payload assignable to its domain
 * command. The server's own commands (`presence`) have no schema, so they never parse.
 */
const payloads = {
  join: z.strictObject({ name: nameSchema, role: roleSchema, avatar: avatarSchema.optional() }),
  leave: empty,
  rename: z.strictObject({ name: nameSchema }),
  setAvatar: z.strictObject({ avatar: avatarSchema.nullable() }),
  setRole: z.strictObject({ role: roleSchema }),
  kick: z.strictObject({ who: userIdSchema }),
  startRound: z.strictObject({ subject: wireSubjectSchema, round: pressedForSchema }),
  queueAdd: z.strictObject({
    items: z.array(wireQueueItemSchema).min(1).max(WIRE_LIMITS.queueBatch),
  }),
  queueMove: z.strictObject({
    id: itemIdSchema,
    to: z.number().int().min(0).max(WIRE_LIMITS.queueBatch),
  }),
  queueRemove: z.strictObject({ id: itemIdSchema }),
  queueClear: empty,
  startNext: z.strictObject({ id: itemIdSchema }),
  holdAdvance: empty,
  // The round the press was made for, its number and restarts: one still in flight when
  // the next round starts, or when a deck change restarts this one, is refused
  // (`round_changed`) instead of landing in it. `restart` is optional, so a client from
  // before #26 keeps its room through the deploy: without it any restart goes, as for a
  // command the server built. The web app always sends it.
  castVote: z.strictObject({
    card: cardSchema,
    round: roundNumberSchema,
    restart: restartSchema.optional(),
  }),
  retractVote: z.strictObject({ round: roundNumberSchema, restart: restartSchema.optional() }),
  reveal: empty,
  setFinal: z.strictObject({ card: cardSchema }),
  revote: empty,
  // zod's number refuses NaN and the infinities; the domain checks integer and range.
  startTimer: z.strictObject({ seconds: secondsSchema }),
  stopTimer: empty,
  extendTimer: z.strictObject({ seconds: secondsSchema }),
  timeUp: empty,
  updateSettings: z.strictObject({ patch: settingsPatchSchema }),
  transferOwner: z.strictObject({ to: userIdSchema }),
  claimOwner: empty,
} satisfies {
  [K in ClientCommandType]: z.ZodType<Omit<Extract<ClientCommand, { type: K }>, "type">>;
};

/** Every command type a client may send, in the domain's order. */
export const COMMAND_TYPES = Object.keys(payloads) as ClientCommandType[];

/** The client's correlation id: plain ASCII, so it is safe to log and to echo. */
export const COMMAND_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const commandIdSchema = z.string().regex(COMMAND_ID_PATTERN);

function wire<T extends ClientCommandType, P extends (typeof payloads)[T]>(type: T, payload: P) {
  return z.strictObject({ id: commandIdSchema, type: z.literal(type), payload });
}

export const wireCommandSchema = z.discriminatedUnion("type", [
  wire("join", payloads.join),
  wire("leave", payloads.leave),
  wire("rename", payloads.rename),
  wire("setAvatar", payloads.setAvatar),
  wire("setRole", payloads.setRole),
  wire("kick", payloads.kick),
  wire("startRound", payloads.startRound),
  wire("queueAdd", payloads.queueAdd),
  wire("queueMove", payloads.queueMove),
  wire("queueRemove", payloads.queueRemove),
  wire("queueClear", payloads.queueClear),
  wire("startNext", payloads.startNext),
  wire("holdAdvance", payloads.holdAdvance),
  wire("castVote", payloads.castVote),
  wire("retractVote", payloads.retractVote),
  wire("reveal", payloads.reveal),
  wire("setFinal", payloads.setFinal),
  wire("revote", payloads.revote),
  wire("startTimer", payloads.startTimer),
  wire("stopTimer", payloads.stopTimer),
  wire("extendTimer", payloads.extendTimer),
  wire("timeUp", payloads.timeUp),
  wire("updateSettings", payloads.updateSettings),
  wire("transferOwner", payloads.transferOwner),
  wire("claimOwner", payloads.claimOwner),
]);

/** What a client sends (`payload` may be left out on commands without fields). */
export type WireCommandInput = z.input<typeof wireCommandSchema>;
/** A parsed wire command. */
export type WireCommand = z.output<typeof wireCommandSchema>;

export type ParsedCommand =
  | { ok: true; id: string; command: ClientCommand }
  | { ok: false; code: "bad_payload" };

/**
 * Parses what a socket sent with `cmd` and returns the flat domain command, or
 * `bad_payload` for anything that is not a well-formed command. Never throws.
 */
export function toDomainCommand(input: unknown): ParsedCommand {
  const parsed = wireCommandSchema.safeParse(input);
  if (!parsed.success) return { ok: false, code: "bad_payload" };
  const { id, type, payload } = parsed.data;
  // Safe: `payloads` is checked against the domain's `Command` above, member by member.
  return { ok: true, id, command: { ...payload, type } as ClientCommand };
}
