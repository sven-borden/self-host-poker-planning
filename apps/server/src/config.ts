/**
 * The server's configuration, read from the environment once by `run()` and passed down.
 * Nothing else reads `process.env`. A bad or missing variable throws `ConfigError`, whose
 * message names the variables and a fixed reason, never a value: `DATABASE_URL` and
 * `REDIS_URL` may hold a password and `BETTER_AUTH_SECRET` signs the sessions.
 */
import { z } from "zod";
import { type CspSources, parseCspSources } from "./security-headers.ts";

export const LOG_LEVELS = ["fatal", "error", "warn", "info", "debug", "trace", "silent"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export interface Config {
  readonly port: number;
  /** Postgres connection string; #7 connects to it. Never log it. */
  readonly databaseUrl: string;
  /** Public origin without a trailing slash, for example `https://poker.borden.ch`. */
  readonly baseUrl: string;
  readonly logLevel: LogLevel;
  /**
   * How many reverse proxies append to `X-Forwarded-For` in front of the server: the
   * client address is the entry this many places from the right (`clientIp`, rate
   * limits). 0 trusts no header and takes the socket address.
   */
  readonly trustProxy: number;
  /** Signs the session cookies (Better Auth, #10). At least 32 characters. Never log it. */
  readonly betterAuthSecret: string;
  readonly roomTtlDays: number;
  /** Set at image build (#11); reported by `/api/health`. */
  readonly gitCommit: string | undefined;
  readonly appVersion: string | undefined;
  /** Folder of the built web app; `run()` falls back to `apps/web/dist`. */
  readonly staticDir: string | undefined;
  /** Folder of the SQL migrations; `openDatabase` falls back to `apps/server/drizzle`. */
  readonly migrationsDir: string | undefined;
  /**
   * Sends the Content Security Policy as `Content-Security-Policy-Report-Only`
   * (`CSP_REPORT_ONLY`): the browser reports violations in its console and blocks nothing,
   * for a self-hoster who adds a script of their own and checks what the policy would stop.
   */
  readonly cspReportOnly: boolean;
  /** Origins added to the policy (`CSP_EXTRA_SOURCES`, `security-headers.ts`). */
  readonly cspExtraSources: CspSources;
  /**
   * Redis for running several instances (#39, `scale-out.ts`): set, the instances share
   * room changes, presence and command ids through it, and sockets use WebSocket only.
   * Unset (the default), nothing about Redis is loaded. May hold a password: never log it.
   */
  readonly redisUrl: string | undefined;
  /**
   * Error reports to Sentry (#40, `observability.ts`), from the server and the page. A DSN
   * carries only a public key (one with a secret key is refused, since the page gets it);
   * still, never log it.
   */
  readonly sentryDsn: string | undefined;
  /** Page views to Umami (#40, `observability.ts`): its tracker script and the website id. */
  readonly umami: { readonly scriptUrl: string; readonly websiteId: string } | undefined;
}

/** Every variable `loadConfig` reads, with the reason shown when its value is invalid. */
const REASONS = {
  PORT: "must be an integer from 0 to 65535",
  DATABASE_URL: "must be a postgres:// or postgresql:// URL",
  BASE_URL:
    "must be an http(s) origin without a path or credentials, such as https://poker.example.com",
  LOG_LEVEL: `must be one of ${LOG_LEVELS.join(", ")}`,
  TRUST_PROXY: "must be true, false or a number of proxies from 0 to 10",
  ROOM_TTL_DAYS: "must be an integer from 1 to 3650",
  GIT_COMMIT: "must be 1 to 64 letters, digits, dots, dashes or underscores",
  APP_VERSION: "must be 1 to 64 letters, digits, dots, plus signs, dashes or underscores",
  STATIC_DIR: "must be a folder path",
  MIGRATIONS_DIR: "must be a folder path",
  CSP_REPORT_ONLY: "must be true, false, 1 or 0",
  CSP_EXTRA_SOURCES:
    "must be directives and origins such as script-src https://stats.example.com; connect-src https://stats.example.com",
  REDIS_URL: "must be a redis:// or rediss:// URL",
  SENTRY_DSN:
    "must be a Sentry DSN such as https://public-key@o0.ingest.sentry.io/0, without a secret key",
  UMAMI_URL:
    "must be the http(s) address of Umami, such as https://stats.example.com, or of its tracker script ending in .js",
  UMAMI_WEBSITE_ID: "must be the website's id in Umami, a UUID",
  BETTER_AUTH_SECRET:
    "must be at least 32 random characters, such as the output of openssl rand -base64 32",
} as const;
type Variable = keyof typeof REASONS;
const VARIABLES = Object.keys(REASONS) as Variable[];

/** Variables that work only together: each is required when the other is set. */
const PAIRED: Partial<Record<Variable, Variable>> = {
  UMAMI_URL: "UMAMI_WEBSITE_ID",
  UMAMI_WEBSITE_ID: "UMAMI_URL",
};

function parsesAsUrl(value: string, protocols: readonly string[]): URL | undefined {
  if (!URL.canParse(value)) return undefined;
  const url = new URL(value);
  return protocols.includes(url.protocol) ? url : undefined;
}

/**
 * Secrets that are not secret: the placeholder older copies of `.env.example` carried, and
 * any value made of one repeated character (`xxxx…`).
 */
const PLACEHOLDER_SECRET = "replace-with-32-or-more-random-characters";
const isRealSecret = (value: string) => value !== PLACEHOLDER_SECRET && !/^(.)\1*$/su.test(value);

const integer = (min: number, max: number) =>
  z
    .string()
    .regex(/^\d{1,9}$/)
    .transform(Number)
    .pipe(z.number().int().min(min).max(max));

const schema = z.object({
  PORT: integer(0, 65535).default(3000),
  DATABASE_URL: z
    .string()
    .refine((v) => parsesAsUrl(v, ["postgres:", "postgresql:"]) !== undefined),
  BASE_URL: z
    .string()
    .refine((v) => {
      const url = parsesAsUrl(v, ["http:", "https:"]);
      return (
        url !== undefined &&
        url.pathname === "/" &&
        !url.search &&
        !url.hash &&
        !url.username &&
        !url.password
      );
    })
    .transform((v) => new URL(v).origin),
  LOG_LEVEL: z.enum(LOG_LEVELS).default("info"),
  // `true` is one proxy (Traefik alone), `false` none; a number counts the proxies.
  TRUST_PROXY: z
    .union([z.enum(["true", "false"]), z.string().regex(/^\d{1,2}$/)])
    .transform((v) => (v === "true" ? 1 : v === "false" ? 0 : Number(v)))
    .pipe(z.number().int().min(0).max(10))
    .default(1),
  ROOM_TTL_DAYS: integer(1, 3650).default(90),
  GIT_COMMIT: z
    .string()
    .regex(/^[\w.-]{1,64}$/)
    .optional(),
  APP_VERSION: z
    .string()
    .regex(/^[\w.+-]{1,64}$/)
    .optional(),
  STATIC_DIR: z.string().min(1).optional(),
  MIGRATIONS_DIR: z.string().min(1).optional(),
  CSP_REPORT_ONLY: z
    .enum(["true", "false", "1", "0"])
    .transform((v) => v === "true" || v === "1")
    .default(false),
  CSP_EXTRA_SOURCES: z
    .string()
    .max(2000)
    .transform((v, ctx) => {
      const sources = parseCspSources(v);
      if (sources === null) ctx.addIssue({ code: "custom", message: "invalid" });
      return sources ?? {};
    })
    .default({}),
  REDIS_URL: z
    .string()
    .refine((v) => {
      const url = parsesAsUrl(v, ["redis:", "rediss:"]);
      // A path names the database number only: node-redis refuses anything else.
      return Boolean(url?.hostname) && /^(\/\d*)?$/.test(url?.pathname ?? "");
    })
    .optional(),
  // https://<public key>@<host>[/<path>]/<project id>; the project id is a number.
  SENTRY_DSN: z
    .string()
    .refine((v) => {
      const url = parsesAsUrl(v, ["http:", "https:"]);
      return (
        url !== undefined &&
        url.username !== "" &&
        !url.password &&
        !url.search &&
        !url.hash &&
        /^(\/[^/]+)*\/\d+$/.test(url.pathname)
      );
    })
    .optional(),
  // Umami's address, under which the tracker is `/script.js`, or the tracker's own URL
  // when it was renamed (Umami's TRACKER_SCRIPT_NAME).
  UMAMI_URL: z
    .string()
    .refine((v) => {
      const url = parsesAsUrl(v, ["http:", "https:"]);
      return url !== undefined && !url.username && !url.password && !url.search && !url.hash;
    })
    .transform((v) => {
      const url = new URL(v);
      const path = url.pathname.replace(/\/+$/, "");
      return `${url.origin}${path.endsWith(".js") ? path : `${path}/script.js`}`;
    })
    .optional(),
  UMAMI_WEBSITE_ID: z
    .string()
    .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)
    .transform((v) => v.toLowerCase())
    .optional(),
  BETTER_AUTH_SECRET: z.string().min(32).refine(isRealSecret),
});

