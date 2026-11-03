/**
 * The server's configuration, read from the environment once by `run()` and passed down.
 * Nothing else reads `process.env`. A bad or missing variable throws `ConfigError`, whose
 * message names the variables and a fixed reason, never a value: `DATABASE_URL` and
 * `REDIS_URL` may hold a password, `BETTER_AUTH_SECRET` signs the sessions, the provider
 * secrets of `GOOGLE_CLIENT_SECRET` and `MICROSOFT_CLIENT_SECRET` open sign-in,
 * `JIRA_CLIENT_SECRET` opens the Jira app, and `POKER_VAULT_KEY` and `POKER_VAULT_OLD_KEYS`
 * open the connectors' tokens. `AZURE_DEVOPS_CONNECTOR` is the one connector variable that is no
 * secret.
 */
import { type ConnectorName, SIGN_IN_PROVIDERS, type SignInProvider } from "@pp/protocol";
import { z } from "zod";
import { type CspSources, parseCspSources } from "./security-headers.ts";
import { isVaultKey, reusesSecret, Vault, vaultKeyId } from "./vault.ts";

export const LOG_LEVELS = ["fatal", "error", "warn", "info", "debug", "trace", "silent"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

/** An OAuth client registered at a provider. The secret is never logged. */
export interface OAuthClient {
  readonly clientId: string;
  readonly clientSecret: string;
}

/** The sign-in providers of this install, each there only when both its keys are set. */
export interface SocialProviders {
  readonly google: OAuthClient | undefined;
  /** `tenantId`: `common`, `organizations`, `consumers` or one tenant's id. */
  readonly microsoft: (OAuthClient & { readonly tenantId: string }) | undefined;
}

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
   * What every Redis key and channel of this deployment starts with (`REDIS_KEY_PREFIX`, U4):
   * `pp` by default, today's keys, so a rolling deploy keeps one cluster. Two deployments on one
   * Redis each take their own. Letters, digits and `_` only: the adapter's channels are
   * `<prefix>#…`, `<prefix>-request#…` and `<prefix>-response#…`, and one prefix must never be
   * the start of another's channel.
   */
  readonly redisKeyPrefix: string;
  /**
   * Long-polling with several instances (`STICKY_SESSIONS`, U4): off by default, and sockets
   * use WebSocket only once `REDIS_URL` is set. On, both transports, for a load balancer that
   * keeps each client on one instance (cookie or address affinity). No effect without Redis.
   */
  readonly stickySessions: boolean;
  /**
   * Error reports to Sentry (#40, `observability.ts`), from the server and the page. A DSN
   * carries only a public key (one with a secret key is refused, since the page gets it);
   * still, never log it.
   */
  readonly sentryDsn: string | undefined;
  /** Page views to Umami (#40, `observability.ts`): its tracker script and the website id. */
  readonly umami: { readonly scriptUrl: string; readonly websiteId: string } | undefined;
  /**
   * Sign-in with Google and Microsoft (#47, ADR-023). No variable moves a provider to another
   * address: `social-sign-in.ts` uses the providers' own, and a test holds that.
   */
  readonly socialProviders: SocialProviders;
  /**
   * The keys of the connectors' tokens (#53, ADR-026), from `POKER_VAULT_KEY` and
   * `POKER_VAULT_OLD_KEYS`. Unset (the default), the vault is off. Prints no key.
   */
  readonly vault: Vault | undefined;
  /**
   * The Jira Cloud app of this install (#54, ADR-030), from `JIRA_CLIENT_ID` and
   * `JIRA_CLIENT_SECRET`. It works only with the vault too: see `connectorNames`.
   */
  readonly jira: OAuthClient | undefined;
  /**
   * The operator's own word for Azure DevOps (#55, ADR-031), from `AZURE_DEVOPS_CONNECTOR=on`. It
   * has no keys, so nothing else says the install wants a form that stores people's tokens.
   */
  readonly azureDevOps: boolean;
}

/**
 * The connectors this install has: what asks for the tracker (its keys, or the operator's word),
 * the vault to hold a person's token, and a way to be an account at all. Without any of them no
 * route and no button exists.
 */
export function connectorNames(
  config: Pick<Config, "jira" | "azureDevOps" | "vault" | "socialProviders">,
): ConnectorName[] {
  if (config.vault === undefined || socialProviderIds(config).length === 0) return [];
  return [
    ...(config.jira === undefined ? [] : (["jira"] as const)),
    ...(config.azureDevOps ? (["azure-devops"] as const) : []),
  ];
}

