/**
 * pino JSON logs on stdout. Log lines carry ids (request, connection, room code), never a
 * request body, cookie, auth header, query string, secret or vote value. The redact list
 * is a second line of defence for a field logged by mistake.
 */
import { type DestinationStream, type Logger, pino } from "pino";
import type { LogLevel } from "./config.ts";

export type { Logger };

const REDACT = [
  "databaseUrl",
  "*.databaseUrl",
  "betterAuthSecret",
  "*.betterAuthSecret",
  "password",
  "*.password",
  "secret",
  "*.secret",
  "cookie",
  "*.cookie",
  "authorization",
  "*.authorization",
  "headers.cookie",
  "headers.authorization",
  'headers["set-cookie"]',
  // A Socket.IO handshake or a Node request logged whole: its headers and its auth payload.
  "*.headers.cookie",
  "*.headers.authorization",
  '*.headers["set-cookie"]',
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
