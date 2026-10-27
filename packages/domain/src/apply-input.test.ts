/**
 * The text rules behind names, round titles and room names (`cleanText` through
 * `cleanName` and `cleanSubject`): nothing invisible, nothing that reorders the text
 * around it, nothing blank. Examples first, then properties over arbitrary strings.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { cleanName, cleanRoomName, cleanSubject, linkKey } from "./apply-input.ts";
import { MAX_ROOM_NAME_LENGTH } from "./room.ts";

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

  it("keeps Vietnamese, Hindi and Thai names, which stack up to three marks", () => {
    for (const name of [
      "Nguy\u{1EC5}n Th\u{1ECB} Minh Khai",
      // The same name typed with combining marks (NFD) is stored precomposed.
      "Nguye\u{302}\u{303}n Thi\u{323} Minh Khai",
      "\u{928}\u{92E}\u{938}\u{94D}\u{924}\u{947}",
      "\u{915}\u{94D}\u{937}\u{924}\u{94D}\u{930}\u{93F}\u{92F}",
      "\u{939}\u{93F}\u{928}\u{94D}\u{926}\u{940}",
      "\u{E17}\u{E35}\u{E48}\u{E19}\u{E35}\u{E48}",
      "x\u{300}\u{301}\u{302}",
    ]) {
      expect(cleanName(name), JSON.stringify(name)).toBe(name.normalize("NFC"));
    }
  });

  it("refuses more than three combining marks on one character, in a name, a room name and a title", () => {
    const zalgo = `a${"\u{300}\u{301}\u{302}\u{303}\u{304}\u{305}\u{306}\u{307}".repeat(2)}`;
    expect(cleanName(zalgo)).toBeNull();
    expect(cleanRoomName(zalgo.repeat(60))).toBeNull();
    expect(cleanRoomName("Sprint ".concat(zalgo))).toBeNull();
    expect(cleanSubject({ kind: "title", text: zalgo })).toBeNull();
    expect(cleanName("x\u{300}\u{301}\u{302}\u{303}")).toBeNull();
    // A joiner between the marks does not hide them.
    expect(cleanName("x\u{300}\u{200D}\u{301}\u{200C}\u{302}\u{200D}\u{303}")).toBeNull();
    // VS16 does not hide them either, and does not count as a mark.
    expect(cleanName("q\u{300}\u{FE0F}\u{301}\u{FE0F}\u{302}\u{FE0F}\u{303}")).toBeNull();
    expect(cleanName("q\u{FE0F}\u{FE0F}\u{FE0F}\u{FE0F}")).not.toBeNull();
    // The marks of two characters are counted apart.
    expect(cleanName("x\u{300}\u{301}\u{302}y\u{300}\u{301}\u{302}")).not.toBeNull();
  });

  it("applies the same rules to a room name, up to 60 characters", () => {
    expect(MAX_ROOM_NAME_LENGTH).toBe(60);
    expect(cleanRoomName("  Sprint 42\trefinement\n")).toBe("Sprint 42 refinement");
    expect(cleanRoomName("x".repeat(MAX_ROOM_NAME_LENGTH))).toBe("x".repeat(60));
    expect(cleanRoomName("x".repeat(MAX_ROOM_NAME_LENGTH + 1))).toBeNull();
    expect(cleanRoomName("Team\u{202E}lagel")).toBeNull();
    expect(cleanRoomName("\u{3164}")).toBeNull();
    expect(cleanRoomName(42)).toBeNull();
    expect(cleanRoomName("Équipe 👩\u{200D}💻")).toBe("Équipe 👩\u{200D}💻");
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

describe("linkKey", () => {
  it("reads a Jira key from /browse/ and from selectedIssue=, on any host", () => {
    for (const [url, key] of [
      ["https://acme.atlassian.net/browse/ABC-123", "ABC-123"],
      ["https://acme.atlassian.net/browse/ABC-123/", "ABC-123"],
      ["https://acme.atlassian.net/browse/ABC-123?focusedCommentId=7#c7", "ABC-123"],
      ["http://jira.example.com/jira/browse/PAY_2-482", "PAY_2-482"],
      [
        "https://acme.atlassian.net/jira/software/projects/ABC/boards/1?selectedIssue=ABC-9",
        "ABC-9",
      ],
      [
        "https://acme.atlassian.net/secure/RapidBoard.jspa?rapidView=1&selectedIssue=XY-12&q=1",
        "XY-12",
      ],
      ["https://jira.example.com/browse/AB-1234567890", "AB-1234567890"],
    ] as const) {
      expect(linkKey(url), url).toBe(key);
    }
  });

  it("reads an Azure DevOps work item id from dev.azure.com and visualstudio.com", () => {
    for (const [url, key] of [
      ["https://dev.azure.com/acme/Payments/_workitems/edit/12345", "12345"],
      ["https://dev.azure.com/acme/Pay%20ments/_workitems/edit/12345/", "12345"],
      ["https://DEV.AZURE.COM/acme/Payments/_WorkItems/Edit/7?src=x#y", "7"],
      ["https://acme.visualstudio.com/Payments/_workitems/edit/42", "42"],
      ["https://acme.visualstudio.com/DefaultCollection/Payments/_workitems/edit/42", "42"],
    ] as const) {
      expect(linkKey(url), url).toBe(key);
    }
  });

  it("finds nothing in near misses", () => {
    for (const url of [
      "https://example.com/",
      "https://acme.atlassian.net/browse/abc-123",
      "https://acme.atlassian.net/browse/A-1",
      "https://acme.atlassian.net/browse/1AB-2",
      "https://acme.atlassian.net/browse/ABC-0",
      "https://acme.atlassian.net/browse/ABC-012",
      "https://acme.atlassian.net/browse/ABC-",
      "https://acme.atlassian.net/browse/ABC-123x",
      "https://acme.atlassian.net/browse/ABC-123/comments",
      "https://acme.atlassian.net/browsex/ABC-1",
      "https://acme.atlassian.net/browse/ABC-12345678901",
      `https://acme.atlassian.net/browse/A${"B".repeat(32)}-1`,
      "https://acme.atlassian.net/issues?notselectedIssue=ABC-1",
      "https://acme.atlassian.net/issues?selectedIssue=ABC-1x",
      "https://acme.atlassian.net/issues#selectedIssue=ABC-1",
      "https://acme.atlassian.net/x#/browse/ABC-1",
      "https://dev.azure.com.evil.example/acme/Payments/_workitems/edit/12345",
      "https://evil.example/dev.azure.com/acme/Payments/_workitems/edit/12345",
      "https://evil.example/acme/Payments/_workitems/edit/12345",
      "https://dev.azure.com/acme/_workitems/edit/12345",
      "https://dev.azure.com/acme/Payments/team/_workitems/edit/12345",
      "https://dev.azure.com/acme/Payments/_workitems/edit/",
      "https://dev.azure.com/acme/Payments/_workitems/edit/0",
      "https://dev.azure.com/acme/Payments/_workitems/edit/12a",
      "https://dev.azure.com/acme/Payments/_workitems/edit/12345678901",
      "https://dev.azure.com:8443/acme/Payments/_workitems/edit/1",
      "https://acme.visualstudio.com/_workitems/edit/42",
      "https://acme.visualstudio.com.evil.example/Payments/_workitems/edit/42",
      "https://visualstudio.com/Payments/_workitems/edit/42",
      "ftp://acme.atlassian.net/browse/ABC-1",
    ]) {
      expect(linkKey(url), url).toBeNull();
    }
  });

  it("is set by cleanSubject on the link it accepts, and a client's own key is dropped", () => {
    expect(
      cleanSubject({ kind: "link", url: " https://acme.atlassian.net/browse/ABC-1 ", key: "X-1" }),
    ).toEqual({ kind: "link", url: "https://acme.atlassian.net/browse/ABC-1", key: "ABC-1" });
    expect(cleanSubject({ kind: "link", url: "https://example.com/a", key: "X-1" })).toEqual({
      kind: "link",
      url: "https://example.com/a",
    });
    // Refused before any key is read: credentials, another scheme.
    expect(
      cleanSubject({ kind: "link", url: "http://user:pass@x.example/browse/ABC-1" }),
    ).toBeNull();
    expect(cleanSubject({ kind: "link", url: "javascript:alert(1)//browse/ABC-1" })).toBeNull();
    expect(cleanSubject({ kind: "link", url: "data:text/html,/browse/ABC-1" })).toBeNull();
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

  it("accepts up to three combining marks on a base and refuses four or more", () => {
    const marks = fc
      .integer({ min: 0x300, max: 0x36f })
      .filter((code) => code !== 0x34f && code !== 0x344)
      .map((code) => String.fromCodePoint(code));
    fc.assert(
      fc.property(fc.array(marks, { minLength: 1, maxLength: 12 }), (row) => {
        // "q" has no precomposed form, so NFC leaves the marks alone (U+0344 splits in two, U+034F is invisible).
        const name = cleanName(`q${row.join("")}`);
        if (row.length <= 3) expect(name).toBe(`q${row.join("")}`.normalize("NFC"));
        else expect(name).toBeNull();
      }),
    );
  });

  it("keeps Vietnamese names whatever the order of their marks", () => {
    const syllables = [
      "Nguy\u{1EC5}n",
      "Th\u{1ECB}",
      "Minh",
      "Khai",
      "Tr\u{1EA7}n",
      "\u{110}\u{1EE9}c",
    ];
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom(...syllables), { minLength: 1, maxLength: 4 }),
        fc.constantFrom<"NFC" | "NFD">("NFC", "NFD"),
        (parts, form) => {
          const typed = parts.join(" ").normalize(form);
          expect(cleanName(typed)).toBe(typed.normalize("NFC"));
        },
      ),
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
