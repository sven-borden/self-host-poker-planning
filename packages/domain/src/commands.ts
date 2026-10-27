/**
 * What `apply` takes and returns: commands, causes and error codes (architecture, section 4).
 */
import type { CustomDeckErrorCode } from "./custom-deck.ts";
import type { Card } from "./decks.ts";
import type { Role, RoomState, Round, SettingsPatch, Subject, UserId } from "./room.ts";

/**
 * Every change to a room. A flat union discriminated by `type`.
 *
 * `castVote` and `retractVote` carry `round`, the number of the round the press was
 * made for: a command still in flight when the PO starts the next round is refused
 * (`round_changed`) instead of landing in it. They carry `restart` too, the round's
 * `restarts` when the press was made: a deck change restarts the round under the same
 * number (#26), and a vote for the old deck must not land in the new one. The wire
 * protocol always sends both; the domain checks each whenever it is given.
 */
export type Command =
  | { type: "join"; name: string; role: Role }
  | { type: "leave" }
  | { type: "rename"; name: string }
  | { type: "setRole"; role: Role }
  | { type: "kick"; who: UserId }
  | { type: "startRound"; subject: Subject }
  | { type: "castVote"; card: Card; round?: number; restart?: number }
  | { type: "retractVote"; round?: number; restart?: number }
  | { type: "reveal" }
  | { type: "setFinal"; card: Card }
  | { type: "revote" }
  | { type: "startTimer"; seconds: number }
  | { type: "stopTimer" }
  | { type: "extendTimer"; seconds: number }
  | { type: "timeUp" }
  | { type: "updateSettings"; patch: SettingsPatch }
  | { type: "transferOwner"; to: UserId }
  | { type: "claimOwner" }
  | { type: "presence"; who: UserId; connected: boolean };

export type CommandType = Command["type"];

/**
 * Commands only the server sends: `presence` (#17), after a person's last socket left
 * and the grace period passed, or when they come back. The wire protocol has no schema
 * for them, so a client that sends one gets `bad_payload` before `apply` runs.
 */
export type ServerCommandType = "presence";
/** What a client may send: every command except the server's own. */
export type ClientCommand = Exclude<Command, { type: ServerCommandType }>;
export type ClientCommandType = ClientCommand["type"];

/** Who sends the command, and when (epoch milliseconds). The domain never reads the clock. */
export type ApplyContext = { actor: UserId; now: number };

/**
 * Client-facing hints for animations and announcements. A cause never carries a card
 * value, except `finalSet`, whose card is public. In an anonymous round after reveal
 * vote causes carry no `who` (a changed vote would otherwise tie the person to both
 * cards); the projection (#5) strips it too.
 */
export type Cause =
  | { type: "joined"; who: UserId }
  | { type: "left"; who: UserId }
  | { type: "kicked"; who: UserId }
  | { type: "renamed"; who: UserId }
  | { type: "roleChanged"; who: UserId; role: Role }
  | { type: "roundStarted"; number: number; restarted?: true; revote?: true }
  | { type: "voteCast"; who?: UserId }
  | { type: "voteRetracted"; who?: UserId }
  | { type: "revealed"; by: "manual" | "everyoneVoted" | "timer" }
  | { type: "timerStarted" }
  | { type: "timerStopped" }
  | { type: "timerExtended" }
  | { type: "timeUp" }
  | { type: "finalSet"; card: Card }
  | { type: "settingsUpdated" }
  | { type: "ownerChanged"; by: "transfer" | "claim"; to: UserId }
  | { type: "away"; who: UserId }
  | { type: "back"; who: UserId };

/** Why a command was refused. Stable snake_case codes; the UI translates them. */
export type ErrorCode =
  | "bad_command"
  | "not_participant"
  | "not_owner"
  | "already_joined"
  | "bad_name"
  | "bad_role"
  | "room_full"
  | "cannot_kick_self"
  | "unknown_participant"
  | "bad_subject"
  | "no_round"
  | "not_voter"
  | "bad_card"
  | "round_revealed"
  | "round_changed"
  | "not_voting"
  | "not_allowed"
  | "not_revealed"
  | "bad_seconds"
  | "no_timer"
  | "target_not_present"
  | "already_owner"
  | "owner_present"
  | "bad_settings"
  | CustomDeckErrorCode;

/**
 * The outcome of `apply`. A refusal still carries `state` and `causes`: an elapsed
 * deadline is resolved before the command and that resolution stands. When nothing
 * changed, `state` is the input object itself, so the caller can skip the write.
 *
 * `ended` is the round this `apply` replaced or abandoned (`startRound`, `revote`, or a
 * deck or specials change that restarts a voting round), in its final form: after an
 * elapsed deadline was resolved, so a round the timer revealed comes back revealed even
 * though the input still held it Voting. The server writes it to history only when
 * `ended.phase === "revealed"`.
 */
export type ApplyResult =
  | { ok: true; state: RoomState; causes: Cause[]; ended?: Round }
  | { ok: false; error: ErrorCode; state: RoomState; causes: Cause[] };
