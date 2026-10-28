import { parse } from "csv-parse/sync";
import { marked } from "marked";
import { beforeAll, describe, expect, it } from "vitest";
import { fixedT, loadLanguage } from "../i18n/i18n.ts";
import type { Language } from "../i18n/language.ts";
import {
  csvSeparator,
  type ExportContext,
  exportFileName,
  isoWithOffset,
  keyLines,
  markdownText,
  roundKey,
  toCsv,
  toMarkdown,
} from "./exports.ts";
import { keyLabel } from "./subject.ts";
import { type ExportRound, exportRounds } from "./summary.ts";

const AT = new Date(2026, 9, 28, 14, 5, 9).getTime();

const stats = (over: Partial<ExportRound["stats"]> = {}): ExportRound["stats"] => ({
  distribution: [],
  core: [],
  mode: null,
  agreement: 0,
  spread: null,
  consensus: false,
  average: null,
  median: null,
  suggested: null,
  ...over,
});

function round(
  number: number,
  subject: ExportRound["subject"],
  final: string | null,
  over: Partial<ExportRound> = {},
): ExportRound {
  return {
    number,
    subject,
    final,
    stats: stats(),
    startedAt: AT - 135_000,
    revealedAt: AT - 60_000,
    finishedAt: AT,
    ...over,
  };
}

const JIRA = "https://acme.atlassian.net/browse/PAY-482";
const ADO = "https://dev.azure.com/acme/shop/_workitems/edit/4521";
const TRICKY = 'Search "fast", cheap; really | `now` 🚀\nsecond line';

const ROUNDS: ExportRound[] = [
  round(1, { kind: "link", url: JIRA, key: "PAY-482" }, "5", {
    stats: stats({
      distribution: [
        { card: "3", count: 1 },
        { card: "5", count: 2 },
        { card: "☕", count: 1 },
      ],
      core: ["3", "5", "5"],
      mode: "5",
      agreement: 2 / 3,
      average: 13 / 3,
      median: 5,
      suggested: "5",
    }),
  }),
  round(2, { kind: "title", text: TRICKY }, "M", {
    stats: stats({
      distribution: [
        { card: "M", count: 1 },
        { card: "L", count: 1 },
      ],
      core: ["M", "L"],
      mode: "M",
      agreement: 0.5,
      suggested: "M",
    }),
  }),
  round(3, { kind: "title", text: "PAY-17 Checkout" }, "0.5", {
    stats: stats({
      distribution: [{ card: "0.5", count: 2 }],
      core: ["0.5", "0.5"],
      agreement: 1,
      average: 0.5,
      median: 0.5,
      suggested: "0.5",
    }),
  }),
  round(4, { kind: "title", text: '=HYPERLINK("http://evil","x")' }, null),
  round(5, { kind: "title", text: "+1 for -2" }, "8"),
  round(6, { kind: "title", text: "-2+3" }, null),
  round(7, { kind: "title", text: "@SUM(A1)" }, null),
  round(8, { kind: "title", text: "\tTabbed" }, null),
  round(9, { kind: "link", url: ADO, key: "4521" }, "13"),
  round(10, { kind: "none" }, null),
  round(11, { kind: "link", url: "https://example.com/(docs)|x" }, "2"),
];

beforeAll(async () => {
  await loadLanguage("fr");
  await loadLanguage("de");
});

function context(language: Language, over: Partial<ExportContext> = {}): ExportContext {
  const locale = { en: "en-US", fr: "fr-FR", de: "de-DE" }[language];
  return {
    t: fixedT(language),
    language,
    locale,
    roomName: "Team Sky",
    range: "all",
    now: AT,
    ...over,
  };
}

/** The CSV as a spreadsheet reads it: a real parser, told the separator. */
function parsed(csv: string, delimiter: string): string[][] {
  return parse(csv, { bom: true, delimiter, relax_column_count: false }) as string[][];
}

