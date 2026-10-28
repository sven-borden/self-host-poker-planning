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
import type { ExportRound } from "./summary.ts";

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
      expect(csvSeparator(language)).toBe(";");
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
      const rows = parsed(toCsv(ROUNDS, context(language)), csvSeparator(language));
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

  it("has no names and no per-person cards: only round-level columns", () => {
    const csv = toCsv(ROUNDS, context("en"));
    expect(csv).not.toMatch(/Ana|Ben/);
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
    expect(html).toContain("<h1>Planning poker: Team Sky</h1>");
    expect(html).toContain("<li>Rounds: 11</li>");
    expect(html).toContain("<li>Total of final estimates: 28.5</li>");
    expect(html).toContain("<li>6 rounds without a number</li>");
    expect(rows).toHaveLength(ROUNDS.length + 1);
    for (const row of rows) expect(row).toHaveLength(11);
    expect(rows[0]?.[0]).toBe("Round");
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
    expect(html).toContain("<h1>Planning poker</h1>");
    expect(html).toContain("Tours terminés le 28 octobre 2026");
    expect(rows[0]?.[0]).toBe("Tour");
    expect(rows[1]?.[6]).toBe("4,33");
    const german = tableOf(toMarkdown(ROUNDS, context("de"))).html;
    expect(german).toContain("<h1>Planning Poker: Team Sky</h1>");
    expect(german).toContain("<li>Summe der endgültigen Schätzungen: 28,5</li>");
  });

  it("escapes a room name that looks like Markdown", () => {
    const { html } = tableOf(toMarkdown(ROUNDS, context("en", { roomName: "*Sky* | <b>" })));
    expect(html).toContain("<h1>Planning poker: *Sky* | &lt;b&gt;</h1>");
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
