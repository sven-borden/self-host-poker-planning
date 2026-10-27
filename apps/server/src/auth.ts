/**
 * Identity (#10, ADR-009): Better Auth with the anonymous plugin on the app's Drizzle pool.
 * Every visitor is a guest: a `user` row without personal data and a session cookie. The
 * web app reads `/api/auth/get-session` and, without a session, posts
 * `/api/auth/sign-in/anonymous`; a socket handshake resolves the same cookie.
 *
 * Nothing here connects or listens: `createAuth` only builds the instance, which queries
 * the pool on its first request. Secrets: the signing secret and session tokens never
 * reach a log line, stdout or stderr. A database error's message carries the query's
 * parameters (a session token), so:
 * - Better Auth's logger goes through pino with a fixed message, its error code at most;
 * - `onAPIError.throw` keeps better-call from printing `# SERVER_ERROR` dumps and Better
 *   Auth from printing its own 4xx lines; the handler logs a thrown error's code only;
 * - `sessionUser` turns any failure into a `DatabaseError` holding a code.
 */
import type { IncomingMessage } from "node:http";
import { cleanName } from "@pp/domain";
import { type BetterAuthOptions, betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { isAPIError } from "better-auth/api";
import { anonymous } from "better-auth/plugins";
import { and, eq, gt, sql } from "drizzle-orm";
import type { Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { AppEnv } from "./app.ts";
import { clientIp } from "./client-ip.ts";
import type { Config } from "./config.ts";
import { authSchema, session, user } from "./db/auth-schema.ts";
import { errorCode, guard } from "./db/errors.ts";
import type { Db } from "./db/rooms.ts";
import type { Logger } from "./logger.ts";
import type { SocketMiddleware } from "./realtime.ts";

export const AUTH_BASE_PATH = "/api/auth";

/**
 * The client address as `clientIp` resolves it (`TRUST_PROXY` hops), handed to Better
 * Auth's rate limiter in a header of our own: its own reading of `X-Forwarded-For` only
 * trusts a single entry or a list of proxy addresses, not a hop count. Whatever a client
 * sends under this name is dropped first.
 */
export const CLIENT_IP_HEADER = "x-pp-client-ip";

const DAY_SECONDS = 24 * 60 * 60;

/** A Better Auth log message that is an error code, safe to keep in a log line. */
const AUTH_LOG_CODE = /^[A-Z][A-Z0-9_]{2,63}$/;

/**
 * Anonymous sign-ins per client address: a team behind one office address opening the
 * room link together (30 people within a minute) passes; a script minting guests in a
 * loop is throttled to one a second on average.
 */
export const ANONYMOUS_SIGN_IN_LIMIT = { window: 60, max: 60 } as const;

/** Every other auth endpoint (session reads mostly): Better Auth's default, 100 per 10 s. */
export const AUTH_DEFAULT_LIMIT = { window: 10, max: 100 } as const;

/**
 * Display name changes, per user and per client address (`POST /api/me/name`): typing a
 * name and fixing it a few times passes, a script renaming in a loop does not.
 */
export const RENAME_LIMITS = {
  user: { window: 60, max: 10 },
  ip: { window: 60, max: 60 },
} as const;

/**
 * The only Better Auth endpoints the app forwards, as `METHOD path`. Everything else under
 * `/api/auth` is a JSON 404 before Better Auth (and its limiter, which keeps a counter per
 * path) sees it: `/list-sessions` would hand out raw session tokens, `/update-user` would
 * take any name past the domain's rules (`POST /api/me/name` replaces it).
 */
export const AUTH_ROUTES: ReadonlySet<string> = new Set([
  "GET /get-session",
  "POST /sign-in/anonymous",
  "POST /sign-out",
]);

/** Also refused inside Better Auth, in case it is ever mounted without `registerAuthApi`. */
export const DISABLED_AUTH_PATHS = ["/update-user", "/delete-anonymous-user", "/list-sessions"];

/** Body cap of `/api/auth/*` and `/api/me/*`: their bodies are `{}` or a name. */
export const AUTH_BODY_LIMIT_BYTES = 4 * 1024;

/** Every cookie Better Auth may set; each gets its name from `cookieNaming`. */
const AUTH_COOKIES = ["session_token", "session_data", "account_data", "dont_remember"] as const;

/**
 * The cookie names for a `BASE_URL`. On https: `__Host-pp.*`, which the browser accepts
 * only with `Secure`, `Path=/` and no `Domain`, so a sibling site (`other.example.com`)
 * cannot plant a session cookie of its own that would be sent first (`__Secure-` allows a
 * `Domain`). On http (a LAN address, compose without TLS): `pp.*` without `Secure`, so
 * the browser keeps the cookie at all.
 */
export function cookieNaming(baseUrl: string): { secure: boolean; sessionCookie: string } {
  const secure = new URL(baseUrl).protocol === "https:";
  return { secure, sessionCookie: `${cookiePrefix(secure)}session_token` };
}

const cookiePrefix = (secure: boolean) => (secure ? "__Host-pp." : "pp.");

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

export type RateLimiter = RateLimitStorage;

/** At most this many counters live at once; the oldest tenth goes when it is reached. */
export const RATE_LIMIT_MAX_KEYS = 50_000;
/** Expired counters are swept at most this often. */
const SWEEP_EVERY_MS = 30_000;

/**
 * A fixed-window counter per key (`ip|path`, or `rename|…`), in this process. Better
 * Auth's own memory store is one map shared by every instance in the process, which would
 * leak counts between tests; this one belongs to its `setupServer`. With several
 * instances (#39) each counts on its own.
 *
 * Memory stays bounded and each call costs O(1) amortized: expired counters are swept
 * every 30 s, and at `maxKeys` the oldest tenth (by window start) is dropped at once.
 */
export function memoryRateLimit(
  now: () => number = Date.now,
  maxKeys: number = RATE_LIMIT_MAX_KEYS,
): RateLimitStorage {
  const windows = new Map<string, { count: number; resetAt: number }>();
  let nextSweep = 0;
  return {
    consume: async (key, { window, max }) => {
      const at = now();
      if (at >= nextSweep) {
        nextSweep = at + SWEEP_EVERY_MS;
        for (const [k, entry] of windows) if (entry.resetAt <= at) windows.delete(k);
      }
      const entry = windows.get(key);
      if (!entry || entry.resetAt <= at) {
        // Re-inserted, so the map stays ordered by window start.
        windows.delete(key);
        if (windows.size >= maxKeys) {
          let drop = Math.max(1, Math.floor(maxKeys / 10));
          for (const k of windows.keys()) {
            windows.delete(k);
            if (--drop === 0) break;
          }
        }
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

export function authOptions(
  config: Config,
  db: Db,
  logger: Logger,
  limiter: RateLimiter = memoryRateLimit(),
) {
  const { secure } = cookieNaming(config.baseUrl);
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
      customStorage: limiter,
      customRules: { "/sign-in/anonymous": ANONYMOUS_SIGN_IN_LIMIT },
    },
    advanced: {
      // Names come from `cookieNaming` (`__Host-pp.*` on https, `pp.*` on http), so Better
      // Auth's own `__Secure-` prefix stays off; `Secure` follows the protocol.
      cookiePrefix: "pp",
      useSecureCookies: false,
      cookies: Object.fromEntries(
        AUTH_COOKIES.map((name) => [name, { name: `${cookiePrefix(secure)}${name}` }]),
      ),
      defaultCookieAttributes: { httpOnly: true, sameSite: "lax", path: "/", secure },
      ipAddress: { ipAddressHeaders: [CLIENT_IP_HEADER] },
    },
    disabledPaths: DISABLED_AUTH_PATHS,
    telemetry: { enabled: false },
    // Better Auth logs errors with the error object as an argument, sometimes as the
    // message: only a message that is one of its error codes (`INTERNAL_SERVER_ERROR`)
    // is kept, as `code`, and nothing else.
    logger: {
      level: "warn",
      disableColors: true,
      log: (level, message) =>
        log[level](
          typeof message === "string" && AUTH_LOG_CODE.test(message) ? { code: message } : {},
          "better-auth reported a problem",
        ),
    },
    // Errors are thrown to `registerAuthApi` instead of being printed: better-call would
    // print a thrown error whole to stderr (`# SERVER_ERROR`), and Better Auth its 4xx
    // messages. An APIError still becomes its own response.
    onAPIError: { throw: true },
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

export function createAuth(config: Config, db: Db, logger: Logger, limiter?: RateLimiter) {
  return betterAuth(authOptions(config, db, logger, limiter));
}

export type Auth = ReturnType<typeof createAuth>;

/**
 * The session behind a request's cookies, or null (a refusal of Better Auth's, 4xx, counts
 * as no session). Any other failure rejects with a `DatabaseError` holding its code only:
 * Better Auth's error carries the driver's error, whose message holds the session token.
 */
export async function sessionUser(auth: Auth, headers: Headers): Promise<SocketUser | null> {
  return (await sessionOf(auth, headers))?.user ?? null;
}

/** `sessionUser` plus the session's id (not its token), which a socket keeps. */
export async function sessionOf(
  auth: Auth,
  headers: Headers,
): Promise<{ user: SocketUser; sessionId: string } | null> {
  const result = await guard("read session", () =>
    auth.api.getSession({ headers, query: { disableRefresh: true } }).catch((error: unknown) => {
      if (isAPIError(error) && error.statusCode < 500) return null;
      throw error;
    }),
  );
  if (!result) return null;
  return {
    user: {
      id: result.user.id,
      name: result.user.name,
      isAnonymous: result.user.isAnonymous === true,
    },
    sessionId: result.session.id,
  };
}

/**
 * Whether a session still exists and has not expired. A socket outlives a sign-out and the
 * deletion of its user (the session row goes with the user), so the room sync asks again
 * on every `enter`. One indexed lookup by primary key; a failure is a `DatabaseError`.
 */
export function sessionChecker(db: Db): (sessionId: string) => Promise<boolean> {
  return async (sessionId) => {
    const rows = await guard("check session", () =>
      db
        .select({ id: session.id })
        .from(session)
        .where(and(eq(session.id, sessionId), gt(session.expiresAt, sql`now()`))),
    );
    return rows.length === 1;
  };
}

export type AuthErrorCode =
  | "bad_payload"
  | "unauthenticated"
  | "rate_limited"
  | "not_allowed"
  | "internal";

/**
 * Maps a Better Auth error answer (its status and its own `code`) to the app's code.
 * A guest's second anonymous sign-in (`ANONYMOUS_USERS_CANNOT_SIGN_IN_AGAIN_ANONYMOUSLY`,
 * two tabs bootstrapping at once) is `not_allowed`: the web app then reads the session.
 */
export function authErrorCode(status: number, betterAuthCode: unknown): AuthErrorCode {
  if (status >= 500) return "internal";
  if (status === 429) return "rate_limited";
  if (status === 401) return "unauthenticated";
  if (status === 403 || betterAuthCode === "ANONYMOUS_USERS_CANNOT_SIGN_IN_AGAIN_ANONYMOUSLY") {
    return "not_allowed";
  }
  return "bad_payload";
}

/** A copy of a JSON value without any `token` key: the cookie carries the session. */
export function withoutTokens(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutTokens);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== "token")
      .map(([key, inner]) => [key, withoutTokens(inner)]),
  );
}

/** `response` with another JSON body; its other headers (Set-Cookie included) are kept. */
function rewrite(response: Response, body: unknown, extra: Record<string, string> = {}): Response {
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  headers.set("content-type", "application/json");
  for (const [name, value] of Object.entries(extra)) headers.set(name, value);
  return new Response(JSON.stringify(body), { status: response.status, headers });
}

async function jsonOf(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

function codeOf(json: unknown): unknown {
  return typeof json === "object" && json !== null ? Reflect.get(json, "code") : undefined;
}

/** The client address of a request, as every rate limit sees it (`TRUST_PROXY` hops). */
function requestIp(c: Context<AppEnv>, config: Config): string | undefined {
  const incoming = (c.env as { incoming?: IncomingMessage } | undefined)?.incoming;
  return incoming ? clientIp(incoming, config.trustProxy) : undefined;
}

function rateLimited(c: Context<AppEnv>, retryAfter: number | null | undefined) {
  c.header("Retry-After", String(retryAfter ?? 60));
  c.header("Cache-Control", "no-store");
  return c.json({ code: "rate_limited" }, 429);
}

/**
 * Mounts the allowed Better Auth endpoints (`AUTH_ROUTES`) under `/api/auth/*` and
 * `POST /api/me/name`. Each auth request gets the client address in `CLIENT_IP_HEADER`,
 * resolved by `clientIp` as every other rate limit does; a client's own copy of that
 * header is dropped. Answers carry the app's codes, never Better Auth's sentences, and no
 * `token` field.
 */
export function registerAuthApi(
  app: Hono<AppEnv>,
  { auth, db, config, limiter }: { auth: Auth; db: Db; config: Config; limiter: RateLimiter },
): void {
  const limitBody = bodyLimit({
    maxSize: AUTH_BODY_LIMIT_BYTES,
    onError: (c) => {
      c.header("Cache-Control", "no-store");
      return c.json({ code: "bad_payload" }, 413);
    },
  });
  app.use(`${AUTH_BASE_PATH}/*`, limitBody);
  app.use("/api/me/*", limitBody);

  app.on(["GET", "POST"], `${AUTH_BASE_PATH}/*`, async (c) => {
    if (!AUTH_ROUTES.has(`${c.req.method} ${c.req.path.slice(AUTH_BASE_PATH.length)}`)) {
      return c.notFound();
    }
    // Better Auth checks the Origin too, but skips it when NODE_ENV is test: this check
    // holds everywhere. A browser always sends Origin on a POST.
    const origin = c.req.header("origin");
    if (c.req.method === "POST" && origin !== undefined && origin !== config.baseUrl) {
      c.header("Cache-Control", "no-store");
      return c.json({ code: "not_allowed" }, 403);
    }
    const ip = requestIp(c, config);
    const headers = new Headers(c.req.raw.headers);
    headers.delete(CLIENT_IP_HEADER);
    if (ip) headers.set(CLIENT_IP_HEADER, ip);
    let response: Response;
    try {
      response = await auth.handler(new Request(c.req.raw, { headers }));
    } catch (error) {
      // Never the error itself: its message or its cause's can hold a session token.
      c.var.log.error({ code: errorCode(error) }, "auth request failed");
      c.header("Cache-Control", "no-store");
      return c.json({ code: "internal" }, 500);
    }
    if (response.status === 404) return c.notFound();
    if (response.status >= 400) {
      const code = authErrorCode(response.status, codeOf(await jsonOf(response)));
      const extra: Record<string, string> = { "cache-control": "no-store" };
      if (code === "rate_limited") {
        extra["retry-after"] = response.headers.get("x-retry-after") ?? "60";
      }
      return rewrite(response, { code }, extra);
    }
    if (!response.headers.get("content-type")?.includes("application/json")) return response;
    return rewrite(response, withoutTokens(await jsonOf(response)));
  });

  // The display name, cleaned by the domain's rules (32 characters, whitespace collapsed,
  // well-formed, nothing invisible). A browser always sends Origin on a POST: another
  // origin is refused, and a JSON body cannot come from a plain cross-site form.
  app.post("/api/me/name", async (c) => {
    c.header("Cache-Control", "no-store");
    const origin = c.req.header("origin");
    if (origin !== undefined && origin !== config.baseUrl) {
      return c.json({ code: "not_allowed" }, 403);
    }
    if (!c.req.header("content-type")?.toLowerCase().startsWith("application/json")) {
      return c.json({ code: "bad_payload" }, 415);
    }
    const ipKey = `rename|ip|${requestIp(c, config) ?? "unknown"}`;
    const byIp = await limiter.consume(ipKey, RENAME_LIMITS.ip);
    if (!byIp.allowed) return rateLimited(c, byIp.retryAfter);
    const me = await sessionUser(auth, c.req.raw.headers);
    if (!me) return c.json({ code: "unauthenticated" }, 401);
    const byUser = await limiter.consume(`rename|user|${me.id}`, RENAME_LIMITS.user);
    if (!byUser.allowed) return rateLimited(c, byUser.retryAfter);
    const body: unknown = await c.req.json().catch(() => undefined);
    const raw = typeof body === "object" && body !== null ? Reflect.get(body, "name") : undefined;
    const name = cleanName(raw);
    if (name === null) return c.json({ code: "bad_name" }, 400);
    await guard("rename user", () =>
      db.update(user).set({ name, updatedAt: new Date() }).where(eq(user.id, me.id)),
    );
    return c.json({ name });
  });
}

/**
 * The socket handshake: resolves the session from the handshake's cookie and sets
 * `socket.data.user`. No cookie, an unknown, expired or revoked session, or a forged one:
 * `connect_error` with `unauthenticated`. Also keeps the session's id on `socket.data`, for
 * the room sync's check on `enter`. A database failure rejects, which the realtime
 * guard turns into `internal`. Never refreshes the session (a socket cannot set a
 * cookie) and never logs the cookie.
 */
export function sessionMiddleware(auth: Auth): SocketMiddleware {
  return async (socket, next) => {
    const cookie = socket.request.headers.cookie;
    const me = cookie ? await sessionOf(auth, new Headers({ cookie })) : null;
    if (!me) {
      next(new Error("unauthenticated"));
      return;
    }
    socket.data.user = me.user;
    socket.data.sessionId = me.sessionId;
    next();
  };
}
