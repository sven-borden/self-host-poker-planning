/**
 * Identity (#10, ADR-009): Better Auth with the anonymous plugin on the app's Drizzle pool.
 * Every visitor is a guest: a `user` row without personal data and a session cookie. The
 * web app reads `/api/auth/get-session` and, without a session, posts
 * `/api/auth/sign-in/anonymous`; a socket handshake resolves the same cookie. A person may
 * sign in with Google or Microsoft (#47, `social-sign-in.ts`, ADR-023).
 *
 * Nothing here connects or listens: `createAuth` only builds the instance, which queries
 * the pool on its first request. Secrets: the signing secret and session tokens never
 * reach a log line, stdout or stderr. A database error's message carries the query's
 * parameters (a session token), so:
 * - Better Auth's logger goes through pino with a fixed message, its error code at most;
 * - `onAPIError.throw` keeps better-call from printing `# SERVER_ERROR` dumps and Better
 *   Auth from printing its own 4xx lines; the handler logs a thrown error's code only;
 * - `sessionUser` turns any failure into a `DatabaseError` holding a code;
 * - a provider's callback answers with a redirect whatever happened (`signInOutcome`), and
 *   logs the code and a reason from a fixed list, never the query it came with.
 *
 * A provider's tokens are not kept: nothing here calls a provider after sign-in. The account
 * hooks below clear them before the row is written.
 *
 * A guest who signs in keeps everything they hold (#48, ADR-025): `onLinkAccount` hands the
 * guest and the account to `guest-link.ts`. A plain error from it ends the sign-in with no
 * cookie, and the person stays the guest they were; Better Auth would let an `APIError` through
 * with the new session's cookie still on the answer, so none is thrown there.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { cleanName, isAvatarId } from "@pp/domain";
import { SIGN_IN_ERROR_PARAM } from "@pp/protocol";
import { type BetterAuthOptions, betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { isAPIError } from "better-auth/api";
import { anonymous } from "better-auth/plugins";
import { and, eq, gt, sql } from "drizzle-orm";
import type { Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import type { AppEnv } from "./app.ts";
import type { Config } from "./config.ts";
import { authSchema, session, user } from "./db/auth-schema.ts";
import { errorCode, guard } from "./db/errors.ts";
import type { Db } from "./db/rooms.ts";
import type { GuestLinks } from "./guest-link.ts";
import { foreignOrigin, isJsonBody, rateLimited, requestIp } from "./http.ts";
import type { Logger } from "./logger.ts";
import { memoryRateLimit, type RateLimiter } from "./rate-limit.ts";
import type { SocketMiddleware } from "./realtime.ts";
import {
  claimedAddress,
  idTokenClaims,
  isAlarming,
  SOCIAL_SIGN_IN_LIMIT,
  signInOutcome,
  signInRequest,
  socialProviderOptions,
  socialRoutes,
  tenantRefusal,
} from "./social-sign-in.ts";

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
 * name and fixing it a few times passes, a script renaming in a loop does not. An avatar
 * change (`POST /api/me/avatar`) counts the same, in buckets of its own.
 */
export const RENAME_LIMITS = {
  user: { window: 60, max: 10 },
  ip: { window: 60, max: 60 },
} as const;

/**
 * The only Better Auth endpoints the app forwards, as `METHOD path`, spelled exactly. Everything
 * else under `/api/auth`, an encoded spelling of these included, is a JSON 404 before Better
 * Auth (and its limiter, which keeps a counter per path) sees it: `/list-sessions` would hand
 * out raw session tokens, `/update-user` would take any name past the domain's rules
 * (`POST /api/me/name` replaces it).
 */
export const AUTH_ROUTES: ReadonlySet<string> = new Set([
  "GET /get-session",
  "POST /sign-in/anonymous",
  "POST /sign-out",
]);

/** Also refused inside Better Auth, in case it is ever mounted without `registerAuthApi`. */
export const DISABLED_AUTH_PATHS = [
  "/update-user",
  "/delete-anonymous-user",
  "/list-sessions",
  "/list-accounts",
  "/link-social",
  "/unlink-account",
  "/get-access-token",
  "/refresh-token",
  "/account-info",
];

