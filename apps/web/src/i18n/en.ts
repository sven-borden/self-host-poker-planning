import type { AckErrorCode } from "@pp/protocol";

// English copy, the reference catalog: `fr` and `de` must have the same keys (tsc and
// i18n.test.ts check it). Rules (apps/web/README.md, "i18n"):
// - `{{name}}` interpolates; numbers use `{{name, number}}` so they follow the language.
// - Plurals are keys with `_one`, `_other` (and `_many` in French) suffixes, picked by
//   `Intl.PluralRules` from the `count` option.

/** What the server's error codes mean to a person: what happened, then what to do. */
const errors = {
  bad_command:
    "The app sent something the server did not understand. Reload the page and try again.",
  not_participant: "You are no longer in this room. Reload the page to join again.",
  not_owner: "Only the product owner can do that.",
  already_joined: "You are already in this room.",
  bad_name: "A name needs {{min, number}} to {{max, number}} characters. Choose another one.",
  bad_role: "That role does not exist. Choose voter or observer.",
  room_full: "This room is full. Ask someone to leave, then try again.",
  cannot_kick_self: "You cannot remove yourself. Leave the room instead.",
  unknown_participant: "That person is no longer in the room.",
  bad_subject: "The round’s subject is not valid. Check the title or the link and try again.",
  no_round: "No round is running. Start a round first.",
  not_voter: "Observers do not vote. Switch to voter to play a card.",
  bad_card: "That card is not in this room’s deck. Pick another card.",
  round_revealed: "The cards are already revealed, so votes can no longer change.",
  not_voting: "This round is not open for votes.",
  not_allowed: "This room’s settings do not let you do that.",
  not_revealed: "Reveal the cards first.",
  bad_seconds:
    "A timer runs from {{min, number}} seconds to {{max, number}} minutes. Pick another length.",
  no_timer: "No timer is running.",
  target_not_present:
    "That person is not in the room right now. Only someone present can become product owner.",
  already_owner: "You are already the product owner.",
  owner_present:
    "The product owner is still here. You can take over after they have been away for two minutes.",
  bad_settings: "These settings are not valid. Check them and try again.",
  deck_empty: "A deck needs at least one card.",
  deck_too_many_cards: "A deck holds at most {{max, number}} cards. Remove some and try again.",
  card_empty: "A card cannot be empty.",
  card_invalid: "This card holds characters that cannot be shown. Type it again.",
  card_too_long: "A card label holds at most {{max, number}} characters. Shorten it.",
  card_duplicate: "This card is already in the deck.",
  card_special:
    "The special cards (?, ☕, ∞) are turned on in the room settings, not added to the deck.",
  bad_payload: "The server could not read that request. Reload the page and try again.",
  protocol_mismatch: "A new version of the app is available. Reload the page.",
  bad_room_name:
    "A room name needs {{min, number}} to {{max, number}} visible characters. Shorten it, or leave the field empty.",
  room_not_found:
    "This room does not exist, or it was deleted after a long time without use. Check the link.",
  password_required: "This room has a password. Enter it to join.",
  unauthenticated: "Your session has ended. Reload the page to continue.",
  rate_limited: "Too many attempts. Wait a moment, then try again.",
  busy: "The room was busy for a moment. Try again.",
  internal: "Something went wrong on the server. Try again in a moment.",
  /** Any code this version does not know yet. */
  unknown: "Something went wrong. Try again, or reload the page.",
} as const satisfies Record<AckErrorCode | "unknown", string>;

