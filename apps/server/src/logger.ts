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
 * Creates the process logger. `destination` defaults to a synchronous stdout writer, so
 * the line logged right before `process.exit` is never lost; tests pass a collector.
 */
export function createLogger(level: LogLevel, destination?: DestinationStream): Logger {
  return pino(
    {
      level,
      timestamp: pino.stdTimeFunctions.isoTime,
      redact: { paths: REDACT, censor: "[redacted]" },
    },
    destination ?? pino.destination({ dest: 1, sync: true }),
  );
}
