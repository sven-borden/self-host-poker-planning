import { cardValue } from "@pp/domain";
import { formatDate, formatNumber } from "../i18n/format.ts";
import type { TFunction } from "../i18n/i18n.ts";
import type { Language } from "../i18n/language.ts";
import { shortDuration, splitSeconds, votingTime } from "./history-view.ts";
import { keyLabel, safeHref, shortUrl } from "./subject.ts";
import { type ExportRound, type Range, type Summary, summarize, voteCount } from "./summary.ts";

// The exports (#34): a CSV file, a Markdown table, and "KEY estimate" lines for Jira or
// Azure DevOps. A chunk of its own, loaded when someone opens the export menu. Round level
// only: an `ExportRound` carries no votes, so no name and no person's card can reach a
// file. The room's code never appears either: not in a file name, not in a file.

/** What every export needs besides the rounds, read when the person picks one. */
export interface ExportContext {
  t: TFunction;
  /** The interface language: the CSV's separator follows it. */
  language: Language;
  /** The locale numbers and dates follow (`localeFor(language)`, the reader's region). */
  locale: string;
  /** The room's name; null for a room without one. */
  roomName: string | null;
  range: Range;
  /** When the export is made (epoch ms): the file's date and "today". */
  now: number;
}

/**
 * The CSV separator: a comma in English; a semicolon in French and German, whose numbers
 * use a decimal comma (and whose spreadsheets expect a semicolon).
 */
export function csvSeparator(language: Language): "," | ";" {
  return language === "en" ? "," : ";";
}

/** A Jira key at the very start of a title, as a person types it: "PAY-482 Checkout". */
const TITLE_KEY = /^([A-Z][A-Z0-9_]{1,31}-[1-9][0-9]{0,9})(?![\p{L}\p{N}_-])/u;

/**
 * A round's issue key: its link's (read by the server, #21), or a Jira key at the very
 * start of its title; else null.
 */
export function roundKey(round: Pick<ExportRound, "subject">): string | null {
  const { subject } = round;
  if (subject.kind === "link") return subject.key ?? null;
  if (subject.kind === "title") return TITLE_KEY.exec(subject.text)?.[1] ?? null;
  return null;
}

/** "2026-10-28T14:05:09+01:00": local time with its offset, as ISO 8601 writes it. */
export function isoWithOffset(at: number): string {
  const date = new Date(at);
  const two = (n: number) => String(n).padStart(2, "0");
  const offset = -date.getTimezoneOffset();
  const sign = offset < 0 ? "-" : "+";
  const abs = Math.abs(offset);
  return (
    `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())}` +
    `T${two(date.getHours())}:${two(date.getMinutes())}:${two(date.getSeconds())}` +
    `${sign}${two(Math.floor(abs / 60))}:${two(abs % 60)}`
  );
}

/** "2026-10-28", the local date. */
function localDate(at: number): string {
  return isoWithOffset(at).slice(0, 10);
}

