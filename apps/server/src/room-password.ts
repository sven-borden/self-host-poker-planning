/**
 * The room password over HTTP (#31, architecture section 8), never over the socket, so a
 * password never enters the command pipeline, its idempotency cache or a log line:
 *
 * - `PUT /api/rooms/:code/password { password }` sets or changes it, the PO only;
 * - `DELETE /api/rooms/:code/password` removes it, the PO only;
 * - `POST /api/rooms/:code/access { password }` checks it and grants the caller access.
 *
 * Every answer is `no-store`; an error is `{ code }`, never a sentence. Logs name the room
 * by its id: never its code, the password, its hash or the client address.
 */
import type { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "./app.ts";
import { type Auth, sessionUser } from "./auth.ts";
import type { Config } from "./config.ts";
import type { AccessStore, RoomStore } from "./db/rooms.ts";
import { foreignOrigin, isJsonBody, rateLimited, requestIp } from "./http.ts";
import {
  createHashGate,
  type HashGate,
  hashPassword,
  normalisePassword,
  verifyPassword,
} from "./password.ts";
import type { RateLimiter, RateLimitRule } from "./rate-limit.ts";
import { isRoomCode } from "./room-code.ts";
import type { RoomSync } from "./sync/room-sync.ts";

/**
 * Wrong passwords allowed in 10 minutes (#31), counted on failed tries only: per client
 * address and room, per room (in the database, so every instance shares it), and per
 * client address across rooms. A team that mistypes passes; a guesser gets 10 tries per
 * room per address, and 50 per room whatever the addresses.
 */
export const PASSWORD_LIMITS = {
  addressRoom: { window: 600, max: 10 },
  room: { window: 600, max: 50 },
  address: { window: 600, max: 100 },
} as const satisfies Record<string, RateLimitRule>;

/** Password changes per PO in 10 minutes: each one costs a hash. */
export const PASSWORD_CHANGE_LIMIT = { window: 600, max: 30 } as const;

/** A body far longer than any password is not read further (`bad_payload`). */
const passwordBodySchema = z.strictObject({ password: z.string().max(4096) });

export interface PasswordApiDeps {
  auth: Auth;
  rooms: Pick<RoomStore, "loadRoom"> &
    Pick<AccessStore, "loadPassword" | "grantAccess" | "recordFailure">;
  sync: Pick<RoomSync, "changePassword">;
  config: Config;
  limiter: RateLimiter;
  /** At most 4 argon2 runs at once; one per app by default. */
  gate?: HashGate;
}

export function registerPasswordApi(
  app: Hono<AppEnv>,
  { auth, rooms, sync, config, limiter, gate = createHashGate() }: PasswordApiDeps,
): void {
  const ipOf = (c: Parameters<typeof requestIp>[0]) => requestIp(c, config) ?? "unknown";

  /** The PO's change: a new hash, or none. Answers 204 or an error code. */
  async function change(
    c: Parameters<typeof requestIp>[0],
    hashOf: (() => Promise<string>) | null,
  ) {
    const code = c.req.param("code") ?? "";
    const me = await sessionUser(auth, c.req.raw.headers);
    if (!me) return c.json({ code: "unauthenticated" }, 401);
    const allowed = await limiter.consume(`password|change|${me.id}`, PASSWORD_CHANGE_LIMIT);
    if (!allowed.allowed) return rateLimited(c, allowed.retryAfter);
    const loaded = isRoomCode(code) ? await rooms.loadRoom(code) : null;
    if (!loaded) return c.json({ code: "room_not_found" }, 404);
    // Checked before the hash, so nobody else makes the server spend one.
    if (loaded.state.ownerId !== me.id) return c.json({ code: "not_allowed" }, 403);
    let hash: string | null = null;
    if (hashOf) {
      const hashed = await gate.run(hashOf);
      if (hashed === null) return rateLimited(c, 1);
      hash = hashed;
    }
    const ack = await sync.changePassword(code, me.id, hash);
    if (ack.ok) return c.body(null, 204);
    switch (ack.code) {
      case "not_owner":
        return c.json({ code: "not_allowed" }, 403);
      case "room_not_found":
        return c.json({ code: ack.code }, 404);
      case "busy":
        return c.json({ code: ack.code }, 503);
      default:
        return c.json({ code: "internal" }, 500);
    }
  }

  app.put("/api/rooms/:code/password", async (c) => {
    c.header("Cache-Control", "no-store");
    if (foreignOrigin(c, config)) return c.json({ code: "not_allowed" }, 403);
    if (!isJsonBody(c)) return c.json({ code: "bad_payload" }, 415);
    const body = passwordBodySchema.safeParse(await c.req.json().catch(() => undefined));
    if (!body.success) return c.json({ code: "bad_payload" }, 400);
    const password = normalisePassword(body.data.password);
    if (password === null) return c.json({ code: "bad_password" }, 400);
    return change(c, () => hashPassword(password));
  });

  app.delete("/api/rooms/:code/password", async (c) => {
    c.header("Cache-Control", "no-store");
    if (foreignOrigin(c, config)) return c.json({ code: "not_allowed" }, 403);
    return change(c, null);
  });

  app.post("/api/rooms/:code/access", async (c) => {
    c.header("Cache-Control", "no-store");
    if (foreignOrigin(c, config)) return c.json({ code: "not_allowed" }, 403);
    if (!isJsonBody(c)) return c.json({ code: "bad_payload" }, 415);
    const ip = ipOf(c);
    // Looked at before anything costs a query: an address past its limit is answered at once.
    const across = await limiter.peek(`password|ip|${ip}`, PASSWORD_LIMITS.address);
    if (!across.allowed) return rateLimited(c, across.retryAfter);
    const me = await sessionUser(auth, c.req.raw.headers);
    if (!me) return c.json({ code: "unauthenticated" }, 401);
    const body = passwordBodySchema.safeParse(await c.req.json().catch(() => undefined));
    if (!body.success) return c.json({ code: "bad_payload" }, 400);
    const code = c.req.param("code");
    const stored = isRoomCode(code)
      ? await rooms.loadPassword(code, PASSWORD_LIMITS.room.window)
      : null;
    if (!stored) return c.json({ code: "room_not_found" }, 404);
    // No password (removed meanwhile): nothing to check, the room lets everyone in.
    if (stored.hash === null) return c.body(null, 204);
    const local = `password|room|${stored.id}|${ip}`;
    const here = await limiter.peek(local, PASSWORD_LIMITS.addressRoom);
    if (!here.allowed) return rateLimited(c, here.retryAfter);
    if (stored.failures >= PASSWORD_LIMITS.room.max) return rateLimited(c, stored.retryAfter);
    const password = normalisePassword(body.data.password);
    const hash = stored.hash;
    const right = password === null ? false : await gate.run(() => verifyPassword(password, hash));
    if (right === null) return rateLimited(c, 1);
    if (right) {
      await rooms.grantAccess(stored.id, me.id);
      c.var.log.info({ room: stored.id }, "room access granted");
      return c.body(null, 204);
    }
    await limiter.consume(local, PASSWORD_LIMITS.addressRoom);
    await limiter.consume(`password|ip|${ip}`, PASSWORD_LIMITS.address);
    await rooms.recordFailure(stored.id, PASSWORD_LIMITS.room.window);
    c.var.log.info({ room: stored.id }, "wrong room password");
    return c.json({ code: "wrong_password" }, 403);
  });
}
