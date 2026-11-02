/**
 * The queue's list (#52, ADR-024): `queue` over the socket answers the entered room's items
 * in order, to its PO alone, checked on a fresh load at every request. The list never rides
 * in a snapshot, which says only how many wait and which comes next (`queueSummarySchema`).
 *
 * The answer's schemas are strict, unlike the snapshot's: `items` is the one place an item
 * leaves the server, and `queueList` builds each one field by field, so a field the domain
 * adds (a connector's `source`) stays on the server until it is added here on purpose.
 */
import type { Queue } from "@pp/domain";
import { z } from "zod";
import { WIRE_LIMITS } from "./commands.ts";
import { ackErrorCodeSchema } from "./schemas.ts";

const textSchema = z.string().max(WIRE_LIMITS.subject);

/** The request has no fields: it asks for the whole list. */
export const queueRequestSchema = z.strictObject({});

export type ParsedQueueRequest = { ok: true } | { ok: false; code: "bad_payload" };

/** Parses what a socket sent with `queue`; no payload at all is fine. Never throws. */
export function parseQueueRequest(input: unknown): ParsedQueueRequest {
  const parsed = queueRequestSchema.safeParse(input === undefined ? {} : input);
  return parsed.success ? { ok: true } : { ok: false, code: "bad_payload" };
}

export const queueItemViewSchema = z.strictObject({
  id: z.number().int(),
  key: z.string().max(WIRE_LIMITS.itemKey).optional(),
  title: textSchema.optional(),
  url: textSchema.optional(),
});

/** The answer: the items, next one first, and the `rev` they are at. */
export const queueAckSchema = z.union([
  z.strictObject({
    ok: z.literal(true),
    rev: z.number().int(),
    items: z.array(queueItemViewSchema),
  }),
  z.object({ ok: z.literal(false), code: ackErrorCodeSchema }),
]);

export type QueueItemView = z.output<typeof queueItemViewSchema>;
export type QueueAck = z.output<typeof queueAckSchema>;

/** The list as the PO reads it. */
export function queueList(queue: Queue | undefined): { rev: number; items: QueueItemView[] } {
  return {
    rev: queue?.rev ?? 0,
    items: (queue?.items ?? []).map(({ id, key, title, url }) => ({
      id,
      ...(key !== undefined ? { key } : {}),
      ...(title !== undefined ? { title } : {}),
      ...(url !== undefined ? { url } : {}),
    })),
  };
}