/** Characters a file name cannot hold on Windows, macOS or Linux, and invisible ones. */
const UNSAFE_IN_NAME = /[<>:"/\\|?*\p{Cc}\p{Cf}]/gu;
/** At most this many characters of the room's name go into a file name. */
const NAME_IN_FILE = 60;

/**
 * `planning-poker-<room name or "room">-<yyyy-mm-dd>.<extension>`: the name without the
 * characters a file system refuses, spaces as dashes, at most 60 characters. Never the
 * room's code: a room without a name is "room".
 */
export function exportFileName(roomName: string | null, now: number, extension: "csv" | "md") {
  const safe = Array.from(
    (roomName ?? "")
      .normalize("NFC")
      .replace(UNSAFE_IN_NAME, "")
      .trim()
      .replace(/\s+/gu, "-")
      .replace(/-{2,}/g, "-"),
  )
    .slice(0, NAME_IN_FILE)
    .join("")
    .replace(/^[-.]+|[-.]+$/g, "");
  return `planning-poker-${safe === "" ? "room" : safe}-${localDate(now)}.${extension}`;
}

/** The CSV and Markdown columns, in order. */
const COLUMNS = [
  "colRound",
  "colSubject",
  "colKey",
  "colFinal",
  "colSuggested",
  "colAgreement",
  "colAverage",
  "colMedian",
  "colVotes",
  "colSeconds",
  "colEnded",
] as const;

/** A cell a spreadsheet would run as a formula: it starts with = + - @, a tab or a CR. */
const FORMULA_START = /^[=+\-@\t\r]/;
/** A cell RFC 4180 quotes, besides one holding the separator: a quote or a line break. */
const NEEDS_QUOTES = /["\r\n]/;

/** One CSV cell: text is defused against formulas; numbers we wrote are left as they are. */
type Cell = { text: string } | { number: string } | null;

function csvField(cell: Cell, separator: string): string {
  if (cell === null) return "";
  const value =
    "number" in cell ? cell.number : FORMULA_START.test(cell.text) ? `'${cell.text}` : cell.text;
  return NEEDS_QUOTES.test(value) || value.includes(separator)
    ? `"${value.replaceAll('"', '""')}"`
    : value;
}

/**
 * The CSV: UTF-8 with a byte order mark (Excel then reads the accents and emoji), CRLF
 * line ends, RFC 4180 quoting. A comma between cells in English, a semicolon in French
 * and German, and numbers in the interface language without grouping ("5,5" in French).
 * A text cell that starts with = + - @, a tab or a carriage return gets a leading `'`, so
 * a subject never runs as a formula. The end time is ISO 8601 with its offset.
 */
export function toCsv(rounds: readonly ExportRound[], context: ExportContext): string {
  const { t, language, locale } = context;
  const separator = csvSeparator(language);
  const number = (value: number, digits = 2): Cell => ({
    number: formatNumber(value, locale, { useGrouping: false, maximumFractionDigits: digits }),
  });
  const card = (label: string | null): Cell => {
    if (label === null) return null;
    const value = cardValue(label);
    return value === null ? { text: label } : number(value);
  };
  const header: Cell[] = COLUMNS.map((column) => ({ text: t(`exports.${column}`) }));
  const rows = rounds.map((round): Cell[] => {
    const { stats } = round;
    const subject = round.subject;
    const key = roundKey(round);
    return [
      number(round.number),
      subject.kind === "title"
        ? { text: subject.text }
        : subject.kind === "link"
          ? { text: subject.url }
          : null,
      key === null ? null : { text: key },
      card(round.final),
      card(stats.suggested),
      stats.core.length > 0 ? number(stats.agreement * 100, 0) : null,
      stats.average === null ? null : number(stats.average),
      stats.median === null ? null : number(stats.median),
      number(voteCount(round)),
      number(votingTime(round).total),
      { text: isoWithOffset(round.finishedAt) },
    ];
  });
  const lines = [header, ...rows].map((row) =>
    row.map((cell) => csvField(cell, separator)).join(separator),
  );
  return `\u{FEFF}${lines.join("\r\n")}\r\n`;
}

/**
 * Markdown text: backslash before every character Markdown or a GFM table would read
 * (`|` ends a cell, a backtick opens code, `<` opens HTML), line breaks as `<br>`.
 */
export function markdownText(text: string): string {
  return text
    .replace(/[\\`*_[\]<>~|&#!]/g, (character) => `\\${character}`)
    .replace(/\r\n|\r|\n/g, "<br>");
}

/** A link's address inside `(…)`: the characters that would end it or a cell, encoded. */
function markdownUrl(url: string): string {
  return url.replace(
    /[()<>|`\\ ]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`,
  );
}

/** A subject in a Markdown cell: the title, or a link named by its key or its short form. */
function markdownSubject(round: ExportRound): string {
  const { subject } = round;
  if (subject.kind === "none") return "";
  if (subject.kind === "title") return markdownText(subject.text);
  const name = markdownText(
    subject.key === undefined ? shortUrl(subject.url) : keyLabel(subject.key),
  );
  const href = safeHref(subject.url);
  return href === null ? name : `[${name}](${markdownUrl(href)})`;
}

/** The summary's lines, in the interface language, for the Markdown heading. */
function summaryLines(summary: Summary, context: ExportContext): string[] {
  const { t, locale } = context;
  const number = (value: number, options?: Intl.NumberFormatOptions) =>
    formatNumber(value, locale, options);
  const item = (label: string, value: string) => `- ${t("exports.item", { label, shown: value })}`;
  const lines = [
    item(t("summary.rounds"), number(summary.rounds)),
    item(t("summary.total"), number(summary.total, { maximumFractionDigits: 2 })),
  ];
  if (summary.withoutNumber > 0) {
    lines.push(`- ${t("summary.withoutNumber", { count: summary.withoutNumber })}`);
  }
  lines.push(
    item(
      t("summary.agreement"),
      summary.agreement === null
        ? t("results.noValue")
        : number(summary.agreement, { style: "percent", maximumFractionDigits: 0 }),
    ),
    item(
      t("summary.votingTime"),
      summary.votingSeconds === null
        ? t("results.noValue")
        : shortDuration(t, splitSeconds(summary.votingSeconds)),
    ),
  );
  return lines;
}

/**
 * The Markdown: a heading with the room's name, the range and the summary, then a
 * GitHub-flavoured table with the CSV's columns. Numbers, the agreement and the end time
 * follow the interface language; links stay links.
 */
export function toMarkdown(rounds: readonly ExportRound[], context: ExportContext): string {
  const { t, locale, roomName, range, now } = context;
  const number = (value: number, options?: Intl.NumberFormatOptions) =>
    formatNumber(value, locale, options);
  const decimal = (value: number | null) =>
    value === null ? "" : number(value, { maximumFractionDigits: 2 });
  const title =
    roomName === null
      ? t("exports.heading")
      : t("exports.headingNamed", { room: markdownText(roomName) });
  const scope =
    range === "all"
      ? t("summary.all")
      : t("exports.rangeToday", { date: formatDate(now, locale, { dateStyle: "long" }) });
  const header = `| ${COLUMNS.map((column) => markdownText(t(`exports.${column}`))).join(" | ")} |`;
  // Numbers to the right: round, agreement, average, median, votes, seconds.
  const right = new Set<string>([
    "colRound",
    "colAgreement",
    "colAverage",
    "colMedian",
    "colVotes",
    "colSeconds",
  ]);
  const rule = `| ${COLUMNS.map((column) => (right.has(column) ? "---:" : "---")).join(" | ")} |`;
  const rows = rounds.map((round) => {
    const { stats } = round;
    const key = roundKey(round);
    const cells = [
      number(round.number),
      markdownSubject(round),
      key === null ? "" : markdownText(key),
      round.final === null ? "" : markdownText(round.final),
      stats.suggested === null ? "" : markdownText(stats.suggested),
      stats.core.length > 0
        ? number(stats.agreement, { style: "percent", maximumFractionDigits: 0 })
        : "",
      decimal(stats.average),
      decimal(stats.median),
      number(voteCount(round)),
      number(votingTime(round).total),
      formatDate(round.finishedAt, locale, { dateStyle: "medium", timeStyle: "short" }),
    ];
    return `| ${cells.join(" | ")} |`;
  });
  return [
    `# ${title}`,
    "",
    markdownText(scope),
    "",
    ...summaryLines(summarize(rounds), context),
    "",
    header,
    rule,
    ...rows,
    "",
  ].join("\n");
}

/** "KEY estimate" lines: the text, how many lines, and how many rounds had no key or no final. */
export interface KeyLines {
  text: string;
  lines: number;
  skipped: number;
}

/**
 * One "KEY estimate" line per round that has a key and a final, in round order:
 * "PAY-482 5", "4521 8". The final is the card as played, whatever the language, since
 * the tools read it as typed.
 */
export function keyLines(rounds: readonly ExportRound[]): KeyLines {
  const lines: string[] = [];
  for (const round of rounds) {
    const key = roundKey(round);
    if (key !== null && round.final !== null) lines.push(`${key} ${round.final}`);
  }
  return { text: lines.join("\n"), lines: lines.length, skipped: rounds.length - lines.length };
}

/** Saves `text` as a file named `name`, through a link the page never shows. */
export function saveFile(text: string, name: string, type: string): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.rel = "noopener";
  link.click();
  // Some browsers start the download after the click returns.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** The CSV file, saved. */
export function downloadCsv(rounds: readonly ExportRound[], context: ExportContext): void {
  saveFile(
    toCsv(rounds, context),
    exportFileName(context.roomName, context.now, "csv"),
    "text/csv;charset=utf-8",
  );
}

/** The Markdown file, saved. */
export function downloadMarkdown(rounds: readonly ExportRound[], context: ExportContext): void {
  saveFile(
    toMarkdown(rounds, context),
    exportFileName(context.roomName, context.now, "md"),
    "text/markdown;charset=utf-8",
  );
}