describe("the CSV", () => {
  it("starts with a byte order mark and ends every record with CRLF", () => {
    const csv = toCsv(ROUNDS, context("en"));
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    expect(csv.endsWith("\r\n")).toBe(true);
    // Outside quoted cells every line feed follows a carriage return.
    const outside = csv.replace(/"(?:[^"]|"")*"/g, "");
    expect(outside).not.toMatch(/[^\r]\n/);
    expect(outside.split("\r\n")).toHaveLength(ROUNDS.length + 2);
  });

  it("separates with a comma in English and writes numbers with a point", () => {
    const rows = parsed(toCsv(ROUNDS, context("en")), ",");
    expect(rows[0]).toEqual([
      "Round",
      "Subject",
      "Key",
      "Final estimate",
      "Suggested card",
      "Agreement (%)",
      "Average",
      "Median",
      "Votes",
      "Voting time (s)",
      "Ended",
    ]);
    expect(rows).toHaveLength(ROUNDS.length + 1);
    for (const row of rows) expect(row).toHaveLength(11);
    expect(rows[1]).toEqual([
      "1",
      JIRA,
      "PAY-482",
      "5",
      "5",
      "67",
      "4.33",
      "5",
      "4",
      "75",
      isoWithOffset(AT),
    ]);
    expect(rows[3]?.slice(2, 8)).toEqual(["PAY-17", "0.5", "0.5", "100", "0.5", "0.5"]);
  });

  it.each([
    ["fr", "Tour", "Estimation finale"],
    ["de", "Runde", "Endgültige Schätzung"],
  ] as const)(
    "separates with a semicolon in %s and writes a decimal comma",
    (language, first, final) => {
      const csv = toCsv(ROUNDS, context(language));
      const rows = parsed(csv, ";");
      expect(rows[0]?.[0]).toBe(first);
      expect(rows[0]?.[3]).toBe(final);
      for (const row of rows) expect(row).toHaveLength(11);
      expect(rows[1]?.slice(5, 8)).toEqual(["67", "4,33", "5"]);
      expect(rows[3]?.slice(3, 5)).toEqual(["0,5", "0,5"]);
      // A comma inside a number never splits a cell: the semicolon does.
      expect(csv).toContain(";4,33;");
    },
  );

  it("keeps quotes, commas, semicolons, pipes, backticks, emoji and line breaks in a subject", () => {
    for (const language of ["en", "fr"] as const) {
      const rows = parsed(toCsv(ROUNDS, context(language)), language === "en" ? "," : ";");
      expect(rows[2]?.[1]).toBe(TRICKY);
      expect(rows[2]?.[3]).toBe("M");
      // No number: no average, no median.
      expect(rows[2]?.slice(6, 8)).toEqual(["", ""]);
    }
  });

  it("defuses a subject that a spreadsheet would run as a formula", () => {
    const rows = parsed(toCsv(ROUNDS, context("en")), ",");
    expect(rows[4]?.[1]).toBe('\'=HYPERLINK("http://evil","x")');
    expect(rows[5]?.[1]).toBe("'+1 for -2");
    expect(rows[6]?.[1]).toBe("'-2+3");
    expect(rows[7]?.[1]).toBe("'@SUM(A1)");
    expect(rows[8]?.[1]).toBe("'\tTabbed");
    // Numbers we wrote are not touched; a round without anything leaves its cells empty.
    expect(rows[10]?.slice(0, 8)).toEqual(["10", "", "", "", "", "", "", ""]);
  });

  it("writes the end as ISO 8601 with the offset, the same instant", () => {
    const iso = isoWithOffset(AT);
    expect(iso).toMatch(/^2026-10-28T14:05:09[+-]\d\d:\d\d$/);
    expect(Date.parse(iso)).toBe(AT);
  });

  it.each([
    ["en", "en-US", ",", "4.33"],
    ["en", "en-ZA", ";", "4,33"],
    ["fr", "fr-FR", ";", "4,33"],
    ["de", "de-DE", ";", "4,33"],
    ["de", "de-CH", ";", "4.33"],
  ] as const)(
    "in %s with %s numbers, separates with %s and writes %s",
    (language, locale, separator, average) => {
      expect(csvSeparator(language, locale)).toBe(separator);
      const csv = toCsv(ROUNDS, context(language, { locale }));
      const rows = parsed(csv, separator);
      for (const row of rows) expect(row).toHaveLength(11);
      expect(rows[1]?.[6]).toBe(average);
      expect(csv).toContain(`${separator}${average}${separator}`);
    },
  );

  it("quotes a subject that holds the separator and nothing else to quote", () => {
    const rounds = [
      round(1, { kind: "title", text: "Login, logout" }, "3"),
      round(2, { kind: "title", text: "Search; filters" }, "5"),
    ];
    const english = toCsv(rounds, context("en"));
    expect(english).toContain('"Login, logout"');
    expect(english).toContain(",Search; filters,");
    expect(parsed(english, ",").map((row) => row[1])).toEqual([
      "Subject",
      "Login, logout",
      "Search; filters",
    ]);
    const french = toCsv(rounds, context("fr"));
    expect(french).toContain('"Search; filters"');
    expect(french).toContain(";Login, logout;");
    expect(parsed(french, ";").map((row) => row[1])).toEqual([
      "Sujet",
      "Login, logout",
      "Search; filters",
    ]);
  });

  it("defuses the full-width and small forms of = + - @ too", () => {
    const rounds = [
      round(1, { kind: "title", text: "\u{FF1D}1+1" }, null),
      round(2, { kind: "title", text: "\u{FF0B}cmd" }, null),
      round(3, { kind: "title", text: "\u{FE66}SUM(A1)" }, null),
      round(4, { kind: "title", text: "\u{FF20}x" }, null),
      round(5, { kind: "title", text: "\u{FF0D}2" }, null),
      round(6, { kind: "title", text: "Plain \u{FF1D}" }, null),
    ];
    const subjects = parsed(toCsv(rounds, context("en")), ",")
      .slice(1)
      .map((row) => row[1]);
    expect(subjects).toEqual([
      "'\u{FF1D}1+1",
      "'\u{FF0B}cmd",
      "'\u{FE66}SUM(A1)",
      "'\u{FF20}x",
      "'\u{FF0D}2",
      "Plain \u{FF1D}",
    ]);
  });

  it("has no names and no per-person cards: only round-level columns", () => {
    // History rows with names and per-person cards, as the server sends them.
    const named = ROUNDS.map((one, i) => ({
      ...one,
      votes: {
        kind: "named" as const,
        votes: [
          { name: "Anastasia", card: "Kx" },
          { name: "Benedikt", card: i % 2 === 0 ? "Qy" : "Jz" },
        ],
      },
    }));
    const rows = exportRounds(named, null);
    expect(rows.every((one) => !("votes" in one))).toBe(true);
    for (const text of [
      toCsv(rows, context("en")),
      toMarkdown(rows, context("en")),
      keyLines(rows).text,
      // Even rows that kept their votes never write them.
      toCsv(named, context("en")),
      toMarkdown(named, context("en")),
      keyLines(named).text,
    ]) {
      expect(text).not.toMatch(/Anastasia|Benedikt|Kx|Qy|Jz/);
    }
  });
});

