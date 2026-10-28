/**
 * The round history (#33): `history { before?, limit? }` over the socket, answered with one
 * page of the room's finished rounds, newest first. Only someone in the room (a voter, an
 * observer or the PO) may read it, checked on every request. Pages run by round number:
 * `before` asks for the rounds numbered below it, and an answer that has older rounds
 * left says where the next page starts (`next`). The round still on the table is left out,
 * even when it already has a row (a final recorded, #32); it shows once the next round
 * starts.
 *
 * The answer's schemas are strict, unlike the snapshot's: a row never carries a user id,
 * and an anonymous row never a name, so a field nobody expects fails the server's tests.
 */
import { z } from "zod";
import { cardSchema, WIRE_LIMITS } from "./commands.ts";
import { ackErrorCodeSchema, resultsSchema } from "./schemas.ts";

/** Rounds per page: `size` when the request names none, at most `max`. */
export const HISTORY_PAGE = { size: 20, max: 50 } as const;

/** A round's number, as history counts it (rounds count from 1). */
const roundNumberSchema = z.number().int().min(1);

/**
 * `history`: one page, newest first. `before` (a round number) asks for older rounds than
 * it; left out, the newest. `limit` defaults to `HISTORY_PAGE.size`.
 */
export const historyRequestSchema = z.strictObject({
  before: roundNumberSchema.optional(),
  limit: z.number().int().min(1).max(HISTORY_PAGE.max).optional(),
});
export type HistoryRequest = z.output<typeof historyRequestSchema>;

export type ParsedHistoryRequest =
  | { ok: true; request: HistoryRequest }
  | { ok: false; code: "bad_payload" };

/**
 * Parses what a socket sent with `history`; no payload at all asks for the newest page.
 * Never throws.
 */
export function parseHistoryRequest(input: unknown): ParsedHistoryRequest {
  const parsed = historyRequestSchema.safeParse(input === undefined ? {} : input);
  return parsed.success ? { ok: true, request: parsed.data } : { ok: false, code: "bad_payload" };
}

const textSchema = z.string().max(WIRE_LIMITS.subject);

/** The round's subject as it was stored (the server read a link's key then). */
const historySubjectSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("none") }),
  z.strictObject({ kind: z.literal("title"), text: textSchema }),
  z.strictObject({ kind: z.literal("link"), url: textSchema, key: textSchema.optional() }),
]);

/**
 * One vote of a named round: the name the voter had, never their id. `null` for a vote
 * stored before #19 kept the names of people who left.
 */
export const namedHistoryVoteSchema = z.strictObject({
  name: z.string().max(WIRE_LIMITS.name).nullable(),
  card: cardSchema,
  changedAfterReveal: z.literal(true).optional(),
});

/**
 * The votes of a round: by name in a named round (people still in the room by when they
 * joined, then those who had left), the cards alone in an anonymous one, in the deck's
 * order as stored: nothing ties a person to a card there.
 */
export const historyVotesSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("named"), votes: z.array(namedHistoryVoteSchema) }),
  z.strictObject({ kind: z.literal("anonymous"), cards: z.array(cardSchema) }),
]);

/**
 * One finished round. `stats` is the domain's `computeResults` of its cards (the
 * distribution, the suggested card, the agreement, …). `final` is the PO's estimate, null
 * when none was recorded. Times are epoch milliseconds on the server's clock:
 * `revealedAt − startedAt` is how long the voting took, `finishedAt` when the round ended.
 */
export const historyRoundSchema = z.strictObject({
  number: roundNumberSchema,
  subject: historySubjectSchema,
  final: cardSchema.nullable(),
  stats: z.strictObject(resultsSchema.shape),
  startedAt: z.number(),
  revealedAt: z.number(),
  finishedAt: z.number(),
  votes: historyVotesSchema,
});

/**
 * The answer: the page's rounds, newest first, and `next`, the `before` of the page after
 * it, when older rounds remain.
 */
export const historyAckSchema = z.union([
  z.strictObject({
    ok: z.literal(true),
    rounds: z.array(historyRoundSchema),
    next: roundNumberSchema.optional(),
  }),
  z.object({ ok: z.literal(false), code: ackErrorCodeSchema }),
]);

export type NamedHistoryVoteView = z.output<typeof namedHistoryVoteSchema>;
export type HistoryVotesView = z.output<typeof historyVotesSchema>;
export type HistoryRoundView = z.output<typeof historyRoundSchema>;
export type HistoryAck = z.output<typeof historyAckSchema>;
