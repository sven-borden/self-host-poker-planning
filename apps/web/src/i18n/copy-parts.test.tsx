import { act } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { COPY_LOADERS, COPY_PARTS, type CopyPart } from "./copy-parts.ts";
import { de } from "./de.ts";
import { en } from "./en.ts";
import { fr } from "./fr.ts";
import { changeLanguage, currentLanguage, fixedT, loadCopy } from "./i18n.ts";
import { LANGUAGE_STORAGE_KEY, LANGUAGES, type Language } from "./language.ts";

// The panels' words load with the panels (U6). i18n.test.ts holds the parts to every rule of the
// catalogs; this file holds the split itself and the loading (the panels' buttons waiting for
// their parts: room/panel-copy.test.tsx). The test setup has loaded every part in English without
// asking for it, as a page that opened every panel once would have.

const PLURAL = /_(zero|one|two|few|many|other)$/;

/** Every leaf's dotted key, with its plural suffix taken off. */
function keys(value: unknown, prefix = ""): string[] {
  if (typeof value !== "object" || value === null) return [prefix.replace(PLURAL, "")];
  return [
    ...new Set(
      Object.entries(value).flatMap(([key, child]) =>
        keys(child, prefix ? `${prefix}.${key}` : key),
      ),
    ),
  ];
}

const part = (name: CopyPart, language: Language) => COPY_LOADERS[name][language]();

/** A promise the test settles by hand, to hold a part's load. */
function held() {
  let settle: (copy: object) => void = () => {};
  let fail: (error: Error) => void = () => {};
  const promise = new Promise<object>((resolve, reject) => {
    settle = resolve;
    fail = reject;
  });
  return { promise, settle, fail };
}

/** Lets pending promises and the renders they cause run. */
const settled = () => act(() => new Promise((resolve) => setTimeout(resolve, 0)));

afterEach(async () => {
  vi.restoreAllMocks();
  await act(() => changeLanguage("en"));
});

/**
 * A new i18n module, with nothing loaded but the English catalog and nothing wanted, and the
 * loaders it calls. Nothing it loads reaches the module the rest of this file uses. Only data is
 * imported after it, never a component, so React stays one copy.
 */
async function fresh() {
  vi.resetModules();
  const { COPY_LOADERS: loaders } = await import("./copy-parts.ts");
  return { loaders, ...(await import("./i18n.ts")) };
}

describe("the parts", () => {
  it.each(COPY_PARTS)("%s has every language, each with the English part's keys", async (name) => {
    const english = keys(await part(name, "en")).sort();
    expect(english.length).toBeGreaterThan(0);
    for (const language of LANGUAGES) {
      expect(keys(await part(name, language)).sort(), `${name} in ${language}`).toEqual(english);
    }
  });

  it("puts each key in one place: the catalog or a single part", async () => {
    for (const [language, catalog] of [
      ["en", en],
      ["fr", fr],
      ["de", de],
    ] as const) {
      const places = new Map<string, string>(keys(catalog).map((key) => [key, "the catalog"]));
      for (const name of COPY_PARTS) {
        for (const key of keys(await part(name, language))) {
          expect(places.get(key), `${language}: ${key} in ${name}`).toBeUndefined();
          places.set(key, name);
        }
      }
    }
  });
});

describe("loadCopy", () => {
  it("loads a part in the language the page speaks, and in no other", async () => {
    await act(() => changeLanguage("fr"));
    const loads = LANGUAGES.map((language) => vi.spyOn(COPY_LOADERS.history, language));
    await loadCopy("history");
    expect(loads.map((load) => load.mock.calls.length)).toEqual([0, 1, 0]);
    const french = (await part("history", "fr")) as { history: { lede: string } };
    expect(fixedT("fr")("history.lede")).toBe(french.history.lede);
    // German is not loaded: `t` falls back to English, which the test setup holds.
    expect(fixedT("de")("history.lede")).toBe(fixedT("en")("history.lede"));
  });

  it("brings a panel's part along when the language changes, before the page switches", async () => {
    await act(() => changeLanguage("fr"));
    await loadCopy("history");
    const german = held();
    vi.spyOn(COPY_LOADERS.history, "de").mockImplementation(() => german.promise);
    const switching = changeLanguage("de");
    await settled();
    // The catalog is in, the panel's words are not: the page waits for them, in French.
    expect(currentLanguage()).toBe("fr");
    german.settle(await import("./parts/history-de.ts").then(({ copy }) => copy));
    await act(() => switching);
    expect(currentLanguage()).toBe("de");
    expect(fixedT("de")("history.lede")).not.toBe(fixedT("en")("history.lede"));
  });

  it("loads the language picked while a part was on its way before it resolves", async () => {
    await act(() => changeLanguage("de"));
    const german = held();
    vi.spyOn(COPY_LOADERS.sound, "de").mockImplementation(() => german.promise);
    const french = vi.spyOn(COPY_LOADERS.sound, "fr");
    let done = false;
    const loading = loadCopy("sound").then(() => {
      done = true;
    });
    await act(() => changeLanguage("fr"));
    german.settle(await import("./parts/sound-de.ts").then(({ copy }) => copy));
    await loading;
    expect(done).toBe(true);
    expect(french).toHaveBeenCalledTimes(1);
    expect(fixedT("fr")("sound.title")).toBe("Son");
  });

  it("rejects when a part cannot load, and loads it on the next try", async () => {
    await act(() => changeLanguage("de"));
    const load = vi.spyOn(COPY_LOADERS.queue, "de").mockRejectedValueOnce(new Error("offline"));
    await expect(loadCopy("queue")).rejects.toThrow("offline");
    expect(fixedT("de")("queue.lede")).toBe(fixedT("en")("queue.lede"));
    await loadCopy("queue");
    expect(load).toHaveBeenCalledTimes(2);
    expect(fixedT("de")("queue.lede")).not.toBe(fixedT("en")("queue.lede"));
  });
});

