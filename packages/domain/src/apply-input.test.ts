/**
 * The text rules behind names, round titles and room names (`cleanText` through
 * `cleanName` and `cleanSubject`): nothing invisible, nothing that reorders the text
 * around it, nothing blank. Examples first, then properties over arbitrary strings.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { cleanName, cleanSubject } from "./apply-input.ts";

/** Default-ignorable and bidi control characters that must never pass inside a name. */
const HIDDEN = [
  "\u{AD}", // soft hyphen
  "\u{34F}", // combining grapheme joiner
  "\u{61C}", // Arabic letter mark
  "\u{115F}", // Hangul choseong filler
  "\u{1160}", // Hangul jungseong filler
  "\u{180E}", // Mongolian vowel separator
  "\u{200B}", // zero-width space
  "\u{200E}", // left-to-right mark
  "\u{200F}", // right-to-left mark
  "\u{202A}", // left-to-right embedding
  "\u{202E}", // right-to-left override
  "\u{2060}", // word joiner
  "\u{2066}", // left-to-right isolate
  "\u{2069}", // pop directional isolate
  "\u{3164}", // Hangul filler
  "\u{FE00}", // variation selector 1
  "\u{FE0E}", // text presentation selector
  "\u{FEFF}", // zero-width no-break space
  "\u{FFA0}", // halfwidth Hangul filler
  "\u{E0041}", // tag latin capital A
  "\u{E0100}", // variation selector 17
];

/** Characters that show as nothing on their own. */
const BLANKS = [
  " ",
  "\t",
  "\u{A0}",
  "\u{2003}",
  "\u{2800}",
  "\u{301}",
  "\u{20DD}",
  "\u{200D}",
  "\u{200C}",
];

describe("cleanName", () => {
  it("refuses every default-ignorable or bidi control character inside a name", () => {
    for (const hidden of HIDDEN) {
      expect(cleanName(`Sv${hidden}en`), JSON.stringify(hidden)).toBeNull();
      expect(cleanName(`${hidden}Sven`), JSON.stringify(hidden)).toBeNull();
    }
  });

  it("refuses names that show as nothing", () => {
    for (const name of [
      "\u{3164}",
      "\u{2800}",
      "\u{301}",
      "\u{2800}\u{2800} \u{2800}",
      "\u{301}\u{302}",
      " \u{301} ",
      "\u{200D}\u{200D}",
      "\u{200C}",
      "\u{FE0F}",
    ]) {
      expect(cleanName(name), JSON.stringify(name)).toBeNull();
    }
  });

  it("keeps ZWJ, ZWNJ, VS16, emoji flags of tag characters and marks on a base", () => {
    for (const name of [
      "\u{1F468}\u{200D}\u{1F469}\u{200D}\u{1F467} family",
      "\u{2764}\u{FE0F} Ada",
      "\u{645}\u{6CC}\u{200C}\u{62E}\u{648}\u{627}\u{647}\u{645}",
      "\u{1F3F4}\u{E0067}\u{E0062}\u{E0073}\u{E0063}\u{E0074}\u{E007F} Morag",
      "Jos\u{E9}",
      "Jose\u{301}",
      "1\u{FE0F}\u{20E3} first",
      "\u{1F3F3}\u{FE0F}\u{200D}\u{1F308}",
    ]) {
      expect(cleanName(name), JSON.stringify(name)).toBe(name.normalize("NFC"));
    }
  });

  it("refuses tag characters outside an emoji flag", () => {
    expect(cleanName("Ada\u{E0067}\u{E0062}\u{E007F}")).toBeNull();
    expect(cleanName("🏴\u{E0067}\u{E0062}")).toBeNull();
  });

  it("applies the same rules to a round title", () => {
    expect(cleanSubject({ kind: "title", text: "Login\u{200B} page" })).toBeNull();
    expect(cleanSubject({ kind: "title", text: "\u{2800}" })).toBeNull();
    expect(cleanSubject({ kind: "title", text: "Login page 👩\u{200D}💻" })).toEqual({
      kind: "title",
      text: "Login page 👩\u{200D}💻",
    });
  });
});

describe("cleanName properties", () => {
  const anyText = fc.string({ unit: "grapheme", maxLength: 40 });
  // A tag character slipped into a flag would still make a flag: the examples cover tags.
  const hidden = fc.constantFrom(...HIDDEN.filter((c) => c !== "\u{E0041}"));

  it("is null or a short, well-formed, visible text that cleaning leaves unchanged", () => {
    fc.assert(
      fc.property(fc.oneof(anyText, fc.string({ unit: "binary", maxLength: 40 })), (raw) => {
        const name = cleanName(raw);
        if (name === null) return;
        expect(name.isWellFormed()).toBe(true);
        expect(name).toBe(name.trim());
        expect(name.replace(/[\s\p{Cf}\u{2800}\p{M}]/gu, "")).not.toBe("");
        expect(/[\p{Cc}\p{Bidi_Control}]/u.test(name)).toBe(false);
        expect(Array.from(name).length).toBeGreaterThan(0);
        expect(cleanName(name)).toBe(name);
      }),
    );
  });

  it("refuses any name with a hidden character slipped in", () => {
    fc.assert(
      fc.property(anyText, hidden, fc.nat(), (text, hide, at) => {
        const chars = Array.from(`${text}x`);
        const i = at % (chars.length + 1);
        chars.splice(i, 0, hide);
        expect(cleanName(chars.join(""))).toBeNull();
      }),
    );
  });

  it("refuses any name made only of blank characters", () => {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom(...BLANKS), { minLength: 1, maxLength: 20 }),
        (parts) => {
          expect(cleanName(parts.join(""))).toBeNull();
        },
      ),
    );
  });

  it("accepts a visible letter wrapped in allowed invisibles and spaces", () => {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom(" ", "\u{200D}", "\u{FE0F}"), { maxLength: 5 }),
        fc.constantFrom("a", "Ω", "ß", "あ", "😀"),
        (around, letter) => {
          const name = cleanName(`${letter}${around.join("")}`);
          expect(name?.startsWith(letter)).toBe(true);
        },
      ),
    );
  });
});
