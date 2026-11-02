/**
 * What the PO's panel does about a room's rule (#50, ADR-028), which a snapshot cannot carry
 * without a read of every seat's account on every vote.
 *
 * - `GET /api/rooms/:code/restriction` answers `{ outsiders, own }`, the PO alone, `no-store`.
 *   `outsiders`: how many people here the room's stored rule would refuse, never who or why. It
 *   counts the stored rule only, so testing a guess about someone costs a commit, which the room
 *   hears of and `RULE_CHANGE_LIMIT` caps. `own`: what the PO's own account proves, theirs to see,
 *   so the panel can ask first before a rule the PO does not meet.
 * - `POST /api/rooms/:code/restriction/remove-outsiders` answers `{ removed }`, a count. A count
 *   the PO could not act on is no use: this takes the seats the rule refuses now, each by a `kick`
 *   through `apply`, on a fresh read of who is here and what they prove, judged again in the
 *   kick's step. The page never says who: the PO sees who is gone from the table, as with any kick.
 */
import { type AccessIdentity, type RoomState, roomRefusal, type UserId } from "@pp/domain";
import type { Hono } from "hono";
import type { AppEnv } from "./app.ts";
import { type Auth, sessionUser } from "./auth.ts";
import type { Config } from "./config.ts";
import type { RoomStore } from "./db/rooms.ts";
import { foreignOrigin, isJsonBody, rateLimited } from "./http.ts";
import type { RateLimiter } from "./rate-limit.ts";
import { isRoomCode } from "./room-code.ts";
import type { RoomRules } from "./room-rule.ts";
import type { RoomSync } from "./sync/room-sync.ts";

/** Reads per PO: a panel asks when it opens and when the people or the rule change. */
export const RESTRICTION_READ_LIMIT = { window: 600, max: 60 } as const;

/** Removals per PO: a press of a button that asks first. */
export const RESTRICTION_REMOVE_LIMIT = { window: 600, max: 10 } as const;

export interface RestrictionApiDeps {
  auth: Auth;
  rooms: Pick<RoomStore, "loadRoom">;
  sync: Pick<RoomSync, "commandAs">;
  config: Config;
  rules: RoomRules;
  limiter: RateLimiter;
}

export function registerRestrictionApi(
  app: Hono<AppEnv>,
  { auth, rooms, sync, config, rules, limiter }: RestrictionApiDeps,
): void {
  /** The people here the state's rule refuses, its PO aside, with what each one proves. */
  function outsiders(
    state: RoomState,
    identities: ReadonlyMap<UserId, AccessIdentity>,
  ): [UserId, AccessIdentity | null][] {
    const seated = Object.keys(state.participants).map((id) => [id, identities.get(id) ?? null]);
    return (seated as [UserId, AccessIdentity | null][]).filter(
      ([id, identity]) => roomRefusal(state, id, identity, rules.providers) !== null,
    );
  }

  app.get("/api/rooms/:code/restriction", async (c) => {
    c.header("Cache-Control", "no-store");
    const me = await sessionUser(auth, c.req.raw.headers);
    if (!me) return c.json({ code: "unauthenticated" }, 401);
    const allowed = await limiter.consume(`restriction|read|${me.id}`, RESTRICTION_READ_LIMIT);
    if (!allowed.allowed) return rateLimited(c, allowed.retryAfter);
    const code = c.req.param("code");
    const loaded = isRoomCode(code) ? await rooms.loadRoom(code) : null;
    if (!loaded) return c.json({ code: "room_not_found" }, 404);
    if (loaded.state.ownerId !== me.id) return c.json({ code: "not_allowed" }, 403);
    const people = Object.keys(loaded.state.participants);
    const identities = await rules.identitiesOf([me.id, ...people]);
    return c.json({
      outsiders: outsiders(loaded.state, identities).length,
      own: identities.get(me.id) ?? null,
    });
  });

  app.post("/api/rooms/:code/restriction/remove-outsiders", async (c) => {
    c.header("Cache-Control", "no-store");
    if (foreignOrigin(c, config)) return c.json({ code: "not_allowed" }, 403);
    if (!isJsonBody(c)) return c.json({ code: "bad_payload" }, 415);
    const me = await sessionUser(auth, c.req.raw.headers);
    if (!me) return c.json({ code: "unauthenticated" }, 401);
    const allowed = await limiter.consume(`restriction|remove|${me.id}`, RESTRICTION_REMOVE_LIMIT);
    if (!allowed.allowed) return rateLimited(c, allowed.retryAfter);
    const code = c.req.param("code");
    const loaded = isRoomCode(code) ? await rooms.loadRoom(code) : null;
    if (!loaded) return c.json({ code: "room_not_found" }, 404);
    if (loaded.state.ownerId !== me.id) return c.json({ code: "not_allowed" }, 403);
    const room = { id: loaded.id, code };
    const identities = await rules.identitiesOf(Object.keys(loaded.state.participants));
    let removed = 0;
    for (const [who, identity] of outsiders(loaded.state, identities)) {
      // On the state it commits over: a rule taken off, or changed to admit them, spares them.
      const ack = await sync.commandAs(room, me.id, { type: "kick", who }, (state) =>
        roomRefusal(state, who, identity, rules.providers) === null ? "unknown_participant" : null,
      );
      if (ack.ok) removed += 1;
      else if (ack.code === "not_owner") return c.json({ code: "not_allowed" }, 403);
    }
    c.var.log.info({ room: room.id, removed }, "people the rule refuses removed");
    return c.json({ removed });
  });
}