/** Body cap of `/api/auth/*` and `/api/me/*`: their bodies are `{}` or a name. */
export const AUTH_BODY_LIMIT_BYTES = 4 * 1024;

/** Every cookie Better Auth may set; each gets its name from `cookieNaming`. */
const AUTH_COOKIES = [
  "session_token",
  "session_data",
  "account_data",
  "dont_remember",
  // The signed `state` of a sign-in in progress (#47), read back on the provider's callback.
  "state",
] as const;

/**
 * A sign-in may wait at the provider as long as its `verification` row lives (10 minutes): Better
 * Auth's 5 for this cookie would end a sign-in through MFA or a password reset in `failed`.
 */
const STATE_COOKIE_SECONDS = 600;

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

/**
 * What a provider's answer leaves in an `account` row: nothing that could call the provider
 * again, in the clear or otherwise, so a stolen backup holds no way into anyone's account.
 */
const NO_PROVIDER_TOKENS = {
  accessToken: null,
  refreshToken: null,
  idToken: null,
  accessTokenExpiresAt: null,
  refreshTokenExpiresAt: null,
};

/**
 * The Microsoft tenant in an id token (`tid`), kept for #50's rooms limited to a tenant: the
 * token itself is not kept, and it came straight from the provider's token endpoint over TLS.
 */
function microsoftTenant(providerId: string, idToken: string | null | undefined): string | null {
  if (providerId !== "microsoft") return null;
  const tenant = idTokenClaims(idToken ?? undefined)?.tid;
  return typeof tenant === "string" ? tenant : null;
}

/** The address a Microsoft token claims, which is kept beside `tid` and proves nothing. */
function microsoftClaim(providerId: string, idToken: string | null | undefined): string | null {
  return providerId === "microsoft" ? claimedAddress(idTokenClaims(idToken ?? undefined)) : null;
}

/**
 * Set while a provider's callback runs. Anyone can send one, so Better Auth's lines about it
 * stay out of the error reports (`debug`; they hold no more than a fixed message): `finishSignIn`
 * writes the one line that says what came of it, at `error` when someone should look.
 * `stillMoving`: the person is signed in, and the page should hear that a room has yet to move.
 */
const inCallback = new AsyncLocalStorage<{ stillMoving: boolean }>();

/** What a handler knows about the person behind a socket: `socket.data.user`. */
export interface SocketUser {
  /** Better Auth's user id (32 alphanumeric characters); passes `userIdSchema`. */
  readonly id: string;
  /** The display name; "" until the person picks one (#16). */
  readonly name: string;
  /** True for a guest; false for an account (Google or Microsoft, #47). */
  readonly isAnonymous: boolean;
}

