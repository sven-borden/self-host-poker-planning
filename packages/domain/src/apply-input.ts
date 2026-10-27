/**
 * Validation of what a client sends with a command: names, subjects, timer seconds and
 * settings patches. Commands are typed, but they come off the network, so every value is
 * checked at runtime too (the protocol's zod schemas are the first line, this is the last).
 */
import type { ErrorCode } from "./commands.ts";
import {
  cardLength,
  type DeckSpec,
  isSpecial,
  PRESET_DECK_IDS,
  SPECIAL_CARDS,
  type SpecialCard,
  UNITS_PER_CHARACTER,
  validateCustomDeck,
} from "./decks.ts";
import {
  MAX_NAME_LENGTH,
  MAX_ROOM_NAME_LENGTH,
  MAX_TIMER_SECONDS,
  MIN_TIMER_SECONDS,
  type RoomSettings,
  WHO_CAN_REVEAL,
} from "./room.ts";

type UnknownRecord = Record<string, unknown>;

export function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Characters that break, hide or spoof the text around them: control characters, bidi
 * controls (overrides, isolates, LRM, RLM, ALM) and every default-ignorable code point
 * (zero-width space, soft hyphen, word joiner, Hangul fillers, variation selectors, tag
 * characters …), which render as nothing, so "Sv" + U+200B + "en" would show as "Sven".
 * Emoji need three of them, which `ALLOWED_INVISIBLE` takes out first.
 */
const UNSAFE_TEXT = /[\p{Cc}\p{Bidi_Control}\p{Default_Ignorable_Code_Point}]/u;
/** ZWNJ (Persian, Hindi), ZWJ (emoji sequences) and VS16 (emoji presentation). */
const ALLOWED_INVISIBLE = /\u{200C}|\u{200D}|\u{FE0F}/gu;
/** A flag of tag characters (🏴 England, Scotland, Wales): its tags are allowed. */
const EMOJI_TAG_SEQUENCE = /\u{1F3F4}[\u{E0020}-\u{E007E}]+\u{E007F}/gu;
/**
 * What shows as nothing on its own: whitespace, format characters, the braille blank
 * (U+2800) and combining marks, which need a base to show on. Text made only of these is
 * blank.
 */
const BLANK = /[\s\p{Cf}\u{2800}\p{M}]/gu;
/**
 * A run of whitespace, tabs and line breaks included, but not U+FEFF: JavaScript counts
 * it as whitespace, yet it is default-ignorable and refused like the others.
 */
const WHITESPACE_RUN = /[^\S\u{FEFF}]+/gu;

/**
 * Four combining marks in a row, where up to three are allowed: "Zalgo" text, whose marks
 * pile up and paint over the lines around it. ZWJ, ZWNJ and VS16 between the marks do not
 * break the row, and VS16 (a mark by category) is not counted. Marks only follow their
 * base, so a row of marks belongs to one user-perceived character and no `Intl.Segmenter`
 * is needed.
 */
const TOO_MANY_MARKS = /(?:(?!\u{FE0F})\p{M}(?:\u{200C}|\u{200D}|\u{FE0F})*){4}/u;

/**
 * Text with every whitespace run (tabs and line breaks too, as in a pasted ticket title)
 * collapsed into one space, trimmed and NFC-normalised, of 1 to `max` user-perceived
 * characters and at most `max × UNITS_PER_CHARACTER` code units; else `null`. Refused:
 * control characters, bidi controls and default-ignorable characters (ZWJ, ZWNJ and VS16
 * excepted, and tag characters inside an emoji flag), text that is blank (only
 * whitespace, format characters, braille blanks and combining marks without a base) and
 * text with more than 3 combining marks on one character (Vietnamese, Thai and Hindi
 * need up to 2 or 3; "Zalgo" text needs dozens). A
 * lone surrogate refuses the text: Postgres jsonb would refuse it at write time.
 * Covers names, round titles (`apply-subject.ts`) and (W1) room names.
 */
export function cleanText(raw: unknown, max: number): string | null {
  if (typeof raw !== "string" || !raw.isWellFormed()) return null;
  const spaced = raw.replace(WHITESPACE_RUN, " ");
  const text = spaced.trim().normalize("NFC");
  if (text.length > max * UNITS_PER_CHARACTER) return null;
  if (text.replace(BLANK, "") === "" || TOO_MANY_MARKS.test(text)) return null;
  // Checked before `trim`, which would drop a U+FEFF at either end.
  const checked = spaced.replace(EMOJI_TAG_SEQUENCE, "\u{1F3F4}").replace(ALLOWED_INVISIBLE, "");
  if (UNSAFE_TEXT.test(checked)) return null;
  return cardLength(text) <= max ? text : null;
}

/** A display name, cleaned, or `null` (`bad_name`). */
export function cleanName(raw: unknown): string | null {
  return cleanText(raw, MAX_NAME_LENGTH);
}

/**
 * A room name, cleaned, or `null` (`bad_room_name`). The name is set when the room is
 * created (`POST /api/rooms`) and lives beside `RoomState`, not in it.
 */
