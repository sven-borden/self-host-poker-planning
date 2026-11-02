/**
 * The backlog queue (#52, ADR-024): what a queue item may hold, what subject it becomes, and
 * the changes `apply` makes to the list. Every text goes through `cleanSubject`, so an item
 * obeys the rules of the subject it will become, and there is no second validator.
 *
 * A change returns a new queue, the same queue when nothing changes, or an error code.
 */
import { isRecord } from "./apply-input.ts";
import { ADO_ID, cleanSubject, JIRA_KEY, keyLabel } from "./apply-subject.ts";
import type { ErrorCode } from "./commands.ts";
import {
  MAX_ITEM_TITLE_BYTES,
  MAX_QUEUE_BYTES,
  MAX_QUEUE_ITEMS,
  type Queue,
  type QueueEntry,
  type QueueItem,
  type QueueSource,
  type Subject,
} from "./room.ts";

/** A Jira key in capitals, or an Azure DevOps id in digits, as `linkKey` gives them. */
const ITEM_KEY = new RegExp(`^(?:${JIRA_KEY}|${ADO_ID})$`);

const NO_ITEMS: Queue = { items: [], lastId: 0, rev: 0 };

/** A text's length in UTF-8. By hand: the domain runs without a `TextEncoder` in its types. */
function utf8Bytes(text: string): number {
  let bytes = 0;
  for (const character of text) {
    const point = character.codePointAt(0) as number;
    bytes += point < 0x80 ? 1 : point < 0x800 ? 2 : point < 0x10000 ? 3 : 4;
  }
  return bytes;
}

/** What a list of items takes as JSON, which is what the room's `queue` column holds. */
export function queueBytes(items: readonly object[]): number {
  return utf8Bytes(JSON.stringify(items));
}

/**
 * The subject of the round an item starts. A link keeps its key and its title. Without a
 * link the key is part of the title ("ABC-123 Fix the login"): a title subject has no key
 * of its own, and that is how a person types it, which the exports read too.
 */
export function itemSubject({ key, title, url }: QueueEntry): Subject {
  if (url !== undefined) {
    return {
      kind: "link",
      url,
      ...(key === undefined ? {} : { key }),
      ...(title === undefined ? {} : { title }),
    };
  }
  const text = [key === undefined ? undefined : keyLabel(key), title];
  return { kind: "title", text: text.filter((part) => part !== undefined).join(" ") };
}

/**
 * A queue item, cleaned, or `null` (`bad_queue_item`): at least one of key, title and link,
 * each under a subject's rules, and a key that is a Jira key or an Azure DevOps id. A link's
 * own key beats a key sent with it, as the server reads a link's key itself. Without a link
 * the key and the title must fit one title together. A title is bound in bytes too
 * (`MAX_ITEM_TITLE_BYTES`): one grapheme may run to thousands of them, and a snapshot carries
 * the next item's title. `source` is never read from here: it does not come off the wire.
 */
export function cleanQueueItem(raw: unknown): QueueEntry | null {
  if (!isRecord(raw)) return null;
  const entry: QueueEntry = {};
  if (raw.url !== undefined) {
    const link = cleanSubject({ kind: "link", url: raw.url });
    if (link?.kind !== "link") return null;
    entry.url = link.url;
    if (link.key !== undefined) entry.key = link.key;
  }
  if (raw.key !== undefined) {
    if (typeof raw.key !== "string" || !ITEM_KEY.test(raw.key)) return null;
    entry.key ??= raw.key;
  }
  if (raw.title !== undefined) {
    const title = cleanSubject({ kind: "title", text: raw.title });
    if (title?.kind !== "title" || utf8Bytes(title.text) > MAX_ITEM_TITLE_BYTES) return null;
    entry.title = title.text;
  }
  if (entry.key === undefined && entry.url === undefined && entry.title === undefined) return null;
  return cleanSubject(itemSubject(entry)) === null ? null : entry;
}

/**
 * What makes two items the same ticket: the key, else the link, else the title in any case.
 * The page counts a paste's duplicates with it, and the domain drops them whatever a page
 * knew of the queue.
 */
export function queueIdentity({ key, url, title }: QueueEntry): string {
  if (key !== undefined) return `key ${key}`;
  if (url !== undefined) return `url ${url}`;
  return `title ${String(title).toLowerCase()}`;
}

/** The longest id a new item can get: `fitToQueue` counts this for the one it will get. */
const LONGEST_ID = 9_999_999_999;

/**
 * A title cut to `room` characters, the last one an ellipsis. Cut by code points, which
 * never count fewer than the characters a person sees.
 */
export function cutTitle(title: string, room: number): string {
  return `${Array.from(title)
    .slice(0, room - 1)
    .join("")}\u{2026}`;
}

/** What of a list goes into a queue as it stands, and what does not. */
export interface QueueFit {
  fit: QueueEntry[];
  duplicates: number;
  overflow: number;
}