/** The variables a connector that was asked for still needs, for one line at the start. */
const accountGaps = (config: Pick<Config, "vault" | "socialProviders">): readonly string[] => [
  ...(config.vault === undefined ? ["POKER_VAULT_KEY"] : []),
  ...(socialProviderIds(config).length === 0 ? ["GOOGLE_CLIENT_ID", "MICROSOFT_CLIENT_ID"] : []),
];

/** What keeps a tracker with keys dark: `connectorNames`'s reasons. Names only. */
export const connectorGaps = (
  config: Pick<Config, "jira" | "vault" | "socialProviders">,
): readonly string[] => (config.jira === undefined ? [] : accountGaps(config));

/** What keeps an Azure DevOps that was turned on dark. Names only. */
export const azureDevOpsGaps = (
  config: Pick<Config, "azureDevOps" | "vault" | "socialProviders">,
): readonly string[] => (config.azureDevOps ? accountGaps(config) : []);

/** The providers `config` has keys for, in the order the page shows them. */
export function socialProviderIds(config: Pick<Config, "socialProviders">): SignInProvider[] {
  return SIGN_IN_PROVIDERS.filter((id) => config.socialProviders[id] !== undefined);
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
  REDIS_KEY_PREFIX: "must be 1 to 32 letters, digits or underscores",
  STICKY_SESSIONS: "must be true, false, 1 or 0",
  SENTRY_DSN:
    "must be a Sentry DSN such as https://0123abcd@o0.ingest.sentry.io/0, without a secret key",
  UMAMI_URL:
    "must be the http(s) address of Umami, such as https://stats.example.com, or of its tracker script ending in .js",
  UMAMI_WEBSITE_ID: "must be the website's id in Umami, a UUID",
  GOOGLE_CLIENT_ID: "must be the OAuth client id from the Google Cloud console",
  GOOGLE_CLIENT_SECRET: "must be the OAuth client secret from the Google Cloud console",
  MICROSOFT_CLIENT_ID: "must be the application (client) id from the Microsoft Entra admin center",
  MICROSOFT_CLIENT_SECRET: "must be a client secret value from the Microsoft Entra admin center",
  MICROSOFT_TENANT_ID: "must be common, organizations, consumers or a tenant id (a GUID)",
  JIRA_CLIENT_ID: "must be the client id from the Atlassian developer console",
  JIRA_CLIENT_SECRET: "must be the secret from the Atlassian developer console",
  AZURE_DEVOPS_CONNECTOR: "is on to turn it on, and anything else leaves it off",
  POKER_VAULT_KEY:
    "must be 32 random bytes in base64 on one line, with no line break or space, such as the output of openssl rand -base64 32, and must not be BETTER_AUTH_SECRET",
  POKER_VAULT_OLD_KEYS:
    "must be keys like POKER_VAULT_KEY separated by commas with no space or line break, each listed once, none of them POKER_VAULT_KEY or BETTER_AUTH_SECRET",
  BETTER_AUTH_SECRET:
    "must be at least 32 random characters, such as the output of openssl rand -base64 32",
} as const;
type Variable = keyof typeof REASONS;
const VARIABLES = Object.keys(REASONS) as Variable[];