export function cleanRoomName(raw: unknown): string | null {
  return cleanText(raw, MAX_ROOM_NAME_LENGTH);
}

/** A timer length: an integer from 5 to 3600 seconds. */
export function isTimerSeconds(value: unknown): value is number {
  return (
    Number.isInteger(value) &&
    (value as number) >= MIN_TIMER_SECONDS &&
    (value as number) <= MAX_TIMER_SECONDS
  );
}

/** A fresh copy of a deck with a fixed key order (jsonb does not keep key order). */
export function canonicalDeck(deck: DeckSpec): DeckSpec {
  return deck.kind === "preset"
    ? { kind: "preset", id: deck.id }
    : { kind: "custom", cards: [...deck.cards] };
}

/** A fresh copy of the settings with a fixed key order, for comparison and storage. */
export function canonicalSettings(s: RoomSettings): RoomSettings {
  return {
    deck: canonicalDeck(s.deck),
    specials: [...s.specials],
    whoCanReveal: s.whoCanReveal,
    revealNames: s.revealNames,
    revealWhenAllVoted: s.revealWhenAllVoted,
    timer: { seconds: s.timer.seconds, revealAtEnd: s.timer.revealAtEnd },
    allowChangeAfterReveal: s.allowChangeAfterReveal,
    poVotes: s.poVotes,
    observersCount: s.observersCount,
  };
}

export function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function parseDeck(raw: unknown): DeckSpec | ErrorCode {
  if (!isRecord(raw)) return "bad_settings";
  if (raw.kind === "preset") {
    const id = PRESET_DECK_IDS.find((d) => d === raw.id);
    return id === undefined ? "bad_settings" : { kind: "preset", id };
  }
  const cards = raw.cards;
  if (
    raw.kind !== "custom" ||
    !Array.isArray(cards) ||
    !cards.every((c) => typeof c === "string")
  ) {
    return "bad_settings";
  }
  const result = validateCustomDeck(cards);
  return result.ok ? { kind: "custom", cards: result.cards } : result.code;
}

/** Enabled specials: a duplicate-free subset of `SPECIAL_CARDS`, stored in display order. */
function parseSpecials(raw: unknown): SpecialCard[] | null {
  if (!Array.isArray(raw) || !raw.every((c) => typeof c === "string" && isSpecial(c))) return null;
  if (new Set(raw).size !== raw.length) return null;
  return SPECIAL_CARDS.filter((s) => raw.includes(s));
}

const BOOLEAN_KEYS = [
  "revealNames",
  "revealWhenAllVoted",
  "allowChangeAfterReveal",
  "poVotes",
  "observersCount",
] as const;
const SETTINGS_KEYS: readonly string[] = [
  "deck",
  "specials",
  "whoCanReveal",
  "timer",
  ...BOOLEAN_KEYS,
];
const TIMER_KEYS: readonly string[] = ["seconds", "revealAtEnd"];

/**
 * The settings after a patch: a shallow merge, `timer` merged one level deep. Unknown keys
 * and invalid values refuse the whole patch (`bad_settings`, or the custom-deck code).
 * The result is a fresh object in canonical key order.
 */
export function patchSettings(
  current: RoomSettings,
  patch: unknown,
): { ok: true; settings: RoomSettings } | { ok: false; error: ErrorCode } {
  const fail = (error: ErrorCode = "bad_settings") => ({ ok: false as const, error });
  if (!isRecord(patch) || !Object.keys(patch).every((k) => SETTINGS_KEYS.includes(k))) {
    return fail();
  }
  const next = canonicalSettings(current);
  if (Object.hasOwn(patch, "deck")) {
    const deck = parseDeck(patch.deck);
    if (typeof deck === "string") return fail(deck);
    next.deck = deck;
  }
  if (Object.hasOwn(patch, "specials")) {
    const specials = parseSpecials(patch.specials);
    if (specials === null) return fail();
    next.specials = specials;
  }
  if (Object.hasOwn(patch, "whoCanReveal")) {
    const who = WHO_CAN_REVEAL.find((w) => w === patch.whoCanReveal);
    if (who === undefined) return fail();
    next.whoCanReveal = who;
  }
  for (const key of BOOLEAN_KEYS) {
    if (!Object.hasOwn(patch, key)) continue;
    const value = patch[key];
    if (typeof value !== "boolean") return fail();
    next[key] = value;
  }
  if (Object.hasOwn(patch, "timer")) {
    const timer = patch.timer;
    if (!isRecord(timer) || !Object.keys(timer).every((k) => TIMER_KEYS.includes(k))) return fail();
    if (Object.hasOwn(timer, "seconds")) {
      if (timer.seconds !== null && !isTimerSeconds(timer.seconds)) return fail();
      next.timer.seconds = timer.seconds as number | null;
    }
    if (Object.hasOwn(timer, "revealAtEnd")) {
      if (typeof timer.revealAtEnd !== "boolean") return fail();
      next.timer.revealAtEnd = timer.revealAtEnd;
    }
  }
  return { ok: true, settings: next };
}
