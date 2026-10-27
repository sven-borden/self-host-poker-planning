import { ACK_ERROR_CODES, PROTOCOL_ERROR_CODES } from "@pp/protocol";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { de } from "./de.ts";
import { en } from "./en.ts";
import { errorMessage, isKnownErrorCode } from "./errors.ts";
import { fr } from "./fr.ts";
import {
  changeLanguage,
  chooseLanguage,
  currentLanguage,
  fixedT,
  loadLanguage,
  startLanguage,
} from "./i18n.ts";
import {
  detectLanguage,
  LANGUAGE_STORAGE_KEY,
  LANGUAGES,
  type Language,
  pickLanguage,
  readSavedLanguage,
} from "./language.ts";

// The catalog checks run on the objects at run time, so they hold even if a catalog ever
// bypasses the type check (a JSON import, a cast).

const CATALOGS: Record<Language, unknown> = { en, fr, de };
const PLURAL = /_(zero|one|two|few|many|other)$/;

/** Every leaf as [dotted key, value]; a value that is not a string is kept to fail later. */
function leaves(value: unknown, prefix = ""): [string, unknown][] {
  if (typeof value !== "object" || value === null) {
    return [[prefix, value]];
  }
  return Object.entries(value).flatMap(([key, child]) =>
    leaves(child, prefix ? `${prefix}.${key}` : key),
  );
}

/** Keys with their plural suffix removed, each with the suffixes it has ("" when none). */
function baseKeys(catalog: unknown): Map<string, string[]> {
  const keys = new Map<string, string[]>();
  for (const [key] of leaves(catalog)) {
    const suffix = PLURAL.exec(key)?.[1] ?? "";
    const base = suffix ? key.slice(0, -suffix.length - 1) : key;
    keys.set(base, [...(keys.get(base) ?? []), suffix].sort());
  }
  return keys;
}

/** `{{ name, format }}` placeholders, normalised to "name|format". */
function placeholders(text: string): string[] {
  return [...text.matchAll(/\{\{\s*([^,}]+?)\s*(?:,\s*([^}]+?)\s*)?\}\}/g)]
    .map((match) => `${match[1]}|${match[2] ?? ""}`)
    .sort();
}

