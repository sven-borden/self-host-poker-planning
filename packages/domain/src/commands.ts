/**
 * What `apply` takes and returns: commands, causes and error codes (architecture, section 4).
 */
import type { CustomDeckErrorCode } from "./custom-deck.ts";
import type { Card } from "./decks.ts";
import type { QueueEntry, Role, RoomState, Round, SettingsPatch, Subject, UserId } from "./room.ts";

/**
 * Every change to a room. A flat union discriminated by `type`.
 *
 * `castVote` and `retractVote` carry `round`, the number of the round the press was
 * made for: a command still in flight when the PO starts the next round is refused
 * (`round_changed`) instead of landing in it. They carry `restart` too, the round's
 * `restarts` when the press was made: a deck change restarts the round under the same
 * number (#26), and a vote for the old deck must not land in the new one. The wire
 * requires `round`; `restart` is optional there (a tab from before #26 sends none), and
 * the web app always sends it. The domain checks each whenever it is given.
 *
 * `startRound` carries `round` too (#52): the number of the round on the table when the PO
 * pressed, 0 in the lobby. A countdown may start the next queue item under that press, and
 * the press must not replace it: the item would have left the queue and never been a round.
 */
export type Command =
  | { type: "join"; name: string; role: Role; avatar?: string }
  | { type: "leave" }
  | { type: "rename"; name: string }
  /** `null` goes back to the initials (#42). */
  | { type: "setAvatar"; avatar: string | null }
  | { type: "setRole"; role: Role }
  | { type: "kick"; who: UserId }
  | { type: "startRound"; subject: Subject; round?: number }
  /** A whole paste as one command (#52): all of it or, past the limit, none of it. */
  | { type: "queueAdd"; items: QueueEntry[] }
  /** `to`: the item's place in the queue afterwards, from 0; past the end, the end. */
  | { type: "queueMove"; id: number; to: number }
  | { type: "queueRemove"; id: number }
  | { type: "queueClear" }
  /** "Next item": a round on this item, which leaves the queue. */
  | { type: "startNext"; id: number }
  /** The PO stays on this round: the countdown stops, and a changed final starts no other. */
  | { type: "holdAdvance" }
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
  | { type: "presence"; who: UserId; connected: boolean }
  | { type: "password"; on: boolean }
  /** A guest signed in: their place in this room becomes the account's (#48, ADR-025). */
  | { type: "moveGuest"; guest: UserId; account: UserId }
  /** The PO's last socket left during a countdown, or the room's: it ends, and nothing starts. */
  | { type: "endCountdown" };

export type CommandType = Command["type"];

/**
 * Commands only the server sends: `presence` (#17), after a person's last socket left
 * and the grace period passed, or when they come back; `password` (#31), when the PO
 * sets, changes or removes the room's password over HTTP (the password itself never
 * enters a command); `moveGuest` (#48), when a guest signs in; `endCountdown` (#52), when the
 * PO or the whole room left during a countdown. The wire protocol has no schema for them, so a
 * client that sends one gets `bad_payload` before `apply` runs.
 */
export type ServerCommandType = "presence" | "password" | "moveGuest" | "endCountdown";
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
  | { type: "avatarChanged"; who: UserId }
  | { type: "roleChanged"; who: UserId; role: Role }
  | { type: "roundStarted"; number: number; restarted?: true; revote?: true }
  | { type: "voteCast"; who?: UserId }
  | { type: "voteRetracted"; who?: UserId }
  /**
   * `who`: the person who revealed by hand (#28), the PO or, when anyone who votes may, a
   * voter. It maps nobody to a value, so it travels in anonymous rounds too.
   */
  | { type: "revealed"; by: "manual" | "everyoneVoted" | "timer"; who?: UserId }
  | { type: "timerStarted" }
  | { type: "timerStopped" }
  | { type: "timerExtended" }
  | { type: "timeUp" }
  | { type: "finalSet"; card: Card }
  | { type: "settingsUpdated"; password?: PasswordChange }
  | { type: "ownerChanged"; by: "transfer" | "claim"; to: UserId }
  | { type: "away"; who: UserId }
  | { type: "back"; who: UserId }
  /** `added`: how many items a paste put in; left out for any other change. */
  | { type: "queueChanged"; added?: number }
  /** The next item starts by itself at the round's `advanceAt` (#52). */
  | { type: "advanceArmed" }
  /** It will not: the PO stayed or left, or the queue or the setting no longer allows it. */
  | { type: "advanceHeld" };

/**
 * What a `password` command did (#31): a first password, a new one in place of the old,
 * or none any more. It rides on `settingsUpdated`, since the room's settings show it.
 */
export type PasswordChange = "set" | "changed" | "removed";

/** Why a command was refused. Stable snake_case codes; the UI translates them. */
export type ErrorCode =
  | "bad_command"
  | "not_participant"
  | "not_owner"
  | "already_joined"
  | "bad_name"
  | "bad_avatar"
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
  | "too_few_cards"
  | "not_revealed"
  | "bad_seconds"
  | "no_timer"
  | "target_not_present"
  | "already_owner"
  | "owner_present"
  | "bad_settings"
  | "bad_queue_item"
  | "queue_full"
  | "unknown_item"
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
 * `ended.phase === "revealed"`. A refusal carries it too: the deadline resolved before the
 * command may have started the next item (#52), and that stands.
 */
export type ApplyResult =
  | { ok: true; state: RoomState; causes: Cause[]; ended?: Round }
  | { ok: false; error: ErrorCode; state: RoomState; causes: Cause[]; ended?: Round };
