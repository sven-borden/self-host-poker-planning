/**
 * "My rooms" over HTTP (#49, ADR-027), for a signed-in person only: a guest has no list and is
 * refused here, not only on the page.
 *
 * - `GET /api/my-rooms?after=<cursor>`: a page of the rooms the caller owns or holds a seat in,
 *   after finishing a guest's move still pending (ADR-025);
 * - `PATCH /api/my-rooms/:id { name }`: renames a room, its PO only, through `apply`;
 * - `DELETE /api/my-rooms/:id`: deletes a room with all it holds, for someone who is its PO and
 *   its keeper (ADR-027), or its keeper when the room's rule refuses them (ADR-028);
 * - `POST /api/my-rooms/:id/leave`: gives up the seat, through the `leave` command.
 *
 * A person who has nothing to do with a room hears what an unknown id hears, so an id says
 * nothing of whether a room exists, and nothing reaches `apply`, which would resolve the room's
 * deadline even for a command it refuses. Someone who knows the room, by a seat or a right to it,
 * hears why: their page may be out of date, and "no longer there" would be false.
 *
 * A room with a rule (#50, ADR-028) tells someone it would refuse no more here than at its door. A
 * seat there is off the list, as the seat goes when they next enter and the room says nothing to
 * them meanwhile. A room that is theirs stays, blanked: no name, rounds or activity, and their
 * right to delete it. A sign-in too old for a rule hides the same rooms until they sign in again.
 *
 * A room is named by its id in a path: a code is a bearer capability, and it stays out of every
 * address but the room's own. The list returns codes to people already in those rooms, and
 * nothing about anyone else in them. Every answer is `no-store`; an error is `{ code }`, never a
 * sentence. Logs name a room by its id: never its code or name.
 */
