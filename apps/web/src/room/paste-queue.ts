import {
  ADO_ID,
  cleanQueueItem,
  cleanSubject,
  JIRA_KEY,
  keyLabel,
  MAX_TITLE_LENGTH,
  type QueueEntry,
  queueIdentity,
} from "@pp/domain";
import { WIRE_LIMITS } from "@pp/protocol";

// A paste into the queue (#52, ADR-024): pure, in the page, no network. The text becomes
// items and is forgotten: nothing reads a pasted link, and the raw text goes nowhere. The
// domain's own rules decide what an item may hold (`cleanQueueItem`); this file only finds
// the key, the title and the link in what the two trackers put on the clipboard.
//
// Text with a tab is read as a table, as a browser pastes one: tabs between cells, a cell
// that starts with a quote may hold tabs and line breaks and doubles its own quotes. A row
// of one cell, and all text without a tab, is read line by line.

/** The page sends a list in batches of at most this much JSON, under the socket's cap. */
const BATCH_BYTES = WIRE_LIMITS.messageBytes - 2048;

/** A key ends where no word goes on; then what parts it from a title: "ABC-1: Login". */
const AFTER_KEY = "(?![\\p{L}\\p{N}_-])[\\s:\\u2013\\u2014-]*(.*)$";
const KEY_AT_START = new RegExp(`^(${JIRA_KEY})${AFTER_KEY}`, "su");
const ADO_AT_START = new RegExp(`^(?:AB)?#(${ADO_ID})${AFTER_KEY}`, "su");
const URL_AT_START = /^(https?:\/\/\S+)(?:\s+[-:|\u2013\u2014]*\s*(.*))?$/isu;
/** A key in a cell: any case, as a person may type it in a sheet. */
const JIRA_CELL = new RegExp(`^${JIRA_KEY}$`, "i");
const ADO_CELL = new RegExp(`^(?:AB)?#?(${ADO_ID})$`);
const WHITESPACE_RUN = /\s+/gu;

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
interface Found {
  key?: string;
  title?: string;
  url?: string;
}

