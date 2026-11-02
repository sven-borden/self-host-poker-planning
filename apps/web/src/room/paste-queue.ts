import {
  ADO_ID,
  cleanQueueItem,
  cleanSubject,
  JIRA_KEY,
  keyLabel,
  MAX_MESSAGE_BYTES,
  MAX_QUEUE_BYTES,
  MAX_TITLE_LENGTH,
  type QueueEntry,
  queueBytes,
  queueIdentity,
} from "@pp/domain";

// A paste into the queue (#52, ADR-024): pure, in the page, no network. The text becomes
// items and is forgotten: nothing reads a pasted link, and the raw text goes nowhere. The
// domain's own rules decide what an item may hold (`cleanQueueItem`); this file only finds
// the key, the title and the link in what people put on the clipboard.
//
// Text with a tab is read as a table, as a browser pastes one: tabs between cells, a cell
// that starts with a quote may hold tabs and line breaks and doubles its own quotes. Text
// without a tab that reads as CSV is a table too, with its commas or semicolons. A row of
// one cell, and all other text, is read line by line.

/** The page sends a list in batches of at most this much JSON, under the socket's cap. */
const BATCH_BYTES = MAX_MESSAGE_BYTES - 512;

/** How far down a table its header may be: a line or two of a page may come along. */
const HEADER_SCAN = 5;

/** An id longer than any a room will give, so a paste never counts an item too small. */
const LONGEST_ID = 9_999_999_999;

/** A key ends where no word goes on; then what parts it from a title: "ABC-1: Login". */
const AFTER_KEY = "(?![\\p{L}\\p{N}_-])[\\s:,\\u2013\\u2014-]*(.*)$";
const KEY_AT_START = new RegExp(`^(${JIRA_KEY})${AFTER_KEY}`, "su");
const ADO_AT_START = new RegExp(`^(?:AB)?#(${ADO_ID})${AFTER_KEY}`, "su");
const URL_AT_START = /^(https?:\/\/\S+)(?:\s+[-:|\u2013\u2014]*\s*(.*))?$/isu;
/** What a list leaves at the end of a link: "https://…/ABC-1, https://…/ABC-2". */
const LINK_TAIL = /[,;]+$/;
/** A key alone, as a line writes it: capitals, or a number after `#` or `AB#`. */
const KEY_ALONE = new RegExp(`^(?:${JIRA_KEY}|(?:AB)?#${ADO_ID})$`);
/** A key in a cell: any case, as a person may type it in a sheet. */
const JIRA_CELL = new RegExp(`^${JIRA_KEY}$`, "i");
const ADO_CELL = new RegExp(`^(?:AB)?#?(${ADO_ID})$`);
const WHITESPACE_RUN = /\s+/gu;
/** A list's mark at a line's start, with a task list's box: "- ", "• ", "2. ", "- [ ] ". */
const BULLET = /^(?:[-*+\u2022\u2023\u25E6\u00B7\u2013\u2014]|\d{1,4}[.)])\s+(?:\[[ xX]\]\s+)?/u;
/** A key or a link in brackets at a line's start, and the rest: "[ABC-1] Login", "<https://…>". */
const WRAPPED = /^[[<(]([^\]>)\s]+)[\]>)]\s*(.*)$/su;
/** Words after a key-shaped word: "UTF-8 support", "ISO-8601 dates" are titles, not tickets. */
const SENTENCE_AFTER = /^\s+\p{Ll}/u;
/** What parts the marks of a line of nothing else: "ABC-15, ABC-16". */
const BETWEEN_MARKS = /[\s,;]+/u;
/** A person as Azure DevOps writes one in a cell: a name, then the address. */
const PERSON_CELL = /<[^<>\s]+@[^<>\s]+>$/u;

/**
 * The column names of the trackers' lists, in the languages they ship in that this app
 * speaks: Jira's issue navigator (Key, Summary) and Azure DevOps' results (ID, Title).
 */
const HEADERS: Record<"key" | "title" | "url", ReadonlySet<string>> = {
  key: new Set([
    "key",
    "issue key",
    "issue",
    "id",
    "work item id",
    "schlüssel",
    "vorgangsschlüssel",
    "clé",
    "clé de ticket",
    "kennung",
  ]),
  title: new Set(["summary", "title", "zusammenfassung", "titel", "résumé", "titre"]),
  url: new Set(["url", "link", "lien"]),
};

/** What a line or a row holds, before the domain's rules. */
interface Parts {
  key?: string;
  title?: string;
  url?: string;
}

/** The same, and the text it came from, which stays in the box if it does not go in. */
interface Found extends Parts {
  source: string;
}

