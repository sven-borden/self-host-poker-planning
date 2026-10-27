import { MAX_TIMER_SECONDS } from "@pp/domain";
import { ACK_ERROR_CODES } from "@pp/protocol";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { errorMessage } from "./errors.ts";
import { fixedT, loadLanguage } from "./i18n.ts";
import {
  LANGUAGE_STORAGE_KEY,
  LANGUAGES,
  languageOf,
  localeFor,
  regionalLocale,
  resetLocales,
} from "./language.ts";

// Our `t` (ADR-012, amended in #9's review): types, interpolation, the reader's region,
// limits in error messages, and the order of language changes when catalogs are slow.

beforeAll(async () => {
  await loadLanguage("fr");
  await loadLanguage("de");
});

describe("t", () => {
  it("checks keys and placeholders at compile time", () => {
    const t = fixedT("en");
    // @ts-expect-error: no such key.
    expect(t("room.nope")).toBe("room.nope");
    // @ts-expect-error: `code` is missing.
    expect(t("room.title")).toBe("Room {{code}}");
    // @ts-expect-error: a misspelt placeholder.
    expect(t("room.title", { cod: "x" })).toBe("Room {{code}}");
    // @ts-expect-error: a `, number` placeholder takes a number.
    t("dev.average", { value: "5" });
    // @ts-expect-error: a plural key needs `count`.
    t("table.votedSoFar", { total: 2 });
    expect(t("table.votedSoFar", { count: 2, total: 3 })).toBe("2/3 voted so far");
  });

  it("inserts values as plain text, once: no markup, no escaping, no second pass", () => {
    expect(fixedT("en")("room.title", { code: "<b>{{code}}</b> &amp;" })).toBe(
      "Room <b>{{code}}</b> &amp;",
    );
  });

  it("formats numbers with the options a placeholder names", () => {
    expect(fixedT("en")("dev.average", { value: 8.666 })).toBe("Average of the numeric cards: 8.7");
  });

  it("returns the same function for a language, so hooks keep a stable t", () => {
    expect(fixedT("fr")).toBe(fixedT("fr"));
  });
});

describe("limits in error messages", () => {
  it("states the domain's limits, formatted for the language", () => {
    const en = fixedT("en");
    expect(errorMessage(en, "bad_name")).toBe(
      "A name needs 1 to 32 characters. Choose another one.",
    );
    expect(errorMessage(en, "bad_seconds")).toBe(
      "A timer runs from 5 seconds to 60 minutes. Pick another length.",
    );
    expect(errorMessage(en, "deck_too_many_cards")).toBe(
      "A deck holds at most 20 cards. Remove some and try again.",
    );
    expect(errorMessage(en, "card_too_long")).toBe(
      "A card label holds at most 4 characters. Shorten it.",
    );
    expect(errorMessage(fixedT("fr"), "bad_seconds")).toContain("de 5 secondes à 60 minutes");
    expect(errorMessage(fixedT("de"), "bad_name")).toBe(
      "Ein Name hat 1 bis 32 Zeichen. Wählen Sie einen anderen.",
    );
  });

  it("shows whole minutes for the longest timer", () => {
    expect(MAX_TIMER_SECONDS % 60).toBe(0);
  });

  it("fills every placeholder of every error message", () => {
    for (const language of LANGUAGES) {
      for (const code of ACK_ERROR_CODES) {
        expect(errorMessage(fixedT(language), code), `${language}: ${code}`).not.toMatch(/{{|}}/);
      }
    }
  });
});

