import { describe, expect, it } from "vitest";
import { ACCOUNT_DELETE_WORDS, isAccountDeleteWord } from "./account.ts";

describe("the word that deletes an account", () => {
  it("is taken in any of the three languages, whatever its case", () => {
    for (const word of Object.values(ACCOUNT_DELETE_WORDS)) {
      expect(isAccountDeleteWord(word)).toBe(true);
      expect(isAccountDeleteWord(word.toLowerCase())).toBe(true);
      expect(isAccountDeleteWord(`  ${word} `)).toBe(true);
    }
  });

  it("takes an ö typed as two code points", () => {
    expect(isAccountDeleteWord("LÖSCHEN")).toBe(true);
  });

  it("takes nothing else", () => {
    for (const typed of ["", "yes", "DELET", "DELETE ME", "L SCHEN"]) {
      expect(isAccountDeleteWord(typed)).toBe(false);
    }
  });
});