describe("loading, from a new page", () => {
  it("keeps the language when a wanted part fails on a change, and switches on the next try", async () => {
    const i18n = await fresh();
    await i18n.changeLanguage("fr");
    await i18n.loadCopy("history");
    const german = vi.spyOn(i18n.loaders.history, "de").mockRejectedValueOnce(new Error("offline"));
    await expect(i18n.changeLanguage("de")).rejects.toThrow("offline");
    expect(i18n.currentLanguage()).toBe("fr");
    await expect(i18n.changeLanguage("de")).resolves.toBe(true);
    expect(i18n.currentLanguage()).toBe("de");
    expect(german).toHaveBeenCalledTimes(2);
  });

  // The switch's last look at the wanted parts and its change of language run in one turn: a
  // part that lands in between (in English, the page's language until then) is not left behind.
  // Each run moves the English part's landing by a microtask, from well before the switch starts
  // to well after it ends.
  it("never switches without a part a panel asked for while the switch looked", async () => {
    const english = await import("./parts/my-rooms-en.ts").then(({ copy }) => copy);
    const french = await import("./parts/my-rooms-fr.ts").then(({ copy }) => copy);
    for (let offset = -8; offset <= 8; offset += 1) {
      const i18n = await fresh();
      // The catalog first, so the switch below waits on nothing but microtasks.
      await i18n.loadLanguage("fr");
      const part = held();
      vi.spyOn(i18n.loaders.myRooms, "en").mockImplementation(() => part.promise);
      vi.spyOn(i18n.loaders.myRooms, "fr").mockResolvedValue(french);
      const asked = i18n.loadCopy("myRooms");
      let switching = Promise.resolve(false);
      const land = () => part.settle(english);
      const change = () => {
        switching = i18n.changeLanguage("fr");
      };
      // -1: the part lands, then the switch starts in the same turn; 0: the other way round.
      const [first, then] = offset < 0 ? [land, change] : [change, land];
      first();
      for (let tick = 0; tick < (offset < 0 ? -offset - 1 : offset); tick += 1) {
        await Promise.resolve();
      }
      then();
      await Promise.all([asked, switching]);
      expect(i18n.currentLanguage()).toBe("fr");
      expect(i18n.fixedT("fr")("myRooms.signedOut"), `offset ${offset}`).toBe(
        french.myRooms.signedOut,
      );
    }
  });

  describe("a page that starts in French", () => {
    afterEach(() => localStorage.removeItem(LANGUAGE_STORAGE_KEY));

    it("fetches a part it asks for while the catalog loads in French alone, beside it", async () => {
      localStorage.setItem(LANGUAGE_STORAGE_KEY, "fr");
      const i18n = await fresh();
      const english = vi.spyOn(i18n.loaders.myRooms, "en");
      const french = vi.spyOn(i18n.loaders.myRooms, "fr");
      const started = i18n.startLanguage();
      // As main.tsx does: the router's loader runs in the same turn as the start.
      const asked = i18n.loadCopy("myRooms");
      expect(french).toHaveBeenCalledTimes(1);
      await Promise.all([started, asked]);
      expect(i18n.currentLanguage()).toBe("fr");
      expect(english).not.toHaveBeenCalled();
      expect(french).toHaveBeenCalledTimes(1);
    });

    it("still speaks French when that part fails: only its page fails", async () => {
      localStorage.setItem(LANGUAGE_STORAGE_KEY, "fr");
      const i18n = await fresh();
      const english = vi.spyOn(i18n.loaders.myRooms, "en");
      vi.spyOn(i18n.loaders.myRooms, "fr").mockRejectedValue(new Error("offline"));
      const started = i18n.startLanguage();
      const asked = i18n.loadCopy("myRooms");
      await expect(asked).rejects.toThrow("offline");
      await started;
      expect(i18n.currentLanguage()).toBe("fr");
      expect(english).not.toHaveBeenCalled();
    });
  });
});