import { cleanRoomName, restrictionRefusal } from "@pp/domain";
import { type CmdAck, WIRE_LIMITS } from "@pp/protocol";
import type { Context, Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "./app.ts";
import { type Auth, type SocketUser, sessionOf } from "./auth.ts";
import type { Config } from "./config.ts";
import type { FoundRoom, MyRoom, MyRoomsCursor, MyRoomsStore } from "./db/my-rooms.ts";
import type { GuestLinks } from "./guest-link.ts";
import { foreignOrigin, isJsonBody, rateLimited } from "./http.ts";
import type { RateLimiter, RateLimitRule } from "./rate-limit.ts";
import { identityOf, NO_RULES, type RoomRules, sessionTooOld } from "./room-rule.ts";
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

/** Who is asking, and when their session began. */
type Caller = SocketUser & { startedAt: number };

/** A row someone the room's rule refuses reads: theirs to delete, and nothing about the room. */
const blanked = (room: MyRoom): MyRoom & { refused: true } => ({
  ...room,
  name: null,
  rounds: 0,
  lastActiveAt: new Date(0),
  refused: true,
});

export interface MyRoomsApiDeps {
  auth: Auth;
  rooms: MyRoomsStore;
  links: Pick<GuestLinks, "settle">;
  sync: Pick<RoomSync, "commandAs" | "roomDeleted">;
  config: Config;
  limiter: RateLimiter;
  /** Rooms limited to accounts (#50); left out, a rule refuses everyone but the PO. */
  rules?: RoomRules;
}

export function registerMyRoomsApi(
  app: Hono<AppEnv>,
  { auth, rooms, links, sync, config, limiter, rules = NO_RULES }: MyRoomsApiDeps,
): void {
  /**
   * What every route checks, in order: the origin, the session, that it is an account, the
   * person's limit. Answers the person, or the refusal to send back.
   */
  async function account(
    c: Context<AppEnv>,
    bucket: string,
    limit: RateLimitRule,
  ): Promise<Caller | Response> {
    c.header("Cache-Control", "no-store");
    if (foreignOrigin(c, config)) return c.json({ code: "not_allowed" }, 403);
    const session = await sessionOf(auth, c.req.raw.headers);
    if (!session) return c.json({ code: "unauthenticated" }, 401);
    const me = { ...session.user, startedAt: session.startedAt };
    if (me.isAnonymous) return c.json({ code: "not_allowed" }, 403);
    const allowed = await limiter.consume(`my-rooms|${bucket}|${me.id}`, limit);
    return allowed.allowed ? me : rateLimited(c, allowed.retryAfter);
  }

  /**
   * The page as this person may read it. One read of their account, however many rooms have a
   * rule: the rule is on each row, so the judgement costs no query per row. Their own PO role
   * passes every rule, so a row they hold it on is left alone.
   */
  async function readable(list: MyRoom[], me: Caller) {
    const ruled = (room: MyRoom) => room.rule !== null && !room.owned;
    const identity = list.some(ruled) ? await identityOf(rules, me.id) : null;
    const tooOld = sessionTooOld(me.startedAt, Date.now());
    const shown: (MyRoom & { refused?: true })[] = [];
    let hidden = false;
    for (const room of list) {
      const refused =
        room.rule !== null &&
        !room.owned &&
        restrictionRefusal(room.rule, identity, rules.providers) !== null;
      if (refused) {
        if (room.keeper) shown.push(blanked(room));
      } else if (ruled(room) && tooOld) hidden = true;
      else shown.push(room);
    }
    return { shown, hidden };
  }

  /** Whether the room's rule refuses this keeper, who cannot then take the role back to delete. */
  async function shutOut(room: FoundRoom, me: Caller): Promise<boolean> {
    if (room.rule === null || !room.keeper || room.ownerId === me.id) return false;
    const refused = restrictionRefusal(room.rule, await identityOf(rules, me.id), rules.providers);
    return refused !== null;
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

  /** The room, for someone with a seat in it or a right to it; otherwise as for an unknown id. */
  async function known(id: string, user: string): Promise<FoundRoom | null> {
    const room = ROOM_ID.test(id) ? await rooms.find(id, user) : null;
    return room && (room.ownerId === user || room.keeper || room.seated) ? room : null;
  }

  /** Why this person may not delete this room: the list was out of date, or lost a race. */
  function noDelete(c: Context<AppEnv>, room: FoundRoom | null, user: string) {
    if (!room) return c.json({ code: "room_not_found" }, 404);
    if (room.ownerId !== user) return c.json({ code: "not_owner" }, 403);
    return room.keeper
      ? c.json({ code: "room_not_found" }, 404)
      : c.json({ code: "not_keeper" }, 403);
  }

  app.get("/api/my-rooms", async (c) => {
    const me = await account(c, "read", MY_ROOMS_READ_LIMIT);
    if (me instanceof Response) return me;
    const raw = c.req.query("after");
    const after = raw === undefined ? undefined : readCursor(raw);
    if (after === null) return c.json({ code: "bad_payload" }, 400);
    const settled = await links.settle(me.id, MY_ROOMS_SETTLE_MS);
    const { rooms: list, next } = await rooms.list(me.id, MY_ROOMS_PAGE, after);
    const { shown, hidden } = await readable(list, me);
    return c.json({
      rooms: shown.map(({ rule: _, ...room }) => ({
        ...room,
        lastActiveAt: room.lastActiveAt.toISOString(),
      })),
      retentionDays: config.roomTtlDays,
      ...(next && { next: writeCursor(next) }),
      ...(!settled && { moving: true }),
      ...(hidden && { signInAgain: true }),
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
    const room = await known(c.req.param("id"), me.id);
    if (!room) return c.json({ code: "room_not_found" }, 404);
    if (room.ownerId !== me.id) return c.json({ code: "not_owner" }, 403);
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
    const room = await known(id, me.id);
    // A keeper the rule refuses keeps the right (ADR-028): the room is theirs, and with the role
    // out of reach, as neither a claim nor a hand-over can reach them, the role cannot ask it.
    const rule = room && (await shutOut(room, me)) ? room.rule : null;
    if (!rule && (room?.ownerId !== me.id || !room.keeper)) return noDelete(c, room, me.id);
    if (!room) return noDelete(c, room, me.id);
    // The statement is the judge. It refuses a claim or a hand-over that landed since, and a
    // second tab's delete: the row says which.
    const deleted = rule
      ? await rooms.deleteKept(room.id, me.id, rule)
      : await rooms.deleteOwned(room.id, me.id);
    if (!deleted) return noDelete(c, await known(id, me.id), me.id);
    sync.roomDeleted(room.id);
    c.var.log.info({ room: room.id }, "room deleted");
    return c.body(null, 204);
  });

  app.post("/api/my-rooms/:id/leave", async (c) => {
    const me = await account(c, "change", MY_ROOMS_CHANGE_LIMIT);
    if (me instanceof Response) return me;
    if (!isJsonBody(c)) return c.json({ code: "bad_payload" }, 415);
    const room = await known(c.req.param("id"), me.id);
    if (!room) return c.json({ code: "room_not_found" }, 404);
    if (!room.seated) return c.json({ code: "not_participant" }, 403);
    const ack = await sync.commandAs(room, me.id, { type: "leave" });
    return ack.ok ? c.body(null, 204) : refusal(c, ack);
  });
}