describe("catalogs", () => {
  const english = baseKeys(en);

  it.each(LANGUAGES)("%s holds only non-empty strings", (language) => {
    for (const [key, value] of leaves(CATALOGS[language])) {
      expect(typeof value, `${language}: ${key}`).toBe("string");
      expect(String(value).trim(), `${language}: ${key}`).not.toBe("");
    }
  });

  it.each(LANGUAGES)("%s has exactly the English keys, no more and no fewer", (language) => {
    expect([...baseKeys(CATALOGS[language]).keys()].sort()).toEqual([...english.keys()].sort());
  });

  it.each(LANGUAGES)("%s has every plural form its language needs, and only those", (language) => {
    const categories = [
      ...new Intl.PluralRules(language).resolvedOptions().pluralCategories,
    ].sort();
    for (const [key, suffixes] of baseKeys(CATALOGS[language])) {
      const plural = english.get(key)?.some(Boolean) ?? false;
      expect(suffixes, `${language}: ${key}`).toEqual(plural ? categories : [""]);
    }
  });

  it("knows that French needs a many form", () => {
    // Our `t` would fall back to `_other`, but i18next and translation platforms expect
    // every form, so the catalogs keep them all.
    expect(new Intl.PluralRules("fr").select(1_000_000)).toBe("many");
  });

  it("keeps the same placeholders, with the same formats, in every language", () => {
    const byBase = (catalog: unknown) => {
      const map = new Map<string, Set<string>>();
      for (const [key, value] of leaves(catalog)) {
        const base = key.replace(PLURAL, "");
        const set = map.get(base) ?? new Set<string>();
        for (const placeholder of placeholders(String(value))) {
          set.add(placeholder);
        }
        map.set(base, set);
      }
      return map;
    };
    const reference = byBase(en);
    for (const language of LANGUAGES) {
      for (const [key, set] of byBase(CATALOGS[language])) {
        expect([...set].sort(), `${language}: ${key}`).toEqual(
          [...(reference.get(key) ?? [])].sort(),
        );
      }
    }
  });

  it("formats every number placeholder in a catalog", () => {
    for (const language of LANGUAGES) {
      for (const [key, value] of leaves(CATALOGS[language])) {
        for (const placeholder of placeholders(String(value))) {
          if (/^(count|total|value|min|max)\|/.test(placeholder)) {
            expect(placeholder, `${language}: ${key}`).toMatch(/\|number/);
          }
        }
      }
    }
  });

  it("puts a narrow no-break space before French high punctuation, so it never wraps alone", () => {
    for (const [key, value] of leaves(fr)) {
      // Placeholders keep their own syntax, such as "number(maximumFractionDigits: 1)".
      const text = String(value).replace(/{{[^}]*}}/g, "{{}}");
      expect(text, `fr: ${key}`).not.toMatch(/[ \u00a0][:;!?]/);
      expect(text, `fr: ${key}`).not.toMatch(/[\p{L}\p{N}}][:;!?]/u);
    }
  });

  // Strings that read the same in that language on purpose: the product's name, a list
  // built from placeholders, and words both languages share ("product owner" is the
  // Scrum role's name in French, as the French copy already says; "Consensus" in French
  // and "Median" in German are those languages' words).
  const SAME_AS_ENGLISH: Record<"fr" | "de", readonly string[]> = {
    fr: [
      "app.name",
      "table.seatCardWord",
      "common.notifications",
      "decks.fib",
      "table.owner",
      "table.ownerTag",
      "results.consensus",
    ],
    de: [
      "app.name",
      "table.seatCardWord",
      "theme.system",
      "dev.hand",
      "decks.fib",
      "results.median",
    ],
  };

  it.each(["fr", "de"] as const)(
    "translates every %s string that is not allowlisted",
    (language) => {
      const english = new Map(leaves(en));
      const same = leaves(CATALOGS[language])
        .filter(([key, value]) => english.get(key) === value)
        .map(([key]) => key);
      expect(same.sort()).toEqual([...SAME_AS_ENGLISH[language]].sort());
    },
  );

  it.each(LANGUAGES)("uses typographic apostrophes, quotes and ellipses in %s", (language) => {
    for (const [key, value] of leaves(CATALOGS[language])) {
      const text = String(value).replace(/{{[^}]*}}/g, "{{}}");
      expect(text, `${language}: ${key}: straight apostrophe, use ’`).not.toMatch(/'/);
      expect(text, `${language}: ${key}: straight quote`).not.toMatch(/"/);
      expect(text, `${language}: ${key}: three dots, use …`).not.toMatch(/\.\.\./);
    }
  });

  it("puts a narrow no-break space inside French guillemets", () => {
    for (const [key, value] of leaves(fr)) {
      const text = String(value);
      expect(text, `fr: ${key}`).not.toMatch(/«(?! )|(?<! )»/);
      expect(text, `fr: ${key}: use « » in French`).not.toMatch(/[“”„]/);
    }
  });

  it("quotes German as „so“", () => {
    for (const [key, value] of leaves(de)) {
      const text = String(value);
      expect(text, `de: ${key}: use „…“ in German`).not.toMatch(/[”«»]/);
      const opening = text.match(/„/g)?.length ?? 0;
      const closing = text.match(/“/g)?.length ?? 0;
      expect(closing, `de: ${key}: every „ closes with “`).toBe(opening);
      expect(text, `de: ${key}: “ before „`).not.toMatch(/^[^„]*“/);
    }
  });
});

