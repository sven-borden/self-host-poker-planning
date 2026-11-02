/**
 * pino JSON logs on stdout. Log lines carry ids (request, connection, room code), never a
 * request body, cookie, auth header, query string, secret or vote value. The redact list
 * is a second line of defence for a field logged by mistake.
 */
import { type DestinationStream, type Logger, pino } from "pino";
import type { LogLevel } from "./config.ts";

export type { Logger };

/**
 * Field names that hold a secret wherever they are logged: at the top level, one level down
 * (`a.token`) and two down (`a.b.token`, `list[0].token`). pino's `*` stands for exactly one
 * level, so each depth is a path of its own, and pino matches case: `Authorization` is not
 * `authorization`. Deeper than three keys is not covered, and neither is a secret under a
 * name that is not here. So a provider's reply goes into a `Secret` at once (`vault.ts`),
 * which prints nothing wherever it sits, and is never logged as a plain object.
 */
const SECRET_NAMES = [
  "databaseUrl",
  "DATABASE_URL",
  "betterAuthSecret",
  "BETTER_AUTH_SECRET",
  "password",
  "secret",
  "client_secret",
  "clientSecret",
  "cookie",
  "authorization",
  "Authorization",
  // The connectors' tokens and keys (#53): a `Secret` and a `Vault` print nothing of theirs;
  // this is for a plain string under one of these names.
  "token",
  "accessToken",
  "access_token",
  "refreshToken",
  "refresh_token",
  "idToken",
  "id_token",
  "apiToken",
  "api_token",
  "pat",
  "sealedToken",
  "sealed_token",
  "vaultKey",
  "POKER_VAULT_KEY",
  "POKER_VAULT_OLD_KEYS",
  // What a connector carries (#54): nothing logs these; this is for a mistake.
  "jql",
  "summary",
  "wiql",
];

/** Headers of a request or handshake logged whole, in either case, at three depths. */
const HEADERS = ["cookie", "Cookie", "authorization", "Authorization", "set-cookie", "Set-Cookie"];
const headerPath = (prefix: string, name: string) =>
  /^[a-z_$][\w$]*$/i.test(name) ? `${prefix}headers.${name}` : `${prefix}headers["${name}"]`;

const REDACT = [
  ...SECRET_NAMES.flatMap((name) => [name, `*.${name}`, `*.*.${name}`]),
  ...HEADERS.flatMap((name) => ["", "*.", "*.*."].map((prefix) => headerPath(prefix, name))),
  // A Socket.IO handshake logged whole: its auth payload.
  "*.auth",
];

/**
 * The message of the request log's line for a 5xx answer (`app.ts`). Not an error report
 * of its own (`sentry.ts`): what failed logs its own line.
 */
export const REQUEST_FAILED = "request failed";

/**
 * Creates the process logger. `destination` defaults to a synchronous stdout writer, so
 * the line logged right before `process.exit` is never lost; tests pass a collector.
 * `report` sees every line after it is written, as written (#40: Sentry, `sentry.ts`).
 */
export function createLogger(
  level: LogLevel,
  destination?: DestinationStream,
  report?: (line: string) => void,
): Logger {
  const out = destination ?? pino.destination({ dest: 1, sync: true });
  return pino(
    {
      level,
      timestamp: pino.stdTimeFunctions.isoTime,
      redact: { paths: REDACT, censor: "[redacted]" },
    },
    report
      ? {
          write(line: string) {
            out.write(line);
            report(line);
          },
        }
      : out,
  );
}