export const en = {
  app: {
    name: "Poker Planning",
    tagline: "Planning poker for teams",
    skipToContent: "Skip to content",
  },
  theme: {
    current: "Theme: {{mode}}",
    label: "Theme",
    light: "Light",
    dark: "Dark",
    system: "System",
  },
  language: {
    current: "Language: {{language}}",
    label: "Language",
    loadFailed: "Could not load this language. Reload the page and try again.",
  },
  home: {
    title: "Estimate together, around one table",
    lede: "Everyone picks a card, the cards turn over together, and the team talks about the difference. No account needed.",
    createRoom: "Create a room",
    howTitle: "How it works",
    step1Title: "Create a room",
    step1Body: "Name it if you like and pick a deck. You become its product owner.",
    step2Title: "Share the link",
    step2Body: "Your team opens it and types a name. No account, nothing to install.",
    step3Title: "Vote",
    step3Body: "Everyone picks a card in private. The table shows who has voted, never what.",
    step4Title: "Reveal",
    step4Body: "The cards turn over together. Talk about the difference, then play the next round.",
  },
  createRoom: {
    lede: "You become its product owner. Share the link and your team joins, no account needed.",
    nameLabel: "Room name",
    optional: "Optional",
    nameHint: "Everyone with the link sees it. Up to {{max, number}} characters.",
    deckLabel: "Deck",
    submit: "Create the room",
    creating: "Creating the room…",
    notAllowed:
      "The server did not accept this request: its configured address is not the one you used. Ask whoever runs it to check BASE_URL.",
  },
  decks: {
    fib: "Fibonacci",
    mfib: "Modified Fibonacci",
    tshirt: "T-shirt sizes",
    pow2: "Powers of 2",
    seq: "1 to 10",
  },
  room: {
    title: "Room {{code}}",
    codeLabel: "Room code",
    loading: "Opening the room…",
    copyLink: "Copy the link",
    linkCopied: "Link copied. Send it to your team.",
    copyFailed: "Your browser did not allow copying. Select the link below and copy it.",
    linkLabel: "Room link",
    notFoundTitle: "Room not found",
    retry: "Try again",
    statusConnecting: "Connecting to the room…",
    statusLive: "Connected",
    statusReconnecting: "Connection lost. Reconnecting…",
    people_one: "{{count, number}} person in the room",
    people_other: "{{count, number}} people in the room",
    reload: "Reload",
    kicked: "You were removed from this room.",
    offline: "The connection to the server was lost. Reload the page to try again.",
    backHome: "Back to the home page",
  },
  table: {
    seats: "People at the table",
    observers: "Observers",
    thinking: "Thinking",
    voted: "Voted",
    noVote: "No vote",
    seatThinking: "{{name}}, thinking",
    seatVoted: "{{name}}, voted",
    seatNoVote: "{{name}}, no vote",
    seatCard: "{{name}}, card {{card}}",
    seatCardWord: "{{name}}, {{card}}",
    votedSoFar_one: "{{count, number}}/{{total, number}} voted so far",
    votedSoFar_other: "{{count, number}}/{{total, number}} voted so far",
  },
  cards: {
    yourCards: "Your cards",
    unsure: "unsure",
    coffee: "needs a break",
    infinite: "too big to estimate",
  },
  dev: {
    tableTitle: "Table layout",
    tableLede:
      "A test bench for the table. Address parameters: n from 1 to 16, state lobby, voting or revealed, observers from 0 to 4.",
    hand: "Hand",
    miniCards: "Mini cards",
    average: "Average of the numeric cards: {{value, number(maximumFractionDigits: 1)}}",
  },
  notFound: {
    title: "Page not found",
    body: "This address leads nowhere. Check the link or start again from the home page.",
  },
  join: {
    title: "Join with a code",
    label: "Room code or link",
    hint: "Paste the link your team sent, or type the {{length, number}}-character code. Spaces do not matter.",
    submit: "Join",
    empty: "Enter a room code, or paste the room link.",
    malformed:
      "This is not a room code. A code has {{length, number}} letters and digits, never {{excluded}}. Check it, or paste the whole link.",
    excluded: "0, O, I or l",
    otherHost: "This link is for {{host}}.",
    openThere: "Open it there",
  },
  roomGone: {
    lede: "There is no room at this address. One of these may have happened:",
    typo: "The code or link was mistyped or cut short. Compare it with the one you were sent.",
    expired_one:
      "The room was deleted: rooms on this server are removed after {{count, number}} day without activity.",
    expired_other:
      "The room was deleted: rooms on this server are removed after {{count, number}} days without activity.",
    expiredUnknown:
      "The room was deleted: rooms on this server are removed after a long time without activity.",
    tryAnother: "Try another code",
    createRoom: "Create a new room",
  },
  errorPage: {
    title: "Something went wrong",
    body: "This page ran into a problem and stopped. Reloading usually fixes it. If it keeps happening, start again from the home page.",
    reload: "Reload the page",
  },
  identity: {
    reconnecting: "Connecting to the server…",
    cookiesBlocked:
      "This site needs cookies to recognise you in a room. Allow cookies for it, then reload the page.",
  },
  common: {
    network: "Could not reach the server. Check your connection, then try again.",
    close: "Close",
    notifications: "Notifications",
  },
  errors,
} as const;

type PluralBase<K> = K extends `${infer Base}_${"one" | "other"}` ? Base : never;

type Widen<T, Extra extends string> = T extends string
  ? string
  : { [K in keyof T]: Widen<T[K], Extra> } & {
      [K in PluralBase<keyof T> as `${K & string}_${Extra}`]: string;
    };

/**
 * The shape a catalog must match: the English keys with any string as value, plus, for
 * each plural key, the plural categories its language has beyond one and other
 * (French: "many"). A missing or extra key fails `tsc`.
 */
export type Catalog<ExtraPlurals extends string = never> = Widen<typeof en, ExtraPlurals>;