export interface PasteResult {
  /** Clean, new items, in the paste's order, at most what the queue has room for. */
  items: QueueEntry[];
  /** The text each item came from, in the same order. */
  sources: string[];
  /** A table's header row, for what stays in the box. */
  header: string | null;
  /** The text of the lines that did not go in: refused, or past the queue's limit. */
  left: string[];
  /** Dropped: the same ticket twice in the paste, or already in the queue. */
  duplicates: number;
  /** Lines the domain refused: hidden characters, a link that is too long. */
  refused: number;
  /** Items whose title was cut to fit. */
  shortened: number;
  /** Items past the queue's limit. */
  overflow: number;
}

/** A link and what follows it, or null when the domain would not make a link of it. */
function linkLine(line: string): Parts | null {
  const match = URL_AT_START.exec(line);
  const url = match?.[1]?.replace(LINK_TAIL, "");
  if (url === undefined) return null;
  const link = cleanSubject({ kind: "link", url });
  if (link?.kind !== "link") return null;
  const title = match?.[2]?.trim();
  return title ? { url, title } : { url };
}

/** A key or a link with nothing else. */
const isMark = (word: string) => KEY_ALONE.test(word) || linkLine(word) !== null;

/**
 * One item of a line: a link, a Jira key, an Azure DevOps id (a number after `#` or `AB#`),
 * each with an optional title after it, or else a title. Keys on a line are read in capitals
 * only, as Jira writes them: "web-2 migration" is a title. So is "UTF-8 support": lower-case
 * words after a key mean a sentence, and a title loses nothing, while a false key would
 * take the next "UTF-8 bug" for the same ticket. Marked by brackets, a key stands anyway.
 */
function readItem(line: string): Parts {
  const wrapped = WRAPPED.exec(line);
  const inner = String(wrapped?.[1]);
  const stands = wrapped !== null && isMark(inner);
  const text = stands ? `${inner} ${wrapped[2]}`.trim() : line;
  const link = linkLine(text);
  if (link !== null) return link;
  const jira = KEY_AT_START.exec(text);
  const sentence = jira !== null && SENTENCE_AFTER.test(text.slice(String(jira[1]).length));
  const key = jira ?? ADO_AT_START.exec(text);
  if (key === null || (sentence && !stands)) return { title: line };
  const title = key[2]?.trim();
  return { key: String(key[1]), ...(title ? { title } : {}) };
}

/** The marks of a line that holds nothing else and more than one: an item each. */
function marksOf(line: string): string[] | null {
  const words = line
    .split(BETWEEN_MARKS)
    .filter((word) => word !== "")
    .map((word) => WRAPPED.exec(word)?.[1] ?? word);
  return words.length > 1 && words.every(isMark) ? words : null;
}

/** What one line of text holds: an item, or one per mark. A list's bullet is no part of it. */
function readLine(raw: string): Found[] {
  const line = raw.replace(BULLET, "");
  const marks = marksOf(line);
  if (marks === null) return [{ ...readItem(line), source: raw }];
  return marks.map((mark) => ({ ...readItem(mark), source: mark }));
}

/** A cell as a key, in the form the domain stores: `ABC-123` or `1234`; else null. */
function keyOfCell(cell: string): string | null {
  if (JIRA_CELL.test(cell)) return cell.toUpperCase();
  return ADO_CELL.exec(cell)?.[1] ?? null;
}

/** Where the quoted cell that opens at `open` closes, or -1 when it is no quoted cell. */
function closingQuote(text: string, open: number, separator: string): number {
  let at = text.indexOf('"', open + 1);
  while (at !== -1) {
    if (text[at + 1] === '"') {
      at = text.indexOf('"', at + 2);
      continue;
    }
    const after = text[at + 1];
    return after === undefined || after === separator || after === "\n" ? at : -1;
  }
  return -1;
}

/** The text's rows of cells. One pass: a paste's length costs no more than its reading. */
export function tableRows(text: string, separator = "\t"): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let at = 0;
  for (;;) {
    let cell: string;
    const close = text[at] === '"' ? closingQuote(text, at, separator) : -1;
    if (close !== -1) {
      cell = text.slice(at + 1, close).replaceAll('""', '"');
      at = close + 1;
    } else {
      let end = at;
      while (end < text.length && text[end] !== separator && text[end] !== "\n") end += 1;
      cell = text.slice(at, end);
      at = end;
    }
    row.push(cell.trim());
    if (at >= text.length) break;
    if (text[at] === "\n") {
      rows.push(row);
      row = [];
    }
    at += 1;
  }
  rows.push(row);
  return rows;
}

interface Columns {
  key: number;
  title: number;
  url: number;
}

