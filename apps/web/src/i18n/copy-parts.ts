import type { copy as history } from "./parts/history-en.ts";
import type { copy as myRooms } from "./parts/my-rooms-en.ts";
import type { copy as queue } from "./parts/queue-en.ts";
import type { copy as settings } from "./parts/settings-en.ts";
import type { copy as sound } from "./parts/sound-en.ts";

// The parts of the catalog that only a lazy panel shows (U6): the room settings, the history with
// its summary and exports, the queue with its trackers, the sound popover and "My rooms". Each
// part is a chunk per language, loaded with its panel's own chunk (`loadCopy` in i18n.ts) and
// never with a page, so the room route and the landing page carry none of it and a reader in
// German fetches German alone. A part holds whole keys at their usual place (`settings.deck`):
// `t` looks in the page's catalog first, then in the parts loaded. A key that anything outside
// the panel shows stays in the catalog; `scripts/check-copy-parts.ts` holds the built chunks to
// that after every build.

// No import of language.ts: the build's check (scripts/check-copy-parts.ts) reads this file
// under Node's types, where that one does not compile; i18n.ts indexes these by `Language`.

const pick = (module: Promise<{ copy: object }>) => module.then(({ copy }) => copy);

/** Each part's loader, per language. Mutable for tests, which slow one down with `vi.spyOn`. */
export const COPY_LOADERS = {
  settings: {
    en: () => pick(import("./parts/settings-en.ts")),
    fr: () => pick(import("./parts/settings-fr.ts")),
    de: () => pick(import("./parts/settings-de.ts")),
  },
  history: {
    en: () => pick(import("./parts/history-en.ts")),
    fr: () => pick(import("./parts/history-fr.ts")),
    de: () => pick(import("./parts/history-de.ts")),
  },
  queue: {
    en: () => pick(import("./parts/queue-en.ts")),
    fr: () => pick(import("./parts/queue-fr.ts")),
    de: () => pick(import("./parts/queue-de.ts")),
  },
  sound: {
    en: () => pick(import("./parts/sound-en.ts")),
    fr: () => pick(import("./parts/sound-fr.ts")),
    de: () => pick(import("./parts/sound-de.ts")),
  },
  myRooms: {
    en: () => pick(import("./parts/my-rooms-en.ts")),
    fr: () => pick(import("./parts/my-rooms-fr.ts")),
    de: () => pick(import("./parts/my-rooms-de.ts")),
  },
} satisfies Record<string, Record<"en" | "fr" | "de", () => Promise<object>>>;

export type CopyPart = keyof typeof COPY_LOADERS;

/** Every part, for tests and the build's check. */
export const COPY_PARTS = Object.keys(COPY_LOADERS) as CopyPart[];

/** The parts' English words, which `t`'s types add to the catalog's. */
export type PartMessages = typeof settings &
  typeof history &
  typeof queue &
  typeof sound &
  typeof myRooms;