export interface PasteResult {
  /** Clean, new items, in the paste's order, at most the room left in the queue. */
  items: QueueEntry[];
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
function linkLine(line: string): Found | null {
  const match = URL_AT_START.exec(line);
  const url = match?.[1];
  if (url === undefined) return null;
  const link = cleanSubject({ kind: "link", url });
  if (link?.kind !== "link") return null;
  const title = match?.[2]?.trim();
  return title ? { url, title } : { url };
}

/**
 * One line: a link, a Jira key, an Azure DevOps id (a number after `#` or `AB#`), each with
 * an optional title after it, or else a title. Keys on a line are read in capitals only, as
 * Jira writes them: "web-2 migration" is a title.
 */
function readLine(line: string): Found {
  const link = linkLine(line);
  if (link !== null) return link;
  const key = KEY_AT_START.exec(line) ?? ADO_AT_START.exec(line);
  if (key === null) return { title: line };
  const title = key[2]?.trim();
  return { key: String(key[1]), ...(title ? { title } : {}) };
}

/** A cell as a key, in the form the domain stores: `ABC-123` or `1234`; else null. */
function keyOfCell(cell: string): string | null {
  if (JIRA_CELL.test(cell)) return cell.toUpperCase();
  return ADO_CELL.exec(cell)?.[1] ?? null;
}

/** Where the quoted cell that opens at `open` closes, or -1 when it is no quoted cell. */
function closingQuote(text: string, open: number): number {
  let at = text.indexOf('"', open + 1);
  while (at !== -1) {
    if (text[at + 1] === '"') {
      at = text.indexOf('"', at + 2);
      continue;
    }
    const after = text[at + 1];
    return after === undefined || after === "\t" || after === "\n" ? at : -1;
  }
  return -1;
}

/** The text's rows of cells. One pass: a paste's length costs no more than its reading. */
export function tableRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let at = 0;
  for (;;) {
    let cell: string;
    const close = text[at] === '"' ? closingQuote(text, at) : -1;
    if (close !== -1) {
      cell = text.slice(at + 1, close).replaceAll('""', '"');
      at = close + 1;
    } else {
      let end = at;
      while (end < text.length && text[end] !== "\t" && text[end] !== "\n") end += 1;
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

/** A row under a known header: only its columns count. */
function rowByColumns(row: readonly string[], columns: Columns): Found {
  const cell = (at: number) => (at === -1 ? "" : (row[at] ?? ""));
  const key = keyOfCell(cell(columns.key));
  const title = cell(columns.title);
  const url = cell(columns.url);
  return {
    ...(key === null ? {} : { key }),
    ...(title === "" ? {} : { title }),
    ...(linkLine(url) === null ? {} : { url }),
  };
}

/**
 * A row without a header: a link and a key mark it, and its title is the first text after
 * the first of them (a list's first columns may be a type), or without a mark its longest
 * text. Bare digits count as an Azure DevOps id only at the row's start: a points or
 * priority column holds digits too.
 */
function rowByLooks(row: readonly string[]): Found {
  const cells = row.flatMap((cell, at) => (cell === "" ? [] : [{ cell, at }]));
  const link = cells.find(({ cell }) => {
    const line = linkLine(cell);
    return line !== null && line.title === undefined;
  });
  const key =
    cells.find(({ cell }) => JIRA_CELL.test(cell)) ??
    cells.find(({ cell }, n) => ADO_CELL.test(cell) && (n === 0 || cell.includes("#")));
  const first = Math.min(link?.at ?? row.length, key?.at ?? row.length);
  const texts = cells.filter((each) => each !== link && each !== key);
  const longest = texts.toSorted((a, b) => b.cell.length - a.cell.length)[0];
  const title = texts.find(({ at }) => at > first) ?? longest;
  return {
    ...(link === undefined ? {} : { url: link.cell }),
    ...(key === undefined ? {} : { key: String(keyOfCell(key.cell)) }),
    ...(title === undefined ? {} : { title: title.cell }),
  };
}

/** Whether a row marks an item by itself: a link or a key in one of its cells. */
const marked = (row: readonly string[]) =>
  row.some((cell) => keyOfCell(cell) !== null || linkLine(cell) !== null);

/** Everything found in a text with tabs: rows of one cell are lines. */
function readTable(text: string): Found[] {
  const rows = tableRows(text).filter((row) => row.some((cell) => cell !== ""));
  const first = rows[0] ?? [];
  const columns = marked(first) ? null : columnsOf(first);
  // A first row of words over rows that hold keys is a header, whatever it calls its columns.
  const skip = columns !== null || (first.length > 1 && !marked(first) && marked(rows[1] ?? []));
  return rows.slice(skip ? 1 : 0).map((row) => {
    if (columns !== null) return rowByColumns(row, columns);
    const cells = row.filter((cell) => cell !== "");
    return cells.length === 1 ? readLine(String(cells[0])) : rowByLooks(row);
  });
}

function readLines(text: string): Found[] {
  const lines = text.split("\n").map((line) => line.trim());
  return lines.filter((line) => line !== "").map(readLine);
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
function titleRoom({ key, url }: Found): number {
  return key === undefined || url !== undefined
    ? MAX_TITLE_LENGTH
    : MAX_TITLE_LENGTH - keyLabel(key).length - 1;
}

/**
 * What a paste adds to a queue: `known` are the identities (`queueIdentity`) already in it
 * and `room` how many more it takes. A blank line is skipped; a duplicate is dropped and
 * counted; a line the domain refuses is counted; anything else is an item.
 */
export function parsePaste(
  text: string,
  { known = [], room = Number.POSITIVE_INFINITY }: { known?: Iterable<string>; room?: number } = {},
): PasteResult {
  const clean = text.replace(/^\u{FEFF}/u, "").replace(/\r\n?/g, "\n");
  const found = clean.includes("\t") ? readTable(clean) : readLines(clean);
  const seen = new Set(known);
  const result: PasteResult = { items: [], duplicates: 0, refused: 0, shortened: 0, overflow: 0 };
  for (const each of found) {
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
      continue;
    }
    const identity = queueIdentity(entry);
    if (seen.has(identity)) {
      result.duplicates += 1;
      continue;
    }
    seen.add(identity);
    if (result.items.length >= room) {
      result.overflow += 1;
      continue;
    }
    if (shortened) result.shortened += 1;
    result.items.push(entry);
  }
  return result;
}

/**
 * A list in commands that each fit one socket message. Nearly always one: 500 ordinary
 * tickets fit. Only a list of very long links takes more, and then each batch stands alone.
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