describe("the reader's region", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    resetLocales();
  });

  it.each([
    ["gsw", "de"],
    ["gsw-CH", "de"],
    ["de_CH", "de"],
    ["fr-ch", "fr"],
    ["it-CH", null],
    ["", null],
  ] as const)("reads %s as %s", (tag, language) => {
    expect(languageOf(tag)).toBe(language);
  });

  it.each([
    ["de", ["de-CH", "en"], "de-CH"],
    ["fr", ["de-CH", "fr-CH", "en"], "fr-CH"],
    ["en", ["fr-FR", "en-GB"], "en-GB"],
    ["de", ["gsw"], "de-CH"],
    ["de", ["gsw-LI"], "de-LI"],
    ["de", ["de_AT"], "de-AT"],
    ["fr", ["en-US"], "fr"],
    ["de", ["de-%%", "de-DE"], "de-DE"],
  ] as const)("formats %s for %j as %s", (language, preferences, locale) => {
    expect(regionalLocale(language, preferences)).toBe(locale);
  });

  it("formats with the browser's region when it speaks the UI language", () => {
    vi.spyOn(window.navigator, "languages", "get").mockReturnValue(["de-CH", "fr-CH"]);
    resetLocales();
    expect(localeFor("de")).toBe("de-CH");
    expect(fixedT("de")("dev.average", { value: 6.5 })).toBe("Durchschnitt der Zahlenkarten: 6.5");
    // CLDR groups de-CH with ’; some ICU builds (Node's) use a straight apostrophe.
    expect(fixedT("de")("table.votedSoFar", { count: 1234, total: 2000 })).toMatch(
      /^1[’']234\/2[’']000 haben bisher abgestimmt$/,
    );
    // Swiss French keeps the decimal comma but groups like Swiss German.
    expect(localeFor("fr")).toBe("fr-CH");
    expect(fixedT("fr")("table.votedSoFar", { count: 1234, total: 2000 })).toMatch(
      /^1[’']234\/2[’']000 ont voté pour l’instant$/,
    );
    expect(localeFor("en")).toBe("en");
  });

  it("keeps the decimal comma for French and German readers without a Swiss region", () => {
    vi.spyOn(window.navigator, "languages", "get").mockReturnValue(["en-US"]);
    resetLocales();
    expect(fixedT("de")("dev.average", { value: 5.5 })).toBe("Durchschnitt der Zahlenkarten: 5,5");
    expect(fixedT("fr")("dev.average", { value: 5.5 })).toBe("Moyenne des cartes numériques : 5,5");
    vi.spyOn(window.navigator, "languages", "get").mockReturnValue(["fr-FR", "de-DE"]);
    resetLocales();
    expect(fixedT("de")("dev.average", { value: 5.5 })).toBe("Durchschnitt der Zahlenkarten: 5,5");
    expect(fixedT("fr")("dev.average", { value: 5.5 })).toBe("Moyenne des cartes numériques : 5,5");
  });
});

describe("a slow catalog", () => {
  // A fresh i18n.ts per test, whose French chunk arrives only when released.
  async function withSlowFrench(fail = false) {
    vi.resetModules();
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.doMock("./fr.ts", async () => {
      await gate;
      if (fail) {
        throw new Error("404");
      }
      return vi.importActual<typeof import("./fr.ts")>("./fr.ts");
    });
    const module = await import("./i18n.ts");
    return { ...module, release };
  }

  afterEach(() => {
    vi.doUnmock("./fr.ts");
    vi.resetModules();
    vi.useRealTimers();
    window.localStorage.clear();
    document.documentElement.lang = "en";
  });

  it("applies and saves only the latest pick, whichever catalog lands last", async () => {
    const slow = await withSlowFrench();
    const french = slow.chooseLanguage("fr");
    await slow.chooseLanguage("de");
    expect(slow.currentLanguage()).toBe("de");
    slow.release();
    await french;
    expect(slow.currentLanguage()).toBe("de");
    expect(document.documentElement.lang).toBe("de");
    expect(window.localStorage.getItem(LANGUAGE_STORAGE_KEY)).toBe("de");
  });

  it("drops a superseded pick quietly, even when its catalog fails", async () => {
    const slow = await withSlowFrench(true);
    const french = slow.chooseLanguage("fr");
    await slow.chooseLanguage("en");
    slow.release();
    await expect(french).resolves.toBeUndefined();
    expect(slow.currentLanguage()).toBe("en");
  });

  it("reports a failed pick, so the switcher can say so, and saves nothing", async () => {
    const slow = await withSlowFrench(true);
    const french = slow.chooseLanguage("fr");
    slow.release();
    await expect(french).rejects.toThrow();
    expect(slow.currentLanguage()).toBe("en");
    expect(window.localStorage.getItem(LANGUAGE_STORAGE_KEY)).toBeNull();
  });

  it("starts in English after the timeout, then switches when the catalog lands", async () => {
    window.localStorage.setItem(LANGUAGE_STORAGE_KEY, "fr");
    const slow = await withSlowFrench();
    vi.useFakeTimers();
    const start = slow.startLanguage(3000);
    await vi.advanceTimersByTimeAsync(3000);
    await start;
    expect(slow.currentLanguage()).toBe("en");
    const changed = new Promise<void>((resolve) => {
      slow.subscribe(resolve);
    });
    slow.release();
    await changed;
    expect(slow.currentLanguage()).toBe("fr");
    expect(document.documentElement.lang).toBe("fr");
  });

  it("does not let a late start catalog undo the reader's pick", async () => {
    window.localStorage.setItem(LANGUAGE_STORAGE_KEY, "fr");
    const slow = await withSlowFrench();
    await slow.startLanguage(0);
    await slow.chooseLanguage("de");
    slow.release();
    await slow.loadLanguage("fr");
    await Promise.resolve();
    expect(slow.currentLanguage()).toBe("de");
  });
});
