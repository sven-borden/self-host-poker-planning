/**
 * The codes an acknowledgement can carry: the domain's `ErrorCode` plus the protocol's
 * own. Stable snake_case strings, never sentences; the web app translates every one.
 */
import type { ErrorCode } from "@pp/domain";

/** Codes the transport adds on top of the domain's. */
export const PROTOCOL_ERROR_CODES = [
  /** The message failed the zod schema (wrong shape, too large, unknown command). */
  "bad_payload",
  /** The client speaks another `PROTOCOL_VERSION`: it reloads. */
  "protocol_mismatch",
  "room_not_found",
  /** The room has a password and this browser holds no access cookie for it. */
  "password_required",
  "unauthenticated",
  "rate_limited",
  /** Something failed on the server; the details are in its log, never on the wire. */
  "internal",
] as const;
export type ProtocolErrorCode = (typeof PROTOCOL_ERROR_CODES)[number];

export type AckErrorCode = ErrorCode | ProtocolErrorCode;

/**
 * Every ack error code, for the web app's translation check. A test asserts at the type
 * level that this list and `AckErrorCode` hold exactly the same codes.
 */
export const ACK_ERROR_CODES = [
  "bad_command",
  "not_participant",
  "not_owner",
  "already_joined",
  "bad_name",
  "bad_role",
  "room_full",
  "cannot_kick_self",
  "unknown_participant",
  "bad_subject",
  "no_round",
  "not_voter",
  "bad_card",
  "round_revealed",
  "not_voting",
  "not_allowed",
  "not_revealed",
  "bad_seconds",
  "no_timer",
  "target_not_present",
  "already_owner",
  "owner_present",
  "bad_settings",
  "deck_empty",
  "deck_too_many_cards",
  "card_empty",
  "card_invalid",
  "card_too_long",
  "card_duplicate",
  "card_special",
  ...PROTOCOL_ERROR_CODES,
] as const satisfies readonly AckErrorCode[];