export function authOptions(
  config: Config,
  db: Db,
  logger: Logger,
  limiter: RateLimiter = memoryRateLimit(),
  links?: Pick<GuestLinks, "link">,
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
    socialProviders: socialProviderOptions(config),
    account: {
      // In the database, whatever the default becomes: the return path (a room's code) stays
      // on the server, and only a random `state` travels through the provider.
      storeStateStrategy: "database",
      // Nothing to refresh: a later sign-in leaves the row as it is.
      updateAccountOnSignIn: false,
      // An address never makes two sign-ins one person. Implicit linking joins a new identity to
      // the user with the same address when the provider calls it verified: a Microsoft tenant
      // can claim anyone's, and a Google address can be reassigned, or its domain bought again.
      // The newcomer would sign in as that user. `/link-social` stays closed (ADR-025).
      accountLinking: { disableImplicitLinking: true },
      // `input: false`: only the hook below writes them.
      additionalFields: {
        tenantId: { type: "string", required: false, input: false },
        claimedEmail: { type: "string", required: false, input: false },
      },
    },
    // Guests keep their identity as long as their rooms live: a session lasts
    // ROOM_TTL_DAYS after the last visit; a visit extends it at most once a day.
    session: { expiresIn: config.roomTtlDays * DAY_SECONDS, updateAge: DAY_SECONDS },
    rateLimit: {
      enabled: true,
      ...AUTH_DEFAULT_LIMIT,
      customStorage: limiter,
      customRules: {
        "/sign-in/anonymous": ANONYMOUS_SIGN_IN_LIMIT,
        "/sign-in/social": SOCIAL_SIGN_IN_LIMIT,
      },
    },
    advanced: {
      // Names come from `cookieNaming` (`__Host-pp.*` on https, `pp.*` on http), so Better
      // Auth's own `__Secure-` prefix stays off; `Secure` follows the protocol.
      cookiePrefix: "pp",
      useSecureCookies: false,
      cookies: Object.fromEntries(
        AUTH_COOKIES.map((name) => [
          name,
          {
            name: `${cookiePrefix(secure)}${name}`,
            ...(name === "state" && { attributes: { maxAge: STATE_COOKIE_SECONDS } }),
          },
        ]),
      ),
      defaultCookieAttributes: { httpOnly: true, sameSite: "lax", path: "/", secure },
      ipAddress: { ipAddressHeaders: [CLIENT_IP_HEADER] },
    },
    disabledPaths: DISABLED_AUTH_PATHS,
    telemetry: { enabled: false },
    // Better Auth logs errors with the error object as an argument, sometimes as the
    // message: only a message that is one of its error codes (`INTERNAL_SERVER_ERROR`)
    // is kept, as `code`, and nothing else: no argument reaches a log.
    logger: {
      level: "warn",
      disableColors: true,
      log: (level, message) =>
        log[inCallback.getStore() ? "debug" : level](
          typeof message === "string" && AUTH_LOG_CODE.test(message) ? { code: message } : {},
          "better-auth reported a problem",
        ),
    },
    // Errors are thrown to `registerAuthApi` instead of being printed: better-call would
    // print a thrown error whole to stderr (`# SERVER_ERROR`), and Better Auth its 4xx
    // messages. An APIError still becomes its own response. A failed callback that knows no
    // return path redirects to the landing page, not to Better Auth's own error page, which
    // is not forwarded (`signInOutcome` then rewrites the redirect).
    onAPIError: { throw: true, errorURL: `${config.baseUrl}/` },
    databaseHooks: {
      user: {
        create: {
          // The plugin names a guest "Anonymous", in English: store "" instead, so the
          // web app knows to ask for a name (#16) in the reader's language. A provider's name
          // meets the domain's rules like a typed one, and one they refuse is asked for too.
          // No picture: the policy refuses a provider's address, and nothing shows one.
          before: async (data) => ({
            data: {
              ...data,
              name: data.isAnonymous ? "" : (cleanName(data.name) ?? ""),
              image: null,
            },
          }),
        },
      },
      account: {
        create: {
          before: async (data) => ({
            data: {
              ...data,
              ...NO_PROVIDER_TOKENS,
              tenantId: microsoftTenant(data.providerId, data.idToken),
              claimedEmail: microsoftClaim(data.providerId, data.idToken),
            },
          }),
        },
        update: { before: async (data) => ({ data: { ...data, ...NO_PROVIDER_TOKENS } }) },
      },
      session: {
        create: {
          // No tracking by default: neither the address nor the user agent is stored.
          before: async (data) => ({ data: { ...data, ipAddress: null, userAgent: null } }),
        },
      },
    },
    user: {
      // `input: false`: only `POST /api/me/avatar` writes it, by the domain's list.
      additionalFields: { avatar: { type: "string", required: false, input: false } },
      validateUserInfo: ({ source }) => tenantRefusal(source, config),
    },
    // The plugin would delete the guest right after `onLinkAccount`, whatever came of it, and
    // its grants and the link row with it: `guest-link.ts` deletes the guest once all of it has
    // moved, and not before.
    plugins: [
      anonymous({
        disableDeleteAnonymousUser: true,
        ...(links && {
          onLinkAccount: async ({ anonymousUser, newUser }) => {
            const moved = await links.link(anonymousUser.user.id, newUser.user.id);
            const callback = inCallback.getStore();
            if (callback && !moved) callback.stillMoving = true;
          },
        }),
      }),
    ],
  } satisfies BetterAuthOptions;
}