/** The columns a header row names, or null when the row is no header. */
function columnsOf(row: readonly string[]): Columns | null {
  const find = (names: ReadonlySet<string>) =>
    row.findIndex((cell) => names.has(cell.toLowerCase()));
  const columns = { key: find(HEADERS.key), title: find(HEADERS.title), url: find(HEADERS.url) };
  return columns.key === -1 && columns.title === -1 ? null : columns;
}

/**
 * A row without a header: a link and a key mark it, and its title is the longest text after
 * the first of them (a list's first columns may be a type), or without a mark its longest
 * text. A person's address is no title. Bare digits count as an Azure DevOps id only at the
 * row's start: a points or priority column holds digits too.
 */
function rowByLooks(row: readonly string[]): Parts {
  const cells = row.flatMap((cell, at) => (cell === "" ? [] : [{ cell, at }]));
  const link = cells.find(({ cell }) => {
    const line = linkLine(cell);
    return line !== null && line.title === undefined;
  });
  const key =
    cells.find(({ cell }) => JIRA_CELL.test(cell)) ??
    cells.find(({ cell }, n) => ADO_CELL.test(cell) && (n === 0 || cell.includes("#")));
  const first = Math.min(link?.at ?? row.length, key?.at ?? row.length);
  const texts = cells.filter(
    (each) => each !== link && each !== key && !PERSON_CELL.test(each.cell),
  );
  const longest = (list: typeof texts) => list.toSorted((a, b) => b.cell.length - a.cell.length)[0];
  const title = longest(texts.filter(({ at }) => at > first)) ?? longest(texts);
  return {
    ...(link === undefined ? {} : { url: String(linkLine(link.cell)?.url) }),
    ...(key === undefined ? {} : { key: String(keyOfCell(key.cell)) }),
    ...(title === undefined ? {} : { title: title.cell }),
  };
}

/** A row under a header: its named columns count, and its looks say the rest. */
function rowByColumns(row: readonly string[], columns: Columns): Parts {
  const cell = (at: number) => row[at] ?? "";
  const looks = rowByLooks(row);
  const key = columns.key === -1 ? looks.key : keyOfCell(cell(columns.key));
  const title = columns.title === -1 ? looks.title : cell(columns.title);
  const url = columns.url === -1 ? looks.url : linkLine(cell(columns.url))?.url;
  return {
    ...(key ? { key } : {}),
    ...(title ? { title } : {}),
    ...(url ? { url } : {}),
  };
}

/** Whether a row marks an item by itself: a link or a key in one of its cells. */
const marked = (row: readonly string[]) =>
  row.some((cell) => keyOfCell(cell) !== null || linkLine(cell) !== null);

const filled = (row: readonly string[]) => row.filter((cell) => cell !== "");

/**
 * The table's header, in its first rows, above any row that marks an item. A row of words
 * over rows that hold keys is one, whatever it calls its columns: then `columns` is null.
 */
function headerOf(rows: readonly string[][]): { at: number; columns: Columns | null } | null {
  for (const [at, row] of rows.slice(0, HEADER_SCAN).entries()) {
    if (marked(row)) return null;
    if (filled(row).length < 2) continue;
    const columns = columnsOf(row);
    if (columns !== null || marked(rows[at + 1] ?? [])) return { at, columns };
  }
  return null;
}

