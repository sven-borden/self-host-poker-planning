import { describe, expect, it } from "vitest";
import { de } from "./de.ts";
import { en } from "./en.ts";
import { asksForReload } from "./errors.ts";
import { fr } from "./fr.ts";

describe("asksForReload", () => {
  it("is true for exactly the codes whose message says to reload, in every language", () => {
    const words = { en: /reload/i, fr: /rechargez/i, de: /neu laden|laden Sie/i };
    for (const [language, catalog] of [
      ["en", en],
      ["fr", fr],
      ["de", de],
    ] as const) {
      for (const [code, message] of Object.entries(catalog.errors)) {
        expect(asksForReload(code), `${language} ${code}`).toBe(
          code === "unknown" || words[language].test(message),
        );
      }
    }
  });

  it("is true for the browser's own offline, and for a code this version does not know", () => {
    expect(asksForReload("offline")).toBe(true);
    expect(asksForReload("from_the_future")).toBe(true);
    expect(asksForReload("room_full")).toBe(false);
  });
});
