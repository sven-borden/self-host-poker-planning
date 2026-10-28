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
  CorruptHashError,
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
 * The limits on `/access` (#31), each in 10 minutes:
 *
 * - `user`: 10 wrong passwords per person (session user) and room, so one person's typos
 *   never lock out a team that shares an address;
 * - `addressRoom`: 25 wrong passwords per client address and room, so one address with a
 *   handful of guest sessions cannot spend the room's 50 alone;
 * - `room`: 50 wrong passwords per room whatever the people or addresses, in the database
 *   so every instance shares it: the cap on a brute force;
 * - `address`: 300 checks per client address, right, wrong or for a room that does not
 *   exist: the CPU one client can burn, and how many codes it can test.
 *
 * A wrong try is reserved before the check and released when the password was right, so
 * tries sent at once are counted exactly and a right password costs nothing.
 */
export const PASSWORD_LIMITS = {
  user: { window: 600, max: 10 },
  addressRoom: { window: 600, max: 25 },
  room: { window: 600, max: 50 },
  address: { window: 600, max: 300 },
} as const satisfies Record<string, RateLimitRule>;

/** Password changes per PO in 10 minutes: each one costs a hash. */
export const PASSWORD_CHANGE_LIMIT = { window: 600, max: 30 } as const;

/** A body far longer than any password is not read further (`bad_payload`). */
const passwordBodySchema = z.strictObject({ password: z.string().max(4096) });

export interface PasswordApiDeps {
  auth: Auth;
  rooms: Pick<RoomStore, "loadRoom"> &
    Pick<AccessStore, "loadPassword" | "grantAccess" | "reserveTry" | "releaseTry">;
  sync: Pick<RoomSync, "changePassword">;
  config: Config;
  limiter: RateLimiter;
  /** The argon2 runs' line (`HASH_GATE`); one per app by default. */
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
      if (hashed === null) return c.json({ code: "busy" }, 503);
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
    // Every check counts here before it costs a query, whatever its answer: a 204 or a 404
    // tells whether a room exists, so this also caps the codes one address can test.
    const ip = ipOf(c);
    const checks = await limiter.consume(`password|ip|${ip}`, PASSWORD_LIMITS.address);
    if (!checks.allowed) return rateLimited(c, checks.retryAfter);
    const me = await sessionUser(auth, c.req.raw.headers);
    if (!me) return c.json({ code: "unauthenticated" }, 401);
    const body = passwordBodySchema.safeParse(await c.req.json().catch(() => undefined));
    if (!body.success) return c.json({ code: "bad_payload" }, 400);
    const code = c.req.param("code");
    const stored = isRoomCode(code)
      ? await rooms.loadPassword(code, me.id, PASSWORD_LIMITS.room.window)
      : null;
    if (!stored) return c.json({ code: "room_not_found" }, 404);
    // No password (removed meanwhile), or the caller needs none (the PO, a participant, a
    // grant holder): nothing to check, and no hash to run.
    if (stored.hash === null || stored.free) return c.body(null, 204);
    // Outside the bounds a password cannot be right: no hash run, and no try counted.
    const password = normalisePassword(body.data.password);
    if (password === null) return c.json({ code: "wrong_password" }, 403);
    const mine = await limiter.reserve(`password|user|${stored.id}|${me.id}`, PASSWORD_LIMITS.user);
    if (!mine.allowed) return rateLimited(c, mine.retryAfter);
    const here = await limiter.reserve(
      `password|ip-room|${stored.id}|${ip}`,
      PASSWORD_LIMITS.addressRoom,
    );
    if (!here.allowed) {
      mine.release();
      return rateLimited(c, here.retryAfter);
    }
    const { window, max } = PASSWORD_LIMITS.room;
    const reserved = await rooms.reserveTry(stored.id, window, max);
    if (!reserved) {
      mine.release();
      here.release();
      return rateLimited(c, stored.retryAfter || null);
    }
    const hash = stored.hash;
    let wrong = false;
    try {
      const right = await gate.run(() => verifyPassword(password, hash));
      if (right === null) return c.json({ code: "busy" }, 503);
      if (!right) {
        wrong = true;
        c.var.log.info({ room: stored.id }, "wrong room password");
        return c.json({ code: "wrong_password" }, 403);
      }
      // Granted only while the room still holds the hash it was checked against: when the
      // PO changed it meanwhile, this password is no longer the room's (not counted).
      if (!(await rooms.grantAccess(stored.id, me.id, hash))) {
        return c.json({ code: "wrong_password" }, 403);
      }
      c.var.log.info({ room: stored.id }, "room access granted");
      return c.body(null, 204);
    } catch (error) {
      if (!(error instanceof CorruptHashError)) throw error;
      c.var.log.error({ room: stored.id }, "room password hash is corrupt");
      return c.json({ code: "internal" }, 500);
    } finally {
      // Only a wrong password keeps its try.
      if (!wrong) {
        mine.release();
        here.release();
        await rooms.releaseTry(stored.id, reserved);
      }
    }
  });
}