/** A row as it stays in the box: read again, it is the same row. */
function rowText(row: readonly string[]): string {
  return row
    .map((cell) => (/["\t\n]/.test(cell) ? `"${cell.replaceAll('"', '""')}"` : cell))
    .join("\t");
}

/** Everything found in a table, and its header's text: rows of one cell are lines. */
function readTable(text: string, separator: string): { found: Found[]; header: string | null } {
  const rows = tableRows(text, separator).filter((row) => filled(row).length > 0);
  const header = headerOf(rows);
  const columns = header?.columns ?? null;
  const found = rows.slice(header === null ? 0 : header.at + 1).flatMap((row): Found[] => {
    const cells = filled(row);
    if (cells.length === 1) return readLine(String(cells[0]));
    const parts = columns !== null ? rowByColumns(row, columns) : rowByLooks(row);
    return [{ ...parts, source: rowText(row) }];
  });
  return { found, header: header === null ? null : rowText(rows[header.at] ?? []) };
}

/**
 * The separator of text that reads as CSV, or null: a header this file knows over rows, or
 * rows of one width that each mark an item and hold something more than marks. A list of
 * keys with commas is no CSV, and neither are titles with commas, or with a number after
 * one: only the first cell's digits are an id, as in `rowByLooks`.
 */
function csvSeparator(text: string): string | null {
  for (const separator of [",", ";"]) {
    const rows = tableRows(text, separator).filter((row) => filled(row).length > 0);
    const width = rows[0]?.length ?? 0;
    if (rows.length > 1 && headerOf(rows)?.columns) return separator;
    const items = rows.every(
      (row) =>
        row.length === width &&
        row.some((cell, at) => keyOfCell(cell) !== null && (at === 0 || !/^\d+$/.test(cell))) &&
        marksOf(row.join(" ")) === null,
    );
    if (width > 1 && items) return separator;
  }
  return null;
}

function readLines(text: string): Found[] {
  const lines = text.split("\n").map((line) => line.trim());
  return lines.filter((line) => line !== "").flatMap(readLine);
}

function readPaste(text: string): { found: Found[]; header: string | null } {
  const separator = text.includes("\t") ? "\t" : csvSeparator(text);
  return separator === null ? { found: readLines(text), header: null } : readTable(text, separator);
}

/**
 * A title cut to `room` characters, the last one an ellipsis. Cut by code points, which
 * never count fewer than the characters a person sees.
 */
function cutTitle(title: string, room: number): string {
  return `${Array.from(title)
    .slice(0, room - 1)
    .join("")}\u{2026}`;
}

/** Room for a title: a key without a link shares one title with it (`itemSubject`). */
function titleRoom({ key, url }: Parts): number {
  return key === undefined || url !== undefined
    ? MAX_TITLE_LENGTH
    : MAX_TITLE_LENGTH - keyLabel(key).length - 1;
}

/**
 * What a paste adds to a queue: `known` are the identities (`queueIdentity`) already in it,
 * `room` how many more it takes and `bytes` what it holds as JSON (`queueBytes`). A blank line
 * is skipped; a duplicate is dropped and counted; a line the domain refuses is counted;
 * anything else is an item. The room is checked here, before anything is sent.
 */
export function parsePaste(
  text: string,
  {
    known = [],
    room = Number.POSITIVE_INFINITY,
    bytes = 0,
  }: { known?: Iterable<string>; room?: number; bytes?: number } = {},
): PasteResult {
  const clean = text.replace(/^\u{FEFF}/u, "").replace(/\r\n?/g, "\n");
  const { found, header } = readPaste(clean);
  const seen = new Set(known);
  const result: PasteResult = {
    items: [],
    sources: [],
    header,
    left: [],
    duplicates: 0,
    refused: 0,
    shortened: 0,
    overflow: 0,
  };
  let held = bytes;
  for (const { source, ...each } of found) {
    const fitted = { ...each };
    let shortened = false;
    if (each.title !== undefined) {
      const title = each.title.replace(WHITESPACE_RUN, " ").trim();
      const fits = titleRoom(each);
      shortened = Array.from(title).length > fits;
      fitted.title = shortened ? cutTitle(title, fits) : title;
    }
    const entry = cleanQueueItem(fitted);
    if (entry === null) {
      result.refused += 1;
      result.left.push(source);
      continue;
    }
    const identity = queueIdentity(entry);
    if (seen.has(identity)) {
      result.duplicates += 1;
      continue;
    }
    seen.add(identity);
    const size = queueBytes([{ ...entry, id: LONGEST_ID }]);
    if (result.items.length >= room || held + size > MAX_QUEUE_BYTES) {
      result.overflow += 1;
      result.left.push(source);
      continue;
    }
    held += size;
    if (shortened) result.shortened += 1;
    result.items.push(entry);
    result.sources.push(source);
  }
  return result;
}

/**
 * What stays in the box: the lines that did not go in, under a table's header, past the
 * first `sent` items. All of them went in, by default, so only refused and surplus lines
 * stay. Pasted again it adds what is missing: the domain drops what it already holds.
 */
export function pasteLeft(result: PasteResult, sent = result.items.length): string {
  const lines = [...result.sources.slice(sent), ...result.left];
  if (lines.length === 0) return "";
  return (result.header === null ? lines : [result.header, ...lines]).join("\n");
}

/**
 * A list in commands that each fit one socket message: 200 ordinary tickets take two, 500
 * take six. Each command stands alone, so a failure in between leaves the first ones in:
 * the page says how many, and keeps the rest in the box (`pasteLeft`).
 */
export function queueBatches(items: readonly QueueEntry[]): QueueEntry[][] {
  const batches: QueueEntry[][] = [];
  let batch: QueueEntry[] = [];
  let bytes = 0;
  const encoder = new TextEncoder();
  for (const item of items) {
    const size = encoder.encode(JSON.stringify(item)).length + 1;
    if (batch.length > 0 && bytes + size > BATCH_BYTES) {
      batches.push(batch);
      batch = [];
      bytes = 0;
    }
    batch.push(item);
    bytes += size;
  }
  if (batch.length > 0) batches.push(batch);
  return batches;
}