export class ConfigError extends Error {
  /** The offending variable names, in a fixed order. Never their values. */
  readonly variables: readonly string[];

  constructor(problems: readonly { variable: string; reason: string }[]) {
    const list = problems.map((p) => `${p.variable} ${p.reason}`).join("; ");
    super(`Invalid configuration: ${list}. See .env.example.`);
    this.name = "ConfigError";
    this.variables = problems.map((p) => p.variable);
  }
}

/**
 * Validates the environment and returns a frozen config, or throws `ConfigError`. An empty
 * value counts as unset (`VAR=` in a compose file), so the default applies.
 */
export function loadConfig(env: Readonly<Record<string, string | undefined>>): Config {
  const input: Partial<Record<Variable, string>> = {};
  for (const name of VARIABLES) {
    const value = env[name];
    if (value !== undefined && value !== "") input[name] = value;
  }
  const parsed = schema.safeParse(input);
  const bad = new Set(parsed.error?.issues.map((issue) => String(issue.path[0])));
  const missing = (name: Variable) => input[name] === undefined;
  for (const [name, other] of Object.entries(PAIRED) as [Variable, Variable][]) {
    if (missing(name) && !missing(other)) bad.add(name);
  }
  if (!parsed.success || bad.size > 0) {
    throw new ConfigError(
      VARIABLES.filter((name) => bad.has(name)).map((variable) => {
        const other = PAIRED[variable];
        const required = other ? `is required when ${other} is set` : "is required";
        return { variable, reason: missing(variable) ? required : REASONS[variable] };
      }),
    );
  }
  const v = parsed.data;
  return Object.freeze({
    port: v.PORT,
    databaseUrl: v.DATABASE_URL,
    baseUrl: v.BASE_URL,
    logLevel: v.LOG_LEVEL,
    trustProxy: v.TRUST_PROXY,
    roomTtlDays: v.ROOM_TTL_DAYS,
    gitCommit: v.GIT_COMMIT,
    appVersion: v.APP_VERSION,
    staticDir: v.STATIC_DIR,
    migrationsDir: v.MIGRATIONS_DIR,
    cspReportOnly: v.CSP_REPORT_ONLY,
    cspExtraSources: v.CSP_EXTRA_SOURCES,
    redisUrl: v.REDIS_URL,
    sentryDsn: v.SENTRY_DSN,
    umami:
      v.UMAMI_URL && v.UMAMI_WEBSITE_ID
        ? Object.freeze({ scriptUrl: v.UMAMI_URL, websiteId: v.UMAMI_WEBSITE_ID })
        : undefined,
    betterAuthSecret: v.BETTER_AUTH_SECRET,
  });
}
