/**
 * "My rooms" over HTTP (#49, ADR-027), for a signed-in person only: a guest has no list and is
 * refused here, not only on the page.
 *
 * - `GET /api/my-rooms?after=<cursor>`: a page of the rooms the caller owns or holds a seat in,
 *   after finishing a guest's move still pending (ADR-025);
 * - `PATCH /api/my-rooms/:id { name }`: renames a room, its owner only, through `apply`;
 * - `DELETE /api/my-rooms/:id`: deletes a room with all it holds, its owner only;
 * - `POST /api/my-rooms/:id/leave`: gives up the seat, through the `leave` command.
 *
 * A room is named by its id in a path: a code is a bearer capability, and it stays out of every
 * address but the room's own. The list returns codes to people already in those rooms, and
 * nothing about anyone else in them. Every answer is `no-store`; an error is `{ code }`, never a
 * sentence. Logs name a room by its id: never its code or name.
 */
import { cleanRoomName } from "@pp/domain";
import { type CmdAck, WIRE_LIMITS } from "@pp/protocol";
import type { Context, Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "./app.ts";
import { type Auth, type SocketUser, sessionUser } from "./auth.ts";
import type { Config } from "./config.ts";
import type { MyRoomsCursor, MyRoomsStore } from "./db/my-rooms.ts";
import type { GuestLinks } from "./guest-link.ts";
import { foreignOrigin, isJsonBody, rateLimited } from "./http.ts";
import type { RateLimiter, RateLimitRule } from "./rate-limit.ts";
import type { RoomSync } from "./sync/room-sync.ts";

/** Rooms in one answer: the whole list of nearly everyone, in one request. */
export const MY_ROOMS_PAGE = 100;

/** Reads per person: a page load and its "Show more"s; a script gets one a second. */
export const MY_ROOMS_READ_LIMIT = { window: 60, max: 60 } as const;

/** Renames, deletions and leaving per person: more than anyone tidies by hand. */
export const MY_ROOMS_CHANGE_LIMIT = { window: 60, max: 30 } as const;

/**
 * How long a list waits for a guest's move still pending (ADR-025). The move goes on, and the
 * page says rooms are still on their way. With nothing pending this is one read by index.
 */
export const MY_ROOMS_SETTLE_MS = 1000;

const ROOM_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CURSOR = /^(\d{1,17})_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

/** The body of `PATCH /api/my-rooms/:id`. The same coarse cap as creating a room. */
const renameBodySchema = z.strictObject({ name: z.string().max(WIRE_LIMITS.name) });

const writeCursor = ({ micros, id }: MyRoomsCursor) => `${micros}_${id}`;

function readCursor(raw: string): MyRoomsCursor | null {
  const [, micros, id] = CURSOR.exec(raw) ?? [];
  return micros !== undefined && id !== undefined ? { micros, id } : null;
}

export interface MyRoomsApiDeps {
  auth: Auth;
  rooms: MyRoomsStore;
  links: Pick<GuestLinks, "settle">;
  sync: Pick<RoomSync, "commandAs" | "roomDeleted">;
  config: Config;
  limiter: RateLimiter;
}

export function registerMyRoomsApi(
  app: Hono<AppEnv>,
  { auth, rooms, links, sync, config, limiter }: MyRoomsApiDeps,
): void {
  /**
   * What every route checks, in order: the origin, the session, that it is an account, the
   * person's limit. Answers the person, or the refusal to send back.
   */
  async function account(
    c: Context<AppEnv>,
    bucket: string,
    limit: RateLimitRule,
  ): Promise<SocketUser | Response> {
    c.header("Cache-Control", "no-store");
    if (foreignOrigin(c, config)) return c.json({ code: "not_allowed" }, 403);
    const me = await sessionUser(auth, c.req.raw.headers);
    if (!me) return c.json({ code: "unauthenticated" }, 401);
    if (me.isAnonymous) return c.json({ code: "not_allowed" }, 403);
    const allowed = await limiter.consume(`my-rooms|${bucket}|${me.id}`, limit);
    return allowed.allowed ? me : rateLimited(c, allowed.retryAfter);
  }

  /** A refused command as HTTP: its code and status. */
  function refusal(c: Context<AppEnv>, ack: Extract<CmdAck, { ok: false }>) {
    switch (ack.code) {
      case "not_owner":
      case "not_participant":
        return c.json({ code: ack.code }, 403);
      case "room_not_found":
        return c.json({ code: ack.code }, 404);
      case "busy":
        return c.json({ code: ack.code }, 503);
      default:
        return c.json({ code: "internal" }, 500);
    }
  }

  app.get("/api/my-rooms", async (c) => {
    const me = await account(c, "read", MY_ROOMS_READ_LIMIT);
    if (me instanceof Response) return me;
    const raw = c.req.query("after");
    const after = raw === undefined ? undefined : readCursor(raw);
    if (after === null) return c.json({ code: "bad_payload" }, 400);
    const settled = await links.settle(me.id, MY_ROOMS_SETTLE_MS);
    const { rooms: list, next } = await rooms.list(me.id, MY_ROOMS_PAGE, after);
    return c.json({
      rooms: list.map((room) => ({ ...room, lastActiveAt: room.lastActiveAt.toISOString() })),
      retentionDays: config.roomTtlDays,
      ...(next && { next: writeCursor(next) }),
      ...(!settled && { moving: true }),
    });
  });

  app.patch("/api/my-rooms/:id", async (c) => {
    const me = await account(c, "change", MY_ROOMS_CHANGE_LIMIT);
    if (me instanceof Response) return me;
    if (!isJsonBody(c)) return c.json({ code: "bad_payload" }, 415);
    const body = renameBodySchema.safeParse(await c.req.json().catch(() => undefined));
    if (!body.success) return c.json({ code: "bad_payload" }, 400);
    const name = cleanRoomName(body.data.name);
    if (name === null) return c.json({ code: "bad_room_name" }, 400);
    const id = c.req.param("id");
    const room = ROOM_ID.test(id) ? await rooms.find(id) : null;
    if (!room) return c.json({ code: "room_not_found" }, 404);
    // Judged by `apply` on the room's fresh state, in its queue: a PO who lost the role is refused.
    const ack = await sync.commandAs(room, me.id, { type: "renameRoom", name });
    if (!ack.ok) return refusal(c, ack);
    c.var.log.info({ room: room.id }, "room renamed");
    return c.json({ name });
  });

  app.delete("/api/my-rooms/:id", async (c) => {
    const me = await account(c, "change", MY_ROOMS_CHANGE_LIMIT);
    if (me instanceof Response) return me;
    const id = c.req.param("id");
    const room = ROOM_ID.test(id) ? await rooms.find(id) : null;
    if (!room) return c.json({ code: "room_not_found" }, 404);
    if (!(await rooms.deleteOwned(room.id, me.id))) return c.json({ code: "not_owner" }, 403);
    sync.roomDeleted(room.id);
    c.var.log.info({ room: room.id }, "room deleted");
    return c.body(null, 204);
  });

  app.post("/api/my-rooms/:id/leave", async (c) => {
    const me = await account(c, "change", MY_ROOMS_CHANGE_LIMIT);
    if (me instanceof Response) return me;
    if (!isJsonBody(c)) return c.json({ code: "bad_payload" }, 415);
    const id = c.req.param("id");
    const room = ROOM_ID.test(id) ? await rooms.find(id) : null;
    if (!room) return c.json({ code: "room_not_found" }, 404);
    const ack = await sync.commandAs(room, me.id, { type: "leave" });
    return ack.ok ? c.body(null, 204) : refusal(c, ack);
  });
}