export function createAuth(
  config: Config,
  db: Db,
  logger: Logger,
  limiter?: RateLimiter,
  links?: Pick<GuestLinks, "link">,
) {
  return betterAuth(authOptions(config, db, logger, limiter, links));
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

/** The app's error codes for Better Auth's 4xx and 5xx answers (never its sentences). */
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

/** A session's body when it is an account's, not a guest's or none. */
const accountSession = z.looseObject({
  user: z.looseObject({ id: z.string(), isAnonymous: z.literal(false) }),
});

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

/**
 * Mounts the allowed Better Auth endpoints (`AUTH_ROUTES`, and `socialRoutes` for the
 * providers this install has) under `/api/auth/*`, and `POST /api/me/name` and
 * `/api/me/avatar`. Each auth request gets the client address in `CLIENT_IP_HEADER`,
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

  const routes = new Set([...AUTH_ROUTES, ...socialRoutes(config)]);

  /** Better Auth's answer to `request`, which carries the client address it limits by. */
  function askBetterAuth(c: Context<AppEnv>, request: Request): Promise<Response> {
    const ip = requestIp(c, config);
    const headers = new Headers(request.headers);
    headers.delete(CLIENT_IP_HEADER);
    if (ip) headers.set(CLIENT_IP_HEADER, ip);
    return auth.handler(new Request(request, { headers }));
  }

  /** `askBetterAuth`, its answer in the app's codes, without a `token` field. */
  async function forward(c: Context<AppEnv>, request: Request): Promise<Response> {
    let response: Response;
    try {
      response = await askBetterAuth(c, request);
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
  }

  /**
   * A session, with the provider of an account as `user.provider`: in a room the page names it
   * rather than the address. `/list-accounts` stays closed; this one field is all the page gets.
   * A Microsoft account's `user.email` is no address (`microsoftAddress`): the page gets the one
   * its token claimed, if any, which is its owner's to see. One account row a person.
   */
  async function readSession(c: Context<AppEnv>): Promise<Response> {
    const answer = await forward(c, c.req.raw);
    if (answer.status !== 200) return answer;
    const session = await jsonOf(answer);
    const account = accountSession.safeParse(session);
    if (!account.success) return rewrite(answer, session);
    try {
      const { internalAdapter } = await auth.$context;
      const [first] = await internalAdapter.findAccounts(account.data.user.id);
      const { email: stored, ...shown } = account.data.user;
      const claimed = first ? Reflect.get(first, "claimedEmail") : undefined;
      const email = first?.providerId === "microsoft" ? claimed : stored;
      const user = {
        ...shown,
        ...(typeof email === "string" && { email }),
        provider: first?.providerId,
      };
      return rewrite(answer, { ...account.data, user });
    } catch (error) {
      // As in `forward`: never the error itself.
      c.var.log.error({ code: errorCode(error) }, "auth request failed");
      c.header("Cache-Control", "no-store");
      return c.json({ code: "internal" }, 500);
    }
  }

  /**
   * Starts a sign-in: Better Auth gets a body of our making (`signInRequest`) and answers
   * with the provider's URL, in JSON, for the page to navigate to.
   */
  async function startSignIn(c: Context<AppEnv>): Promise<Response> {
    c.header("Cache-Control", "no-store");
    if (!isJsonBody(c)) return c.json({ code: "bad_payload" }, 415);
    const body = signInRequest(await c.req.json().catch(() => undefined), config);
    if (!body) return c.json({ code: "bad_payload" }, 400);
    const headers = new Headers(c.req.raw.headers);
    headers.delete("content-length");
    const answer = await forward(
      c,
      new Request(c.req.raw.url, { method: "POST", headers, body: JSON.stringify(body) }),
    );
    answer.headers.set("cache-control", "no-store");
    return answer;
  }

  /**
   * A provider sends the person back here: this is a page they see, so whatever happened
   * ends in a redirect to the app (`signInOutcome`), with Better Auth's cookies kept.
   */
  async function finishSignIn(c: Context<AppEnv>, provider: string): Promise<Response> {
    let response: Response | null = null;
    const callback = { stillMoving: false };
    try {
      response = await inCallback.run(callback, () => askBetterAuth(c, c.req.raw));
    } catch (error) {
      // Never the error itself: its message or its cause's can hold a token or a code.
      c.var.log.error({ code: errorCode(error) }, "auth request failed");
    }
    const { location, failure } = signInOutcome(response, config);
    if (failure) {
      const level = isAlarming(failure.reason) ? "error" : "warn";
      c.var.log[level]({ ...failure, provider }, "sign-in did not finish");
    }
    const headers = new Headers(response?.headers);
    headers.delete("content-length");
    headers.delete("content-type");
    const moving = !failure && callback.stillMoving;
    headers.set("location", moving ? `${location}?${SIGN_IN_ERROR_PARAM}=still_moving` : location);
    headers.set("cache-control", "no-store");
    return new Response(null, { status: 302, headers });
  }

  app.on(["GET", "POST"], `${AUTH_BASE_PATH}/*`, async (c) => {
    const path = c.req.path.slice(AUTH_BASE_PATH.length);
    const route = `${c.req.method} ${path}`;
    // `c.req.path` is decoded, and Better Auth gets the raw URL: `get%2Dsession` would pass here
    // and reach its limiter as a new key, and `/callback/%67oogle` would use up a `state`.
    if (!routes.has(route) || new URL(c.req.url).pathname !== c.req.path) return c.notFound();
    // Better Auth checks the Origin too, but skips it when NODE_ENV is test: this check
    // holds everywhere. A browser always sends Origin on a POST.
    if (c.req.method === "POST" && foreignOrigin(c, config)) {
      c.header("Cache-Control", "no-store");
      return c.json({ code: "not_allowed" }, 403);
    }
    if (route === "GET /get-session") return readSession(c);
    if (route === "POST /sign-in/social") return startSignIn(c);
    if (path.startsWith("/callback/")) return finishSignIn(c, path.slice("/callback/".length));
    return forward(c, c.req.raw);
  });

  /**
   * A change to the person's own row: `change` gets who they are and one field of the JSON
   * body. A browser always sends Origin on a POST: another origin is refused, and a JSON
   * body cannot come from a plain cross-site form.
   */
  async function changeMine(
    c: Context<AppEnv>,
    bucket: string,
    field: string,
    change: (me: SocketUser, raw: unknown) => Promise<Response>,
  ): Promise<Response> {
    c.header("Cache-Control", "no-store");
    if (foreignOrigin(c, config)) return c.json({ code: "not_allowed" }, 403);
    if (!isJsonBody(c)) {
      return c.json({ code: "bad_payload" }, 415);
    }
    const ipKey = `${bucket}|ip|${requestIp(c, config) ?? "unknown"}`;
    const byIp = await limiter.consume(ipKey, RENAME_LIMITS.ip);
    if (!byIp.allowed) return rateLimited(c, byIp.retryAfter);
    const me = await sessionUser(auth, c.req.raw.headers);
    if (!me) return c.json({ code: "unauthenticated" }, 401);
    const byUser = await limiter.consume(`${bucket}|user|${me.id}`, RENAME_LIMITS.user);
    if (!byUser.allowed) return rateLimited(c, byUser.retryAfter);
    const body: unknown = await c.req.json().catch(() => undefined);
    return change(
      me,
      typeof body === "object" && body !== null ? Reflect.get(body, field) : undefined,
    );
  }

  // The display name, cleaned by the domain's rules (32 characters, whitespace collapsed,
  // well-formed, nothing invisible).
  app.post("/api/me/name", (c) =>
    changeMine(c, "rename", "name", async (me, raw) => {
      const name = cleanName(raw);
      if (name === null) return c.json({ code: "bad_name" }, 400);
      await guard("rename user", () =>
        db.update(user).set({ name, updatedAt: new Date() }).where(eq(user.id, me.id)),
      );
      return c.json({ name });
    }),
  );

  // The avatar the next room starts with (#42): one of the domain's ids, or null for the
  // initials. The room itself hears of it through `join` and `setAvatar`.
  app.post("/api/me/avatar", (c) =>
    changeMine(c, "avatar", "avatar", async (me, avatar) => {
      if (avatar !== null && !isAvatarId(avatar)) return c.json({ code: "bad_avatar" }, 400);
      await guard("save avatar", () =>
        db.update(user).set({ avatar, updatedAt: new Date() }).where(eq(user.id, me.id)),
      );
      return c.json({ avatar });
    }),
  );
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
