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
  /** The domain caps a card label at 64 code units (4 characters). */
  card: 128,
  /** The domain caps a custom deck at 20 cards. */
  deckCards: 64,
  /** There are 3 special cards. */
  specials: 8,
  /** The room code (10 characters of base58). */
  roomCode: 64,
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

/** Any subset of the settings, `timer` one level deep (the domain's `SettingsPatch`). */
export const settingsPatchSchema = z.strictObject({
  deck: wireDeckSpecSchema.optional(),
  specials: z.array(specialCardSchema).max(WIRE_LIMITS.specials).optional(),
  whoCanReveal: z.enum(WHO_CAN_REVEAL).optional(),
  revealNames: z.boolean().optional(),
  revealWhenAllVoted: z.boolean().optional(),
  timer: z
    .strictObject({
      seconds: z.number().nullable().optional(),
      revealAtEnd: z.boolean().optional(),
    })
    .optional(),
  allowChangeAfterReveal: z.boolean().optional(),
  poVotes: z.boolean().optional(),
  observersCount: z.boolean().optional(),
});

/** A round's number, as the snapshot gave it (rounds count from 1). */
const roundNumberSchema = z.number().int().min(1);

/** How many times the round had restarted when the press was made (#26), 0 for none. */
const restartSchema = z.number().int().min(0);

/** A command without fields may omit `payload`. */
const empty = z.strictObject({}).default({});

/**
 * The payload of every command a client may send: the domain command without `type`.
 * The `satisfies` keeps this map complete and each payload assignable to its domain
 * command. The server's own commands (`presence`) have no schema, so they never parse.
 */
const payloads = {
  join: z.strictObject({ name: nameSchema, role: roleSchema }),
  leave: empty,
  rename: z.strictObject({ name: nameSchema }),
  setRole: z.strictObject({ role: roleSchema }),
  kick: z.strictObject({ who: userIdSchema }),
  startRound: z.strictObject({ subject: wireSubjectSchema }),
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
  startTimer: z.strictObject({ seconds: z.number() }),
  stopTimer: empty,
  extendTimer: z.strictObject({ seconds: z.number() }),
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
  wire("setRole", payloads.setRole),
  wire("kick", payloads.kick),
  wire("startRound", payloads.startRound),
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
