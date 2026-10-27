import type { PresetDeckId } from "@pp/domain";
import type { RoomSettingsView } from "@pp/protocol";
import type { MessageKey, TFunction } from "../i18n/i18n.ts";

// Words for the room's settings, shared by the settings panel (its own lazy chunk) and the
// table's live region (#25), so neither pulls the other's code.

const DECK_NAMES: Record<PresetDeckId, MessageKey> = {
  fib: "decks.fib",
  mfib: "decks.mfib",
  tshirt: "decks.tshirt",
  pow2: "decks.pow2",
  seq: "decks.seq",
};

/** The deck's name as people know it: a preset's own name, or "Custom deck". */
export function deckName(t: TFunction, deck: RoomSettingsView["deck"]): string {
  return deck.kind === "preset" ? t(DECK_NAMES[deck.id] as "decks.fib") : t("decks.custom");
}

/** The settings, in the order the panel lists them and the live region says them. */
export const SETTING_KEYS = [
  "deck",
  "specials",
  "timer",
  "revealWhenAllVoted",
  "whoCanReveal",
  "revealNames",
  "allowChangeAfterReveal",
  "poVotes",
  "observersCount",
] as const satisfies readonly (keyof RoomSettingsView)[];

export type SettingKey = (typeof SETTING_KEYS)[number];

/** Whether one setting holds the same value in both (the server builds them field by field). */
export function sameSetting(a: RoomSettingsView, b: RoomSettingsView, key: SettingKey): boolean {
  return JSON.stringify(a[key]) === JSON.stringify(b[key]);
}
