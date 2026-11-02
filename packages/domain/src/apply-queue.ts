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
  MAX_QUEUE_ITEMS,
  type Queue,
  type QueueEntry,
  type QueueItem,
  type Subject,
} from "./room.ts";

/** A Jira key in capitals, or an Azure DevOps id in digits, as `linkKey` gives them. */
const ITEM_KEY = new RegExp(`^(?:${JIRA_KEY}|${ADO_ID})$`);

const NO_ITEMS: Queue = { items: [], lastId: 0, rev: 0 };

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
 * the key and the title must fit one title together. `source` is never read from here: it
 * does not come off the wire.
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
    if (title?.kind !== "title") return null;
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

/**
 * The queue with a paste added at its end: every item clean or none (`bad_queue_item`),
 * duplicates dropped, and all of them fit or none (`queue_full`): the page takes what fits
 * first, and says so, so this refusal only meets a queue that grew under it.
 */
export function addToQueue(queue: Queue | undefined, raw: unknown): Queue | ErrorCode {
  if (!Array.isArray(raw)) return "bad_queue_item";
  const current = queue ?? NO_ITEMS;
  const seen = new Set(current.items.map(queueIdentity));
  const fresh: QueueItem[] = [];
  let lastId = current.lastId;
  for (const item of raw) {
    const entry = cleanQueueItem(item);
    if (entry === null) return "bad_queue_item";
    const identity = queueIdentity(entry);
    if (seen.has(identity)) continue;
    seen.add(identity);
    lastId += 1;
    fresh.push({ ...entry, id: lastId });
  }
  if (fresh.length === 0) return queue ?? NO_ITEMS;
  if (current.items.length + fresh.length > MAX_QUEUE_ITEMS) return "queue_full";
  return { items: [...current.items, ...fresh], lastId, rev: current.rev + 1 };
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
