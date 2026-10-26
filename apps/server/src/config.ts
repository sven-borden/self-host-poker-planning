/**
 * The server's configuration, read from the environment once by `run()` and passed down.
 * Nothing else reads `process.env`. A bad or missing variable throws `ConfigError`, whose
 * message names the variables and a fixed reason, never a value: `DATABASE_URL` holds a
 * password.
 */
import { z } from "zod";

export const LOG_LEVELS = ["fatal", "error", "warn", "info", "debug", "trace", "silent"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export interface Config {
  readonly port: number;
  /** Postgres connection string; #7 connects to it. Never log it. */
  readonly databaseUrl: string;
  /** Public origin without a trailing slash, for example `https://poker.borden.ch`. */
  readonly baseUrl: string;
  readonly logLevel: LogLevel;
  /** Trust `X-Forwarded-*` from the reverse proxy for client addresses (rate limits). */
  readonly trustProxy: boolean;
  readonly roomTtlDays: number;
  /** Set at image build (#11); reported by `/api/health`. */
  readonly gitCommit: string | undefined;
  readonly appVersion: string | undefined;
  /** Folder of the built web app; `run()` falls back to `apps/web/dist`. */
  readonly staticDir: string | undefined;
}

/** Every variable `loadConfig` reads, with the reason shown when its value is invalid. */
const REASONS = {
  PORT: "must be an integer from 0 to 65535",
  DATABASE_URL: "must be a postgres:// or postgresql:// URL",
  BASE_URL:
    "must be an http(s) origin without a path or credentials, such as https://poker.example.com",
  LOG_LEVEL: `must be one of ${LOG_LEVELS.join(", ")}`,
  TRUST_PROXY: "must be true, false, 1 or 0",
  ROOM_TTL_DAYS: "must be an integer from 1 to 3650",
  GIT_COMMIT: "must be 1 to 64 letters, digits, dots, dashes or underscores",
  APP_VERSION: "must be 1 to 64 letters, digits, dots, plus signs, dashes or underscores",
  STATIC_DIR: "must be a folder path",
} as const;
type Variable = keyof typeof REASONS;
const VARIABLES = Object.keys(REASONS) as Variable[];

function parsesAsUrl(value: string, protocols: readonly string[]): URL | undefined {
  if (!URL.canParse(value)) return undefined;
  const url = new URL(value);
  return protocols.includes(url.protocol) ? url : undefined;
}

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
  TRUST_PROXY: z
    .enum(["true", "false", "1", "0"])
    .transform((v) => v === "true" || v === "1")
    .default(true),
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
  if (!parsed.success) {
    const bad = new Set(parsed.error.issues.map((issue) => String(issue.path[0])));
    throw new ConfigError(
      VARIABLES.filter((name) => bad.has(name)).map((variable) => ({
        variable,
        reason: input[variable] === undefined ? "is required" : REASONS[variable],
      })),
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
  });
}
