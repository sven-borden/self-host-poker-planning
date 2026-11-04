import { createRoom, type Participant } from "@pp/domain";
import { toSnapshot } from "@pp/protocol";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { RoomSettingsButton } from "../room/settings-button.tsx";
import { useRoomStore } from "../stores/room-store.ts";
import { COPY_LOADERS, COPY_PARTS, type CopyPart } from "./copy-parts.ts";
import { de } from "./de.ts";
import { en } from "./en.ts";
import { fr } from "./fr.ts";
import { changeLanguage, currentLanguage, fixedT, loadCopy } from "./i18n.ts";
import { LANGUAGES, type Language } from "./language.ts";

// The panels' words load with the panels (U6). i18n.test.ts holds the parts to every rule of the
// catalogs; this file holds the split itself and the loading. The test setup has loaded every
// part in English without asking for it, as a page that opened every panel once would have.

vi.mock("../realtime/room-connection.ts", () => ({ sendCommand: vi.fn(), commandSender: vi.fn() }));

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
  cleanup();
  vi.restoreAllMocks();
  useRoomStore.getState().reset();
  await act(() => changeLanguage("en"));
});

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

describe("a panel", () => {
  beforeAll(async () => {
    await import("../room/settings-panel.tsx");
  }, 30_000);

  it("shows once its words are in, in the page's language, never a key or English first", async () => {
    const room = createRoom({ ownerId: "po" });
    const participants: Record<string, Participant> = {
      po: { name: "Pia", role: "voter", joinedAt: 1, connected: true },
    };
    useRoomStore.getState().open("abcdefghij");
    act(() => {
      useRoomStore
        .getState()
        .receive(
          toSnapshot({ ...room, participants }, "po", { code: "abcdefghij", version: 2, now: 0 }),
        );
      useRoomStore.getState().setStatus("live");
    });
    render(<RoomSettingsButton />);
    await act(() => changeLanguage("de"));
    const german = held();
    vi.spyOn(COPY_LOADERS.settings, "de").mockImplementation(() => german.promise);

    const button = document.querySelector<HTMLButtonElement>("[data-settings-open]");
    if (!button) throw new Error("no settings button");
    fireEvent.click(button);
    await settled();
    expect(screen.queryByRole("dialog")).toBeNull();

    german.settle(await import("./parts/settings-de.ts").then(({ copy }) => copy));
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).not.toMatch(/\b(settings|deckField|restriction|password)\.\w/);
    expect(screen.getByRole("switch", { name: "Anonyme Abstimmung" })).toBeTruthy();
  });
});
