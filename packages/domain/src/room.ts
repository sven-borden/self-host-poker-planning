/**
 * The room model (architecture, section 3). `RoomState` is what the server stores as the
 * room's `live` JSON; every change to it goes through `apply` (apply.ts).
 */
import type { AvatarId } from "./avatars.ts";
import type { Card, DeckSpec, SpecialCard } from "./decks.ts";

/** A Better Auth user id (guest or account). */
export type UserId = string;

export type Role = "voter" | "observer";
export const ROLES: readonly Role[] = ["voter", "observer"];

export type WhoCanReveal = "po" | "anyone";
export const WHO_CAN_REVEAL: readonly WhoCanReveal[] = ["po", "anyone"];

export type TimerSettings = {
  /** The timer started with every round, in seconds; `null` = no timer. */
  seconds: number | null;
  /** At the deadline: reveal (true) or only announce that time is up (false). */
  revealAtEnd: boolean;
};

export type RoomSettings = {
  deck: DeckSpec;
  /** The enabled special cards, in `SPECIAL_CARDS` order. */
  specials: SpecialCard[];
  whoCanReveal: WhoCanReveal;
  /** false = anonymous: results never tie a person to a card. Applies from the next round. */
  revealNames: boolean;
  revealWhenAllVoted: boolean;
  timer: TimerSettings;
  allowChangeAfterReveal: boolean;
  poVotes: boolean;
  observersCount: boolean;
  /**
   * After the PO records a final, the next queue item starts by itself, once a short
   * countdown has run (#52, ADR-024). Absent in a room stored before it: off.
   */
  autoAdvance: boolean;
};

/** What `updateSettings` accepts: any subset of the settings, `timer` merged one level deep. */
export type SettingsPatch = Partial<Omit<RoomSettings, "timer">> & {
  timer?: Partial<TimerSettings>;
};

export type Participant = {
  /** 1 to 32 user-perceived characters (at most 512 code units), trimmed. */
  name: string;
  role: Role;
  /** The avatar the person picked (#42); absent, they show their initials. */
  avatar?: AvatarId;
  joinedAt: number;
  connected: boolean;
  /** Set by presence once the grace period after the last socket closed has passed. */
  awaySince?: number;
};

export type Subject =
  | { kind: "none" }
  | { kind: "title"; text: string }
  /**
   * `key` ("ABC-123", an Azure DevOps id) is read by the server, never sent with a typed
   * subject. `title` comes from a queue item only (#52), which `cleanQueueItem` checked.
   */
  | { kind: "link"; url: string; key?: string; title?: string };

/**
 * Where a connector found an item (#54, #55): reserved, nothing writes it yet. It never
 * comes off the wire (the strict `queueAdd` schema refuses it) and no view shows it.
 */
export type QueueSource = { system: "jira" | "ado"; id: string };

/**
 * One ticket waiting for its round (#52). At least one of `key`, `title` and `url` is set,
 * each under the rules of a subject (`cleanQueueItem`). `id` is the room's own number,
 * never used twice.
 */
export type QueueItem = {
  id: number;
  key?: string;
  title?: string;
  url?: string;
  source?: QueueSource;
};

/** A queue item before the room numbered it. */
export type QueueEntry = Omit<QueueItem, "id">;

/**
 * What waits for a round, in order. `lastId` is the highest item id so far, and `rev`
 * counts the changes, so a page that holds the list knows when to ask for it again.
 */
export type Queue = { items: QueueItem[]; lastId: number; rev: number };

export type Vote = {
  card: Card;
  changedAfterReveal?: true;
  /**
   * The voter's name, kept when they leave or are kicked after a named reveal (#19), so
   * the results still say who played the card. Never set in an anonymous round.
   */
  name?: string;
};

export type Round = {
  number: number;
  subject: Subject;
  phase: "voting" | "revealed";
  /** The deck and specials the round is played with, captured at its start. */
  deck: DeckSpec;
  specials: SpecialCard[];
  /** `!settings.revealNames` at the round's start; a settings change applies from the next round. */
  anonymous: boolean;
  votes: Record<UserId, Vote>;
  startedAt: number;
  /**
   * How many times a deck or specials change restarted this round (#26); absent before the
   * first restart. A restart keeps the number, so votes carry this too: one still in
   * flight from before the restart is refused (`round_changed`).
   */
  restarts?: number;
  revealedAt?: number;
  /** Set while a timer runs (Voting only). */
  deadlineAt?: number;
  /**
   * When the running timer started (#27): the round's start, or the PO's `startTimer`.
   * The countdown ring shows the time left out of `deadlineAt - timerStartedAt`.
   */
  timerStartedAt?: number;
  /**
   * The deadline that passed while the room does not reveal at the end (#27): everyone
   * sees "Time is up" until the reveal or a new timer. Voting only.
   */
  timeUpAt?: number;
  final?: Card;
  /**
   * When the next queue item starts by itself (#52, ADR-024): set by a recorded final in a
   * room with `autoAdvance`, a queue and its PO present. Revealed only. A deadline like
   * `deadlineAt`: the first command, ping or server timeout after it starts the round,
   * exactly once.
   */
  advanceAt?: number;
  /** The PO chose to stay on this round: a changed final starts no countdown (#52). */
  stayed?: true;
};

