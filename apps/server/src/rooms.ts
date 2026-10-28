/**
 * The room API over HTTP (#14): `POST /api/rooms` creates a room whose product owner is
 * the caller, `GET /api/rooms/:code` returns a room's public header (code, name, and whether
 * it has a password). The
 * room itself (people, the round) travels over the socket (#15), never here.
 */
import {
  cleanRoomName,
  createRoom,
  PRESET_DECK_IDS,
  type PresetDeckId,
  type UserId,
} from "@pp/domain";
import type { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "./app.ts";
import { type Auth, sessionUser } from "./auth.ts";
import type { Config } from "./config.ts";
import type { RoomStore, StoredRoom } from "./db/rooms.ts";
import { foreignOrigin, isJsonBody, rateLimited, requestIp } from "./http.ts";
import type { RateLimiter } from "./rate-limit.ts";
import { generateRoomCode, isRoomCode, type RandomBytes } from "./room-code.ts";

/**
 * Room creations per client address: 20 in 10 minutes. A team behind one office address
 * creates a few rooms a day; a script creating rooms in a loop gets two a minute.
 */
export const ROOM_CREATE_LIMIT = { window: 600, max: 20 } as const;

/**
 * Header reads (`GET /api/rooms/:code`) per client address: 120 a minute. A page load is
 * one read, so a team behind one office address passes; a script guessing codes pays one
 * database query for each and is cut off at two a second.
 */
export const ROOM_HEADER_LIMIT = { window: 60, max: 120 } as const;

/** Codes drawn for one room before giving up (`internal`): a clash is about 1 in 2^58. */
export const CODE_ATTEMPTS = 5;

/** The body of `POST /api/rooms`. Without a deck the room plays Fibonacci (ADR-011). */
export const createRoomBodySchema = z.strictObject({
  name: z.string().optional(),
  deck: z.enum(PRESET_DECK_IDS).optional(),
});

export interface NewRoomRequest {
  ownerId: UserId;
  /** Already cleaned (`cleanRoomName`), or null for a room without a name. */
  name: string | null;
  deck?: PresetDeckId;
}

/**
 * Stores a new room with the default settings (ADR-011) and the chosen deck, the owner as
 * product owner. A code that is already taken is drawn again, up to `CODE_ATTEMPTS`
 * times; resolves null when every draw was taken.
 */
export async function insertNewRoom(
  store: RoomStore,
  { ownerId, name, deck }: NewRoomRequest,
  random?: RandomBytes,
): Promise<StoredRoom | null> {
  const state = createRoom({ ownerId });
  if (deck) state.settings.deck = { kind: "preset", id: deck };
  for (let attempt = 0; attempt < CODE_ATTEMPTS; attempt++) {
    const stored = await store.insertRoom({ code: generateRoomCode(random), name, state });
    if (stored) return stored;
  }
  return null;
}

export interface RoomApiDeps {
  auth: Auth;
  rooms: RoomStore;
  config: Config;
  limiter: RateLimiter;
  /** The code's randomness; `crypto.randomBytes` unless a test stubs it. */
  random?: RandomBytes;
}

/**
 * Mounts `POST /api/rooms` and `GET /api/rooms/:code`, each limited per client address.
 * Every answer is `no-store`; an
 * error is `{ code }` with an `AckErrorCode`, never a sentence. Neither the room code nor
 * the name reaches a log line.
 */
export function registerRoomApi(
  app: Hono<AppEnv>,
  { auth, rooms, config, limiter, random }: RoomApiDeps,
): void {
  app.post("/api/rooms", async (c) => {
    c.header("Cache-Control", "no-store");
    if (foreignOrigin(c, config)) return c.json({ code: "not_allowed" }, 403);
    if (!isJsonBody(c)) return c.json({ code: "bad_payload" }, 415);
    // Counted before the session read, so a flood costs no database query.
    const ip = requestIp(c, config) ?? "unknown";
    const allowed = await limiter.consume(`rooms|create|${ip}`, ROOM_CREATE_LIMIT);
    if (!allowed.allowed) return rateLimited(c, allowed.retryAfter);
    const me = await sessionUser(auth, c.req.raw.headers);
    if (!me) return c.json({ code: "unauthenticated" }, 401);
    const body = createRoomBodySchema.safeParse(await c.req.json().catch(() => undefined));
    if (!body.success) return c.json({ code: "bad_payload" }, 400);
    const { name: rawName, deck } = body.data;
    const name = rawName === undefined ? null : cleanRoomName(rawName);
    if (rawName !== undefined && name === null) return c.json({ code: "bad_room_name" }, 400);
    const stored = await insertNewRoom(rooms, { ownerId: me.id, name, deck }, random);
    if (!stored) {
      c.var.log.error({ attempts: CODE_ATTEMPTS }, "room creation: every code drawn was taken");
      return c.json({ code: "internal" }, 500);
    }
    c.var.log.info({ room: stored.id }, "room created");
    return c.json({ code: stored.code }, 201);
  });

  app.get("/api/rooms/:code", async (c) => {
    c.header("Cache-Control", "no-store");
    // Counted before the query, so a flood of guesses costs the database nothing.
    const ip = requestIp(c, config) ?? "unknown";
    const allowed = await limiter.consume(`rooms|header|${ip}`, ROOM_HEADER_LIMIT);
    if (!allowed.allowed) return rateLimited(c, allowed.retryAfter);
    const code = c.req.param("code");
    // A malformed code cannot name a room: no query.
    const header = isRoomCode(code) ? await rooms.loadRoomHeader(code) : null;
    // The retention period lets the page say how long an idle room is kept (#24).
    if (!header) {
      return c.json({ code: "room_not_found", retentionDays: config.roomTtlDays }, 404);
    }
    // Whether the room asks for a password (#31): the join screen shows its field.
    return c.json({ code: header.code, name: header.name, hasPassword: header.hasPassword });
  });
}