/**
 * Takes what fits, by count and by bytes, so that a refusal meets only a queue that grew since:
 * the server's side of what the page does for a paste, for a list no person ever held.
 */
export function fitToQueue(queue: Queue | undefined, entries: readonly QueueEntry[]): QueueFit {
  const items = queue?.items ?? [];
  const seen = new Set(items.map(queueIdentity));
  const result: QueueFit = { fit: [], duplicates: 0, overflow: 0 };
  let held = queueBytes(items);
  for (const entry of entries) {
    const identity = queueIdentity(entry);
    if (seen.has(identity)) {
      result.duplicates += 1;
      continue;
    }
    seen.add(identity);
    const size = queueBytes([{ ...entry, id: LONGEST_ID }]);
    if (items.length + result.fit.length >= MAX_QUEUE_ITEMS || held + size > MAX_QUEUE_BYTES) {
      result.overflow += 1;
      continue;
    }
    held += size;
    result.fit.push(entry);
  }
  return result;
}

/** A site or an issue id, as a tracker gives it: nothing a person typed, and short. */
const SOURCE_PART = /^[\w:.-]{1,128}$/;

function cleanSource(raw: unknown): QueueSource | null {
  if (!isRecord(raw)) return null;
  const { system, site, id } = raw;
  if (system !== "jira" && system !== "ado") return null;
  if (typeof site !== "string" || !SOURCE_PART.test(site)) return null;
  if (typeof id !== "string" || !SOURCE_PART.test(id)) return null;
  return { system, site, id };
}

/** `cleanQueueItem` with the `source` an import must have. Only `queueImport` reads one. */
function cleanImported(raw: unknown): QueueEntry | null {
  const entry = cleanQueueItem(raw);
  const source = isRecord(raw) ? cleanSource(raw.source) : null;
  return entry === null || source === null ? null : { ...entry, source };
}

/**
 * The queue with a paste added at its end: every item clean or none (`bad_queue_item`),
 * duplicates dropped, and all of them fit or none (`queue_full`), by count and by bytes:
 * the page takes what fits first, and says so, so this refusal only meets a queue that grew
 * under it. The bytes are counted here alone: nothing else makes the list longer, and a
 * change of order or a removal never has to ask.
 */
export function addToQueue(queue: Queue | undefined, raw: unknown): Queue | ErrorCode {
  return addEntries(queue, raw, cleanQueueItem);
}

/** A connector's list, under the same rules, each item with its `source`. */
export function importToQueue(queue: Queue | undefined, raw: unknown): Queue | ErrorCode {
  return addEntries(queue, raw, cleanImported);
}

function addEntries(
  queue: Queue | undefined,
  raw: unknown,
  read: (item: unknown) => QueueEntry | null,
): Queue | ErrorCode {
  if (!Array.isArray(raw)) return "bad_queue_item";
  const current = queue ?? NO_ITEMS;
  const seen = new Set(current.items.map(queueIdentity));
  const fresh: QueueItem[] = [];
  let lastId = current.lastId;
  for (const item of raw) {
    const entry = read(item);
    if (entry === null) return "bad_queue_item";
    const identity = queueIdentity(entry);
    if (seen.has(identity)) continue;
    seen.add(identity);
    lastId += 1;
    fresh.push({ ...entry, id: lastId });
  }
  if (fresh.length === 0) return queue ?? NO_ITEMS;
  const items = [...current.items, ...fresh];
  if (items.length > MAX_QUEUE_ITEMS || queueBytes(items) > MAX_QUEUE_BYTES) return "queue_full";
  return { items, lastId, rev: current.rev + 1 };
}

/** The queue with an item at place `to`, or at the end when `to` lies past it. */
export function moveInQueue(queue: Queue | undefined, id: number, to: number): Queue | ErrorCode {
  if (!Number.isInteger(to) || to < 0) return "bad_command";
  const items = queue?.items ?? [];
  const from = items.findIndex((item) => item.id === id);
  if (queue === undefined || from < 0) return "unknown_item";
  const place = Math.min(to, items.length - 1);
  if (place === from) return queue;
  const rest = items.toSpliced(from, 1);
  return {
    ...queue,
    items: rest.toSpliced(place, 0, items[from] as QueueItem),
    rev: queue.rev + 1,
  };
}

export function removeFromQueue(queue: Queue | undefined, id: number): Queue | ErrorCode {
  const items = queue?.items.filter((item) => item.id !== id) ?? [];
  if (queue === undefined || items.length === queue.items.length) return "unknown_item";
  return { ...queue, items, rev: queue.rev + 1 };
}

export function clearQueue(queue: Queue | undefined): Queue | undefined {
  if (queue === undefined || queue.items.length === 0) return queue;
  return { ...queue, items: [], rev: queue.rev + 1 };
}