export type RoomState = {
  /** The product owner (PO). */
  ownerId: UserId;
  /**
   * Who holds the right to delete the room (#49, ADR-027): the owner at creation, then whoever
   * that person hands the role to. A claim leaves it where it is: taking the role carries the
   * room's use, not its end. Server-held: no command sets it and no snapshot carries it. Absent in
   * a room stored before it, where `keeperOf` reads the PO, until a claim or a hand-over writes it.
   */
  keeperId?: UserId;
  settings: RoomSettings;
  participants: Record<UserId, Participant>;
  /** `null` = lobby, before the first round. */
  round: Round | null;
  /**
   * The room has a password (#31). Only the flag lives here: the argon2id hash has its own
   * column (`room.password_hash`), so it can never reach a snapshot. Absent: no password,
   * as in every room stored before #31.
   */
  hasPassword?: true;
  /**
   * The room's name (#49). Part of the state `apply` works on, stored in its own column
   * (`room.name`), which a room's header reads without loading the state. Absent: a room
   * created without one.
   */
  name?: string;
  /**
   * The backlog queue (#52). Part of the state `apply` works on, stored in its own column
   * (`room.queue`), so a vote never rewrites it. Absent: no queue yet.
   */
  queue?: Queue;
};

/** A room holds at most this many people, observers included unless the room says otherwise. */
export const MAX_PARTICIPANTS = 16;
/** A room never holds more participants than this, counted or not. */
export const MAX_MEMBERS = 32;
/** A display name holds 1 to this many user-perceived characters. */
export const MAX_NAME_LENGTH = 32;
/** A room name, when a room has one, holds 1 to this many user-perceived characters. */
export const MAX_ROOM_NAME_LENGTH = 60;
/** A subject title holds 1 to this many user-perceived characters. */
export const MAX_TITLE_LENGTH = 200;
/** A subject link holds at most this many characters. */
export const MAX_LINK_LENGTH = 2000;
/** A queue holds at most this many items (#52). */
export const MAX_QUEUE_ITEMS = 500;
/** A queue holds at most this much JSON (#52, ADR-024): 500 ordinary tickets take a third. */
export const MAX_QUEUE_BYTES = 256 * 1024;
/**
 * A queue item's title in UTF-8 bytes: 200 characters of four bytes each, so a title of
 * real words always fits. Without it a title of joined characters holds 11 KB, which a
 * snapshot would carry while it is the next item.
 */
export const MAX_ITEM_TITLE_BYTES = 800;
/**
 * One socket message in bytes (architecture section 8), which the page's list has to fit
 * too: it sends a long paste in several `queueAdd` (#52, ADR-024).
 */
export const MAX_MESSAGE_BYTES = 16 * 1024;
/** How long a recorded final stays on the table before the next item starts by itself. */
export const AUTO_ADVANCE_MS = 10_000;
/** A timer runs from this many seconds … */
export const MIN_TIMER_SECONDS = 5;
/** … to this many. */
export const MAX_TIMER_SECONDS = 3600;
/** A room password holds this many characters (code points, after NFC) … (#31) */
export const MIN_PASSWORD_LENGTH = 6;
/** … up to this many. Never trimmed: a space is a character like any other. */
export const MAX_PASSWORD_LENGTH = 128;
/** Anyone in the room can claim the PO role once the PO has been away this long. */
export const OWNER_CLAIM_AFTER_MS = 120_000;
/**
 * A voter (not the PO) may reveal an anonymous round by hand once this many cards are
 * down (#28): a lone card would show whose it is.
 */
export const MIN_ANONYMOUS_REVEAL_CARDS = 2;

/** The settings of a new room (ADR-011). Frozen: `createRoom` copies them. */
export const DEFAULT_SETTINGS: Readonly<RoomSettings> = Object.freeze({
  deck: Object.freeze({ kind: "preset", id: "fib" }) as DeckSpec,
  specials: Object.freeze(["?", "☕"]) as SpecialCard[],
  whoCanReveal: "po",
  revealNames: true,
  revealWhenAllVoted: true,
  timer: Object.freeze({ seconds: null, revealAtEnd: true }),
  allowChangeAfterReveal: false,
  poVotes: true,
  observersCount: true,
  autoAdvance: false,
});

/** Who holds the right to delete the room: see `keeperId`. */
export function keeperOf({ keeperId, ownerId }: Pick<RoomState, "keeperId" | "ownerId">): UserId {
  return keeperId ?? ownerId;
}

/** A new room: default settings, nobody inside (the PO enters through `join` too), no round. */
export function createRoom({ ownerId }: { ownerId: UserId }): RoomState {
  return {
    ownerId,
    keeperId: ownerId,
    settings: {
      ...DEFAULT_SETTINGS,
      deck: { ...DEFAULT_SETTINGS.deck } as DeckSpec,
      specials: [...DEFAULT_SETTINGS.specials],
      timer: { ...DEFAULT_SETTINGS.timer },
    },
    participants: {},
    round: null,
  };
}
