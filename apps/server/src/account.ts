/**
 * The account page over HTTP (#51, ADR-029), for a signed-in person only: a guest is refused here,
 * not only on the page.
 *
 * - `GET /api/account`: what a deletion would do, and whether the session is recent enough for one,
 *   after finishing a guest's move still pending (ADR-025);
 * - `GET /api/account/export`: a JSON file of the person's own data;
 * - `POST /api/account/delete { confirm, rooms }`: starts the deletion (`account-deletion.ts`).
 *
 * A deletion takes a session started in the last `RECENT_SIGN_IN_MS`, and the typed word, both
 * checked here: a browser left open or a copied cookie deletes nothing, and the page's dialog is
 * not the guard.
 *
 * The file holds no room code: a code is a bearer capability, and this file may travel. It names
 * rooms by name and id, and it holds nothing of anyone else. Every answer is `no-store`; an error
 * is `{ code }`. Nothing here logs a person's id, name or address.
 */
import { ACCOUNT_EXPORT_VERSION, isAccountDeleteWord, userIdSchema } from "@pp/protocol";
import type { Context, Hono } from "hono";
import { z } from "zod";
import type { AccountDeletions } from "./account-deletion.ts";
import type { AppEnv } from "./app.ts";
import { type Auth, type SocketUser, sessionOf } from "./auth.ts";
import type { Config } from "./config.ts";
import type { AccountDataStore } from "./db/account-data.ts";
import type { RoomChoices } from "./db/account-deletions.ts";
import { accountOf, type ConnectorTokenStore } from "./db/connector-tokens.ts";
import type { GuestLinks } from "./guest-link.ts";
import { foreignOrigin, isJsonBody, rateLimited } from "./http.ts";
import type { RateLimiter, RateLimitRule } from "./rate-limit.ts";

/** How old a session may be for a deletion: a browser left open is older than this. */
export const RECENT_SIGN_IN_MS = 15 * 60 * 1000;

/** Reads of the page, per person: a page load and a few reloads. */
export const ACCOUNT_READ_LIMIT = { window: 60, max: 30 } as const;

/** Exports per person: each reads all the person's rooms and rounds. */
export const ACCOUNT_EXPORT_LIMIT = { window: 600, max: 5 } as const;

/** Deletions per person: a person does this once, and a retry or two after a failure. */
export const ACCOUNT_DELETE_LIMIT = { window: 600, max: 5 } as const;

/** How long the page and a deletion wait for a guest's move still pending. */
export const ACCOUNT_SETTLE_MS = 1000;

/** How long an export waits for the same: the file should hold the guest's rooms. */
export const EXPORT_SETTLE_MS = 5000;

/** Choices in one request; only a room the person changed needs one, and the body caps it anyway. */
export const MAX_ROOM_CHOICES = 150;

const roomId = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);

const deleteBodySchema = z.strictObject({
  confirm: z.string().max(32),
  rooms: z
    .array(
      z.union([
        z.strictObject({ id: roomId, delete: z.literal(true) }),
        z.strictObject({ id: roomId, to: userIdSchema }),
      ]),
    )
    .max(MAX_ROOM_CHOICES),
});

export interface AccountApiDeps {
  auth: Auth;
  data: AccountDataStore;
  tokens: Pick<ConnectorTokenStore, "listConnections">;
  deletions: Pick<AccountDeletions, "start">;
  links: Pick<GuestLinks, "settle">;
  config: Config;
  limiter: RateLimiter;
}

interface Asker {
  user: SocketUser;
  recent: boolean;
}

export function registerAccountApi(
  app: Hono<AppEnv>,
  { auth, data, tokens, deletions, links, config, limiter }: AccountApiDeps,
): void {
  /**
   * What every route checks, in order: the origin, the session, that it is an account, the
   * person's limit. Answers the person, or the refusal to send back.
   */
  async function asker(
    c: Context<AppEnv>,
    bucket: string,
    limit: RateLimitRule,
  ): Promise<Asker | Response> {
    c.header("Cache-Control", "no-store");
    if (foreignOrigin(c, config)) return c.json({ code: "not_allowed" }, 403);
    const me = await sessionOf(auth, c.req.raw.headers);
    if (!me) return c.json({ code: "unauthenticated" }, 401);
    if (me.user.isAnonymous) return c.json({ code: "not_allowed" }, 403);
    const allowed = await limiter.consume(`account|${bucket}|${me.user.id}`, limit);
    if (!allowed.allowed) return rateLimited(c, allowed.retryAfter);
    return { user: me.user, recent: Date.now() - me.startedAt <= RECENT_SIGN_IN_MS };
  }

  app.get("/api/account", async (c) => {
    const me = await asker(c, "read", ACCOUNT_READ_LIMIT);
    if (me instanceof Response) return me;
    const settled = await links.settle(me.user.id, ACCOUNT_SETTLE_MS);
    const { alone, seats, shared } = await data.overview(me.user.id);
    return c.json({
      recent: me.recent,
      retentionDays: config.roomTtlDays,
      alone,
      seats,
      shared: shared.map((room) => ({
        ...room,
        lastActiveAt: room.lastActiveAt.toISOString(),
      })),
      ...(!settled && { moving: true }),
    });
  });

  app.get("/api/account/export", async (c) => {
    const me = await asker(c, "export", ACCOUNT_EXPORT_LIMIT);
    if (me instanceof Response) return me;
    const id = accountOf(me.user);
    if (id === undefined) return c.json({ code: "not_allowed" }, 403);
    const settled = await links.settle(id, EXPORT_SETTLE_MS);
    const [person, rooms, grants, votes, connections] = await Promise.all([
      data.profile(id),
      data.rooms(id),
      data.grants(id),
      data.votes(id),
      tokens.listConnections(id),
    ]);
    if (!person) return c.json({ code: "unauthenticated" }, 401);
    const file = {
      format: "poker-planning-account",
      version: ACCOUNT_EXPORT_VERSION,
      exportedAt: new Date().toISOString(),
      ...(!settled && { incomplete: true }),
      ...person,
      rooms,
      grants,
      votes,
      connections: connections.map(({ connector }) => connector),
    };
    c.header("Content-Type", "application/json; charset=utf-8");
    c.header("Content-Disposition", 'attachment; filename="poker-planning-account.json"');
    return c.body(JSON.stringify(file, null, 2));
  });

  app.post("/api/account/delete", async (c) => {
    if (!isJsonBody(c)) {
      c.header("Cache-Control", "no-store");
      return c.json({ code: "bad_payload" }, 415);
    }
    const me = await asker(c, "delete", ACCOUNT_DELETE_LIMIT);
    if (me instanceof Response) return me;
    if (!me.recent) return c.json({ code: "sign_in_again" }, 403);
    const body = deleteBodySchema.safeParse(await c.req.json().catch(() => undefined));
    if (!body.success) return c.json({ code: "bad_payload" }, 400);
    if (!isAccountDeleteWord(body.data.confirm)) return c.json({ code: "bad_confirmation" }, 400);
    await links.settle(me.user.id, ACCOUNT_SETTLE_MS);
    const choices: RoomChoices = Object.fromEntries(
      body.data.rooms.map((choice) => [
        choice.id,
        "to" in choice ? { to: choice.to } : { delete: true as const },
      ]),
    );
    const finished = await deletions.start(me.user.id, choices);
    c.var.log.info({ finished }, "account deletion asked for");
    return c.json({ finished });
  });
}
