/**
 * Identity (#10, ADR-009): Better Auth with the anonymous plugin on the app's Drizzle pool.
 * Every visitor is a guest: a `user` row without personal data and a session cookie. The
 * web app reads `/api/auth/get-session` and, without a session, posts
 * `/api/auth/sign-in/anonymous`; a socket handshake resolves the same cookie.
 *
 * Nothing here connects or listens: `createAuth` only builds the instance, which queries
 * the pool on its first request. Secrets: the signing secret and session tokens never
 * reach a log line; Better Auth's own log calls keep their message and drop their
 * arguments (errors, objects).
 */
import type { IncomingMessage } from "node:http";
import { cleanName } from "@pp/domain";
import { type BetterAuthOptions, betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { anonymous } from "better-auth/plugins";
import { eq } from "drizzle-orm";
import type { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { AppEnv } from "./app.ts";
import { clientIp } from "./client-ip.ts";
import type { Config } from "./config.ts";
import { authSchema, user } from "./db/auth-schema.ts";
import { guard } from "./db/errors.ts";
import type { Db } from "./db/rooms.ts";
import type { Logger } from "./logger.ts";
import { MAX_PAYLOAD_BYTES, type SocketMiddleware } from "./realtime.ts";

export const AUTH_BASE_PATH = "/api/auth";

/**
 * The client address as `clientIp` resolves it (`TRUST_PROXY` hops), handed to Better
 * Auth's rate limiter in a header of our own: its own reading of `X-Forwarded-For` only
 * trusts a single entry or a list of proxy addresses, not a hop count. Whatever a client
 * sends under this name is dropped first.
 */
export const CLIENT_IP_HEADER = "x-pp-client-ip";

const DAY_SECONDS = 24 * 60 * 60;

/**
 * Anonymous sign-ins per client address: a team behind one office address opening the
 * room link together (30 people within a minute) passes; a script minting guests in a
 * loop is throttled to one a second on average.
 */
export const ANONYMOUS_SIGN_IN_LIMIT = { window: 60, max: 60 } as const;

/** Every other auth endpoint (session reads mostly): Better Auth's default, 100 per 10 s. */
export const AUTH_DEFAULT_LIMIT = { window: 10, max: 100 } as const;

/**
 * Endpoints Better Auth mounts that this app does not use. `/update-user` would take any
 * name (and an image URL) past the domain's rules: `POST /api/me/name` replaces it.
 */
export const DISABLED_AUTH_PATHS = ["/update-user", "/delete-anonymous-user"];

/** What a handler knows about the person behind a socket: `socket.data.user`. */
export interface SocketUser {
  /** Better Auth's user id (32 alphanumeric characters); passes `userIdSchema`. */
  readonly id: string;
  /** The display name; "" until the person picks one (#16). */
  readonly name: string;
  /** True for a guest; false once W5 links a Google or Microsoft account. */
  readonly isAnonymous: boolean;
}

type RateLimitStorage = NonNullable<NonNullable<BetterAuthOptions["rateLimit"]>["customStorage"]>;

/**
 * A fixed-window counter per key (`ip|path`), in this process. Better Auth's own memory
 * store is one map shared by every instance in the process, which would leak counts
 * between tests; this one belongs to its `createAuth`. With several instances (#39) each
 * counts on its own.
 */
export function memoryRateLimit(now: () => number = Date.now): RateLimitStorage {
  const windows = new Map<string, { count: number; resetAt: number }>();
  return {
    consume: async (key, { window, max }) => {
      const at = now();
      if (windows.size > 10_000) {
        for (const [k, entry] of windows) if (entry.resetAt <= at) windows.delete(k);
      }
      const entry = windows.get(key);
      if (!entry || entry.resetAt <= at) {
        windows.set(key, { count: 1, resetAt: at + window * 1000 });
        return { allowed: true, retryAfter: null };
      }
      if (entry.count >= max) {
        return { allowed: false, retryAfter: Math.ceil((entry.resetAt - at) / 1000) };
      }
      entry.count += 1;
      return { allowed: true, retryAfter: null };
    },
  };
}

export function authOptions(config: Config, db: Db, logger: Logger) {
  const secure = new URL(config.baseUrl).protocol === "https:";
  const log = logger.child({ source: "better-auth" });
  return {
    appName: "Poker Planning",
    baseURL: config.baseUrl,
    basePath: AUTH_BASE_PATH,
    secret: config.betterAuthSecret,
    trustedOrigins: [config.baseUrl],
    database: drizzleAdapter(db, { provider: "pg", schema: authSchema }),
    emailAndPassword: { enabled: false },
    // Guests keep their identity as long as their rooms live: a session lasts
    // ROOM_TTL_DAYS after the last visit; a visit extends it at most once a day.
    session: { expiresIn: config.roomTtlDays * DAY_SECONDS, updateAge: DAY_SECONDS },
    rateLimit: {
      enabled: true,
      ...AUTH_DEFAULT_LIMIT,
      customStorage: memoryRateLimit(),
      customRules: { "/sign-in/anonymous": ANONYMOUS_SIGN_IN_LIMIT },
    },
    advanced: {
      cookiePrefix: "pp",
      // https: `Secure` and the `__Secure-` prefix on every cookie.
      useSecureCookies: secure,
      defaultCookieAttributes: { httpOnly: true, sameSite: "lax", path: "/", secure },
      ipAddress: { ipAddressHeaders: [CLIENT_IP_HEADER] },
    },
    disabledPaths: DISABLED_AUTH_PATHS,
    telemetry: { enabled: false },
    logger: {
      level: "warn",
      log: (level, message) => log[level](message),
    },
    databaseHooks: {
      user: {
        create: {
          // The plugin names a guest "Anonymous", in English: store "" instead, so the
          // web app knows to ask for a name (#16) in the reader's language.
          before: async (data) => ({ data: { ...data, name: data.isAnonymous ? "" : data.name } }),
        },
      },
      session: {
        create: {
          // No tracking by default: neither the address nor the user agent is stored.
          before: async (data) => ({ data: { ...data, ipAddress: null, userAgent: null } }),
        },
      },
    },
    plugins: [anonymous()],
  } satisfies BetterAuthOptions;
}

export function createAuth(config: Config, db: Db, logger: Logger) {
  return betterAuth(authOptions(config, db, logger));
}

export type Auth = ReturnType<typeof createAuth>;

/** The session behind a request's cookies, or null. Rejects when the database fails. */
export async function sessionUser(auth: Auth, headers: Headers): Promise<SocketUser | null> {
  const result = await auth.api.getSession({ headers, query: { disableRefresh: true } });
  if (!result) return null;
  return {
    id: result.user.id,
    name: result.user.name,
    isAnonymous: result.user.isAnonymous === true,
  };
}

/**
 * Mounts Better Auth under `/api/auth/*` and `POST /api/me/name`. Each auth request gets
 * the client address in `CLIENT_IP_HEADER`, resolved by `clientIp` as every other rate
 * limit does; a client's own copy of that header is dropped.
 */
export function registerAuthApi(
  app: Hono<AppEnv>,
  { auth, db, config }: { auth: Auth; db: Db; config: Config },
): void {
  app.on(["GET", "POST"], `${AUTH_BASE_PATH}/*`, async (c) => {
    const incoming = (c.env as { incoming?: IncomingMessage } | undefined)?.incoming;
    const ip = incoming ? clientIp(incoming, config.trustProxy) : undefined;
    const headers = new Headers(c.req.raw.headers);
    headers.delete(CLIENT_IP_HEADER);
    if (ip) headers.set(CLIENT_IP_HEADER, ip);
    const response = await auth.handler(new Request(c.req.raw, { headers }));
    // The server answers with codes, never sentences: Better Auth's plain "Not Found", its
    // English throttle message and its 5xx bodies become the app's codes.
    if (response.status === 404) return c.notFound();
    if (response.status === 429) {
      c.header("Retry-After", response.headers.get("x-retry-after") ?? "60");
      c.header("Cache-Control", "no-store");
      return c.json({ code: "rate_limited" }, 429);
    }
    if (response.status >= 500) {
      c.header("Cache-Control", "no-store");
      return c.json({ code: "internal" }, 500);
    }
    return response;
  });

  // The display name, cleaned by the domain's rules (32 characters, whitespace collapsed,
  // well-formed). A browser always sends Origin on a POST: another origin is refused, and
  // a JSON body cannot come from a plain cross-site form.
  app.post(
    "/api/me/name",
    bodyLimit({
      maxSize: MAX_PAYLOAD_BYTES,
      onError: (c) => c.json({ code: "bad_payload" }, 413),
    }),
    async (c) => {
      c.header("Cache-Control", "no-store");
      const origin = c.req.header("origin");
      if (origin !== undefined && origin !== config.baseUrl) {
        return c.json({ code: "forbidden" }, 403);
      }
      if (!c.req.header("content-type")?.toLowerCase().startsWith("application/json")) {
        return c.json({ code: "bad_payload" }, 415);
      }
      const me = await sessionUser(auth, c.req.raw.headers);
      if (!me) return c.json({ code: "unauthenticated" }, 401);
      const body: unknown = await c.req.json().catch(() => undefined);
      const raw = typeof body === "object" && body !== null ? Reflect.get(body, "name") : undefined;
      const name = cleanName(raw);
      if (name === null) return c.json({ code: "bad_name" }, 400);
      await guard("rename user", () =>
        db.update(user).set({ name, updatedAt: new Date() }).where(eq(user.id, me.id)),
      );
      return c.json({ name });
    },
  );
}

/**
 * The socket handshake: resolves the session from the handshake's cookie and sets
 * `socket.data.user`. No cookie, an unknown, expired or revoked session, or a forged one:
 * `connect_error` with `unauthenticated`. A database failure rejects, which the realtime
 * guard turns into `internal`. Never refreshes the session (a socket cannot set a
 * cookie) and never logs the cookie.
 */
export function sessionMiddleware(auth: Auth): SocketMiddleware {
  return async (socket, next) => {
    const cookie = socket.request.headers.cookie;
    const me = cookie ? await sessionUser(auth, new Headers({ cookie })) : null;
    if (!me) {
      next(new Error("unauthenticated"));
      return;
    }
    socket.data.user = me;
    next();
  };
}
