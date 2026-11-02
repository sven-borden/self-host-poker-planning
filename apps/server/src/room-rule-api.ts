/**
 * What the PO's panel reads about a room's rule (#50, ADR-028), which a snapshot cannot carry
 * without a read of every seat's account on every vote: `GET /api/rooms/:code/restriction`
 * answers `{ outsiders, own }`, the PO alone, `no-store`.
 *
 * - `outsiders`: how many people here the room's stored rule would refuse, never who or why. It
 *   counts the stored rule only, so testing a guess about someone costs a commit the room hears
 *   of, and the limit below.
 * - `own`: what the PO's own account proves, theirs to see, so the panel can ask first before a
 *   rule the PO does not meet.
 */
import { restrictionRefusal } from "@pp/domain";
import type { Hono } from "hono";
import type { AppEnv } from "./app.ts";
import { type Auth, sessionUser } from "./auth.ts";
import type { RoomStore } from "./db/rooms.ts";
import { rateLimited } from "./http.ts";
import type { RateLimiter } from "./rate-limit.ts";
import { isRoomCode } from "./room-code.ts";
import type { RoomRules } from "./room-rule.ts";

/** Reads per PO: a panel asks when it opens and when the people or the rule change. */
export const RESTRICTION_READ_LIMIT = { window: 600, max: 60 } as const;

export interface RestrictionApiDeps {
  auth: Auth;
  rooms: Pick<RoomStore, "loadRoom">;
  rules: RoomRules;
  limiter: RateLimiter;
}

export function registerRestrictionApi(
  app: Hono<AppEnv>,
  { auth, rooms, rules, limiter }: RestrictionApiDeps,
): void {
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
    const others = Object.keys(loaded.state.participants).filter((id) => id !== me.id);
    const identities = await rules.identitiesOf([me.id, ...others]);
    const rule = loaded.state.settings.restriction;
    const outsiders = rule
      ? others.filter(
          (id) => restrictionRefusal(rule, identities.get(id) ?? null, rules.providers) !== null,
        ).length
      : 0;
    return c.json({ outsiders, own: identities.get(me.id) ?? null });
  });
}