/** Variables that work only together: the first is required when the second is set. */
const PAIRED: Partial<Record<Variable, Variable>> = {
  UMAMI_URL: "UMAMI_WEBSITE_ID",
  UMAMI_WEBSITE_ID: "UMAMI_URL",
  GOOGLE_CLIENT_ID: "GOOGLE_CLIENT_SECRET",
  GOOGLE_CLIENT_SECRET: "GOOGLE_CLIENT_ID",
  MICROSOFT_CLIENT_ID: "MICROSOFT_CLIENT_SECRET",
  MICROSOFT_CLIENT_SECRET: "MICROSOFT_CLIENT_ID",
  JIRA_CLIENT_ID: "JIRA_CLIENT_SECRET",
  JIRA_CLIENT_SECRET: "JIRA_CLIENT_ID",
  POKER_VAULT_KEY: "POKER_VAULT_OLD_KEYS",
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

/** A client id or secret: a paste with a line break or a space in it is a mistake. */
const oauthKey = z.string().regex(/^\S{1,1024}$/);

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
  REDIS_KEY_PREFIX: z
    .string()
    .regex(/^\w{1,32}$/)
    .default("pp"),
  STICKY_SESSIONS: z
    .enum(["true", "false", "1", "0"])
    .transform((v) => v === "true" || v === "1")
    .default(false),
  // https://<public key>@<host>[/<path>]/<project id>, as the SDK reads it (a key of
  // letters, digits and underscores, a numeric project id): it ignores a DSN it cannot read.
  SENTRY_DSN: z
    .string()
    .refine((v) => {
      const url = parsesAsUrl(v, ["http:", "https:"]);
      return (
        url !== undefined &&
        /^\w+$/.test(url.username) &&
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
  GOOGLE_CLIENT_ID: oauthKey.optional(),
  GOOGLE_CLIENT_SECRET: oauthKey.optional(),
  MICROSOFT_CLIENT_ID: oauthKey.optional(),
  MICROSOFT_CLIENT_SECRET: oauthKey.optional(),
  // It goes into the path of Microsoft's address, so nothing else passes.
  MICROSOFT_TENANT_ID: z
    .string()
    .refine((v) => ["common", "organizations", "consumers"].includes(v) || GUID.test(v))
    .default("common"),
  JIRA_CLIENT_ID: oauthKey.optional(),
  JIRA_CLIENT_SECRET: oauthKey.optional(),
  // Exactly `on`: any other value leaves it dark, and is no reason to refuse the start.
  AZURE_DEVOPS_CONNECTOR: z
    .string()
    .transform((v) => v === "on")
    .default(false),
  POKER_VAULT_KEY: z.string().refine(isVaultKey).optional(),
  POKER_VAULT_OLD_KEYS: z
    .string()
    .transform((v) => v.split(","))
    .refine((keys) => keys.every(isVaultKey))
    .optional(),
  BETTER_AUTH_SECRET: z.string().min(32).refine(isRealSecret),
});

/**
 * The vault variable that repeats a key or takes the session secret's, if any. Two copies of
 * a key are usually a new key that was never pasted; a key that is also the session secret
 * falls with it, and the vault exists so that a leak of one thing does not open another.
 */
function vaultClash(
  key: string | undefined,
  oldKeys: readonly string[],
  authSecret: string,
): Variable | undefined {
  if (key !== undefined && reusesSecret(key, authSecret)) return "POKER_VAULT_KEY";
  const ids = [key, ...oldKeys].flatMap((value) => (value ? [vaultKeyId(value)] : []));
  const repeated = new Set(ids).size < ids.length;
  return repeated || oldKeys.some((old) => reusesSecret(old, authSecret))
    ? "POKER_VAULT_OLD_KEYS"
    : undefined;
}

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
  if (parsed.success) {
    const { POKER_VAULT_KEY: key, POKER_VAULT_OLD_KEYS: old = [] } = parsed.data;
    const clash = vaultClash(key, old, parsed.data.BETTER_AUTH_SECRET);
    if (clash) bad.add(clash);
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
    redisKeyPrefix: v.REDIS_KEY_PREFIX,
    stickySessions: v.STICKY_SESSIONS,
    sentryDsn: v.SENTRY_DSN,
    umami:
      v.UMAMI_URL && v.UMAMI_WEBSITE_ID
        ? Object.freeze({ scriptUrl: v.UMAMI_URL, websiteId: v.UMAMI_WEBSITE_ID })
        : undefined,
    socialProviders: Object.freeze({
      google:
        v.GOOGLE_CLIENT_ID && v.GOOGLE_CLIENT_SECRET
          ? Object.freeze({ clientId: v.GOOGLE_CLIENT_ID, clientSecret: v.GOOGLE_CLIENT_SECRET })
          : undefined,
      microsoft:
        v.MICROSOFT_CLIENT_ID && v.MICROSOFT_CLIENT_SECRET
          ? Object.freeze({
              clientId: v.MICROSOFT_CLIENT_ID,
              clientSecret: v.MICROSOFT_CLIENT_SECRET,
              tenantId: v.MICROSOFT_TENANT_ID,
            })
          : undefined,
    }),
    jira:
      v.JIRA_CLIENT_ID && v.JIRA_CLIENT_SECRET
        ? Object.freeze({ clientId: v.JIRA_CLIENT_ID, clientSecret: v.JIRA_CLIENT_SECRET })
        : undefined,
    azureDevOps: v.AZURE_DEVOPS_CONNECTOR,
    betterAuthSecret: v.BETTER_AUTH_SECRET,
    vault: v.POKER_VAULT_KEY ? new Vault(v.POKER_VAULT_KEY, v.POKER_VAULT_OLD_KEYS) : undefined,
  });
}