/** Every table row's cells, from the HTML a GFM parser makes of the Markdown. */
function tableOf(markdown: string): { html: string; rows: string[][] } {
  const html = marked.parse(markdown, { gfm: true, async: false });
  const rows = [...html.matchAll(/<tr>([\s\S]*?)<\/tr>/g)].map((match) =>
    [...String(match[1]).matchAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/g)].map((cell) =>
      String(cell[1]),
    ),
  );
  return { html, rows };
}

describe("the Markdown", () => {
  it("renders as a table with a heading and the summary", () => {
    const { html, rows } = tableOf(toMarkdown(ROUNDS, context("en")));
    expect(html).toContain("<h1>Poker Planning: Team Sky</h1>");
    expect(html).toContain("<li>Rounds: 11</li>");
    expect(html).toContain("<li>Total of final estimates: 28.5</li>");
    expect(html).toContain("<li>6 rounds without a numeric estimate</li>");
    expect(rows).toHaveLength(ROUNDS.length + 1);
    for (const row of rows) expect(row).toHaveLength(11);
    expect(rows[0]?.[0]).toBe("Round");
    // The agreement cells carry their "%", so the column is named without it.
    expect(rows[0]?.[5]).toBe("Agreement");
    expect(rows[1]?.slice(2, 8)).toEqual(["PAY-482", "5", "5", "67%", "4.33", "5"]);
  });

  it("escapes pipes, backticks and line breaks, and keeps links as links", () => {
    const { html, rows } = tableOf(toMarkdown(ROUNDS, context("en")));
    expect(rows[2]?.[1]).toBe("Search &quot;fast&quot;, cheap; really | `now` 🚀<br>second line");
    expect(html).not.toContain("<code>");
    expect(rows[1]?.[1]).toBe(`<a href="${JIRA}">PAY-482</a>`);
    // An Azure DevOps id reads as its chip does: a number sign, then the id.
    expect(rows[9]?.[1]).toBe(`<a href="${ADO}">${keyLabel("4521")}</a>`);
    expect(keyLabel("4521")).toMatch(/^.4521$/);
    // A link whose address holds ( ) or | stays one link in one cell.
    expect(rows[11]?.[1]).toBe(
      '<a href="https://example.com/%28docs%29%7Cx">example.com/(docs)|x</a>',
    );
    expect(markdownText("a|b`c\nd")).toBe("a\\|b\\`c<br>d");
  });

  it("follows the interface language and names a room without a name plainly", () => {
    const { html, rows } = tableOf(
      toMarkdown(ROUNDS, context("fr", { roomName: null, range: "today" })),
    );
    expect(html).toContain("<h1>Poker Planning</h1>");
    expect(html).toContain("Tours terminés le 28 octobre 2026");
    expect(rows[0]?.[0]).toBe("Tour");
    expect(rows[1]?.[6]).toBe("4,33");
    const german = tableOf(toMarkdown(ROUNDS, context("de"))).html;
    expect(german).toContain("<h1>Poker Planning: Team Sky</h1>");
    expect(german).toContain("<li>Summe der Endschätzungen: 28,5</li>");
  });

  it("escapes a room name that looks like Markdown", () => {
    const { html } = tableOf(toMarkdown(ROUNDS, context("en", { roomName: "*Sky* | <b>" })));
    expect(html).toContain("<h1>Poker Planning: *Sky* | &lt;b&gt;</h1>");
  });

  it("keeps an @ from mentioning anyone on GitHub", () => {
    const rounds = [round(1, { kind: "title", text: "Ask @octocat about @team/web" }, "3")];
    const markdown = toMarkdown(rounds, context("en", { roomName: "@channel" }));
    expect(markdown).toContain("Ask \\@octocat about \\@team/web");
    expect(markdown).toContain("# Poker Planning: \\@channel");
    // Every @ in the text is escaped.
    expect(markdown).not.toMatch(/(^|[^\\])@/);
    // Rendered, the text reads as typed.
    expect(tableOf(markdown).rows[1]?.[1]).toBe("Ask @octocat about @team/web");
  });

  it("writes a link it would not open as plain text, never as a link", () => {
    const rounds = [
      round(1, { kind: "link", url: "javascript:alert(1)" }, "3"),
      round(2, { kind: "link", url: "data:text/html,<b>x</b>" }, "5"),
    ];
    const { html, rows } = tableOf(toMarkdown(rounds, context("en")));
    expect(html).not.toContain("<a ");
    expect(html).not.toMatch(/href="(javascript|data):/);
    expect(rows[1]?.[1]).not.toBe("");
  });
});

describe("the lines for Jira or Azure DevOps", () => {
  it("reads a key from a link, or from the very start of a title", () => {
    expect(roundKey({ subject: { kind: "link", url: JIRA, key: "PAY-482" } })).toBe("PAY-482");
    expect(roundKey({ subject: { kind: "link", url: "https://example.com" } })).toBeNull();
    expect(roundKey({ subject: { kind: "title", text: "PAY-17 Checkout" } })).toBe("PAY-17");
    expect(roundKey({ subject: { kind: "title", text: "PAY-17: Checkout" } })).toBe("PAY-17");
    expect(roundKey({ subject: { kind: "title", text: "PAY-17" } })).toBe("PAY-17");
    expect(roundKey({ subject: { kind: "title", text: "Fix PAY-17" } })).toBeNull();
    expect(roundKey({ subject: { kind: "title", text: "PAY-17b" } })).toBeNull();
    expect(roundKey({ subject: { kind: "title", text: "pay-17 lower" } })).toBeNull();
    expect(roundKey({ subject: { kind: "title", text: "PAY-017" } })).toBeNull();
    expect(roundKey({ subject: { kind: "none" } })).toBeNull();
  });

  it("copies one line per round with a key and a final, in round order", () => {
    expect(keyLines(ROUNDS)).toEqual({
      text: "PAY-482 5\nPAY-17 0.5\n4521 13",
      lines: 3,
      skipped: ROUNDS.length - 3,
    });
    expect(keyLines([])).toEqual({ text: "", lines: 0, skipped: 0 });
  });

  it("keeps the latest round of a key: a re-vote replaces the estimate", () => {
    const pay = { kind: "title", text: "PAY-17 Checkout" } as const;
    const lines = keyLines([
      // "Record 5", "Vote again", "Record 8".
      round(1, pay, "5"),
      round(2, { kind: "link", url: JIRA, key: "PAY-482" }, "3"),
      round(3, pay, "8"),
      // A key whose latest round has no final gets no line.
      round(4, { kind: "link", url: ADO, key: "4521" }, "13"),
      round(5, { kind: "link", url: ADO, key: "4521" }, null),
      round(6, { kind: "none" }, "2"),
    ]);
    expect(lines).toEqual({ text: "PAY-482 3\nPAY-17 8", lines: 2, skipped: 2 });
  });

  it("writes a numeric final as a number with a point, and any other as played", () => {
    const lines = keyLines([
      round(1, { kind: "title", text: "PAY-1 Half" }, "½"),
      round(2, { kind: "title", text: "PAY-2 Size" }, "M"),
      round(3, { kind: "title", text: "PAY-3 Point" }, "0.5"),
    ]);
    expect(lines.text).toBe("PAY-1 0.5\nPAY-2 M\nPAY-3 0.5");
  });
});

describe("the file name", () => {
  it("names the room and the day, safe for any file system, never the code", () => {
    expect(exportFileName("Team Sky / Q4: <Sprint>?", AT, "csv")).toBe(
      "planning-poker-Team-Sky-Q4-Sprint-2026-10-28.csv",
    );
    expect(exportFileName("Équipe café ☕", AT, "md")).toBe(
      "planning-poker-Équipe-café-☕-2026-10-28.md",
    );
    expect(exportFileName(null, AT, "csv")).toBe("planning-poker-room-2026-10-28.csv");
    expect(exportFileName("???", AT, "md")).toBe("planning-poker-room-2026-10-28.md");
    expect(exportFileName(`${"a".repeat(80)}`, AT, "csv")).toBe(
      `planning-poker-${"a".repeat(60)}-2026-10-28.csv`,
    );
  });
});