describe("translation", () => {
  beforeAll(async () => {
    await loadLanguage("fr");
    await loadLanguage("de");
  });

  it("interpolates variables", () => {
    expect(fixedT("en")("room.title", { code: "abc" })).toBe("Room abc");
    expect(fixedT("fr")("room.title", { code: "abc" })).toBe("Salle abc");
    expect(fixedT("de")("room.title", { code: "abc" })).toBe("Raum abc");
  });

  it("picks the plural form from Intl.PluralRules, French many included", () => {
    const voted = (language: Language, count: number) =>
      fixedT(language)("table.votedSoFar", { count, total: 2_000_000 });
    expect(voted("en", 1)).toBe("1/2,000,000 voted so far");
    expect(voted("fr", 1)).toBe("1/2\u202f000\u202f000 a voté pour l’instant");
    expect(voted("fr", 2)).toBe("2/2\u202f000\u202f000 ont voté pour l’instant");
    expect(voted("fr", 1_000_000)).toBe(
      "1\u202f000\u202f000/2\u202f000\u202f000 ont voté pour l’instant",
    );
    expect(voted("de", 1)).toBe("1/2.000.000 hat bisher abgestimmt");
    expect(voted("de", 6)).toBe("6/2.000.000 haben bisher abgestimmt");
  });

  it("formats numbers in the catalog with the language's decimal mark", () => {
    expect(fixedT("en")("dev.average", { value: 5.5 })).toBe("Average of the numeric cards: 5.5");
    expect(fixedT("fr")("dev.average", { value: 5.5 })).toBe(
      "Moyenne des cartes numériques\u202f: 5,5",
    );
    expect(fixedT("de")("dev.average", { value: 31.25 })).toBe(
      "Durchschnitt der Zahlenkarten: 31,3",
    );
  });
});

describe("error codes", () => {
  beforeAll(async () => {
    await loadLanguage("fr");
    await loadLanguage("de");
  });

  it("covers the protocol's own codes", () => {
    for (const code of PROTOCOL_ERROR_CODES) {
      expect(ACK_ERROR_CODES).toContain(code);
    }
  });

  it.each(LANGUAGES)("has a message for every code the server can send, in %s", (language) => {
    const t = fixedT(language);
    const fallback = t("errors.unknown");
    for (const code of ACK_ERROR_CODES) {
      expect(isKnownErrorCode(code), code).toBe(true);
      const message = errorMessage(t, code);
      expect(message, `${language}: ${code}`).not.toBe(fallback);
      expect(message, `${language}: ${code}`).not.toContain("errors.");
      expect(message.trim(), `${language}: ${code}`).not.toBe("");
    }
  });

  it("holds no message for a code the protocol does not list", () => {
    const listed = new Set<string>([...ACK_ERROR_CODES, "unknown"]);
    for (const code of Object.keys(en.errors)) {
      expect(listed.has(code), code).toBe(true);
    }
  });

  it("falls back to a generic message for an unknown code", () => {
    const t = fixedT("fr");
    for (const code of ["no_such_code", "unknown", "toString", "__proto__", ""]) {
      expect(errorMessage(t, code), code).toBe(fr.errors.unknown);
    }
    expect(errorMessage(fixedT("en"), "room_full")).toBe(en.errors.room_full);
  });
});

describe("language choice", () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    window.localStorage.clear();
    await changeLanguage("en");
  });

  it.each([
    [["fr-CH", "en"], "fr"],
    [["de-AT"], "de"],
    [["DE"], "de"],
    [["it-IT", "de-CH", "fr"], "de"],
    [["es", "pt-BR"], "en"],
    [["gsw-CH", "en"], "de"],
    [["fr_CA"], "fr"],
    [[], "en"],
  ] as const)("picks from the browser's %j: %s", (preferences, expected) => {
    expect(pickLanguage(preferences)).toBe(expected);
  });

  it("prefers the saved choice over the browser's languages", () => {
    vi.spyOn(window.navigator, "languages", "get").mockReturnValue(["fr-FR", "en"]);
    expect(detectLanguage()).toBe("fr");
    window.localStorage.setItem(LANGUAGE_STORAGE_KEY, "de");
    expect(detectLanguage()).toBe("de");
    window.localStorage.setItem(LANGUAGE_STORAGE_KEY, "klingon");
    expect(detectLanguage()).toBe("fr");
  });

  it("survives storage that throws", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(readSavedLanguage()).toBeNull();
    await chooseLanguage("de");
    expect(currentLanguage()).toBe("de");
  });

  it("saves a choice, applies it to <html lang>, and starts in it next time", async () => {
    await chooseLanguage("fr");
    expect(currentLanguage()).toBe("fr");
    expect(document.documentElement.lang).toBe("fr");
    expect(window.localStorage.getItem(LANGUAGE_STORAGE_KEY)).toBe("fr");
    await changeLanguage("en");
    expect(document.documentElement.lang).toBe("en");
    await startLanguage();
    expect(currentLanguage()).toBe("fr");
  });
});
