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
  MAX_LINK_LENGTH,
  MAX_NAME_LENGTH,
  MAX_TIMER_SECONDS,
  MAX_TITLE_LENGTH,
  MIN_TIMER_SECONDS,
  type RoomSettings,
  type Subject,
  WHO_CAN_REVEAL,
} from "./room.ts";

type UnknownRecord = Record<string, unknown>;

export function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Control characters and bidirectional overrides: they break or spoof the text around them. */
const UNSAFE_TEXT = /[\p{Cc}‪-‮⁦-⁩]/u;
/** Whitespace and invisible format characters: text made only of these looks empty. */
const BLANK = /[\s\p{Cf}]/gu;

/**
 * Trimmed, NFC-normalised text of 1 to `max` user-perceived characters and at most
 * `max × UNITS_PER_CHARACTER` code units, without control characters or bidi overrides
 * and not made of invisible characters only; else `null`.
 */
function cleanText(raw: unknown, max: number): string | null {
  if (typeof raw !== "string") return null;
  const text = raw.trim().normalize("NFC");
  if (text.length > max * UNITS_PER_CHARACTER) return null;
  if (text.replace(BLANK, "") === "" || UNSAFE_TEXT.test(text)) return null;
  return cardLength(text) <= max ? text : null;
}

/** A display name, cleaned, or `null` (`bad_name`). */
export function cleanName(raw: unknown): string | null {
  return cleanText(raw, MAX_NAME_LENGTH);
}

/**
 * An `http(s)` URL with a non-empty host and no user info (`https://a.com@b.com` would
 * hide the real host), without whitespace, control or format characters. Checked by
 * pattern: the domain has no `URL`.
 */
const LINK = /^https?:\/\/[^\s\p{Cc}\p{Cf}/?#@\\]+(?:[/?#][^\s\p{Cc}\p{Cf}]*)?$/iu;

/** A round subject, cleaned, or `null` (`bad_subject`). A client-sent link `key` is dropped. */
export function cleanSubject(raw: unknown): Subject | null {
  if (!isRecord(raw)) return null;
  if (raw.kind === "none") return { kind: "none" };
  if (raw.kind === "title") {
    const text = cleanText(raw.text, MAX_TITLE_LENGTH);
    return text === null ? null : { kind: "title", text };
  }
  if (raw.kind === "link" && typeof raw.url === "string") {
    const url = raw.url.trim();
    return url.length <= MAX_LINK_LENGTH && LINK.test(url) ? { kind: "link", url } : null;
  }
  return null;
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
