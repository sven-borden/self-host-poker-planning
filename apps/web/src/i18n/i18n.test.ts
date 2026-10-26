import { describe, expect, it } from "vitest";
import { catalogs, createT, LANGUAGES, pickLanguage } from "./i18n.ts";

function keysOf(value: unknown, prefix = ""): string[] {
  if (typeof value !== "object" || value === null) {
    return [prefix];
  }
  return Object.entries(value).flatMap(([key, child]) =>
    keysOf(child, prefix ? `${prefix}.${key}` : key),
  );
}

describe("catalogs", () => {
  const english = keysOf(catalogs.en).sort();

  it.each(LANGUAGES)(
    "%s has exactly the English keys, each with a non-empty string",
    (language) => {
      const catalog = catalogs[language];
      expect(keysOf(catalog).sort()).toEqual(english);
      for (const key of english) {
        expect(createT(language)(key as never).trim(), `${language}: ${key}`).not.toBe("");
      }
    },
  );

  it("keeps the same interpolation variables in every language", () => {
    const variables = (text: string) => [...text.matchAll(/\{\{\s*(\w+)\s*\}\}/g)].map((m) => m[1]);
    for (const key of english) {
      const reference = variables(createT("en")(key as never));
      for (const language of LANGUAGES) {
        expect(variables(createT(language)(key as never)), `${language}: ${key}`).toEqual(
          reference,
        );
      }
    }
  });
});

describe("pickLanguage", () => {
  it.each([
    [["fr-CH", "en"], "fr"],
    [["de-AT"], "de"],
    [["DE"], "de"],
    [["it-IT", "de-CH", "fr"], "de"],
    [["es", "pt-BR"], "en"],
    [[], "en"],
  ] as const)("%j picks %s", (preferences, expected) => {
    expect(pickLanguage(preferences)).toBe(expected);
  });
});

describe("createT", () => {
  it("interpolates variables", () => {
    expect(createT("en")("room.title", { code: "abc" })).toBe("Room abc");
    expect(createT("fr")("room.title", { code: "abc" })).toBe("Salle abc");
    expect(createT("de")("room.title", { code: "abc" })).toBe("Raum abc");
  });

  it("leaves an unknown variable visible rather than inventing a value", () => {
    expect(createT("en")("room.title")).toBe("Room {{code}}");
  });
});
