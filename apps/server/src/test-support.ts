/** Helpers shared by the server tests. Not imported by `main.ts`, so never bundled. */
import { type Config, type LogLevel, loadConfig } from "./config.ts";
import { createLogger, type Logger } from "./logger.ts";

/** A password-shaped secret: tests assert it never reaches a log line or a message. */
export const SECRET = "hunter2-do-not-log";

export const VALID_ENV = {
  DATABASE_URL: `postgres://pp:${SECRET}@localhost:5432/pp`,
  BASE_URL: "http://localhost:3000",
  /** A fake signing secret: tests assert it never reaches a log line or a response. */
  BETTER_AUTH_SECRET: "fake-test-secret-0123456789abcdefghijklmnop",
} as const;

export function testConfig(env: Record<string, string> = {}): Config {
  return loadConfig({ ...VALID_ENV, PORT: "0", ...env });
}

export interface LogCollector {
  /** Every line exactly as pino wrote it. */
  readonly raw: string[];
  readonly lines: Record<string, unknown>[];
  readonly destination: { write(chunk: string): void };
  readonly logger: Logger;
  messages(): string[];
}

/** A logger (debug level unless told otherwise) whose output is kept in memory. */
export function collectLogs(level: LogLevel = "debug"): LogCollector {
  const raw: string[] = [];
  const lines: Record<string, unknown>[] = [];
  const destination = {
    write(chunk: string) {
      raw.push(chunk);
      lines.push(JSON.parse(chunk) as Record<string, unknown>);
    },
  };
  return {
    raw,
    lines,
    destination,
    logger: createLogger(level, destination),
    messages: () => lines.map((line) => String(line.msg)),
  };
}
