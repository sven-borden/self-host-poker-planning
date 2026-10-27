/**
 * Driver errors never reach a log line or a caller as they are. A `pg` error can
 * carry connection details, and drizzle's `DrizzleQueryError` puts the query parameters in
 * its message: a room's whole state (vote values before reveal) or a password hash. Every
 * database call goes through `guard`, which rethrows a `DatabaseError` holding the step
 * and the error code alone, with no `cause`.
 */

/** The SQLSTATE (`40001`) or Node code (`ECONNREFUSED`) of an error or of one of its causes. */
export function errorCode(error: unknown): string {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && typeof current === "object" && current !== null; depth++) {
    const { code } = current as { code?: unknown };
    if (typeof code === "string" && /^[\w.-]{1,64}$/.test(code)) return code;
    current = (current as { cause?: unknown }).cause;
  }
  return "unknown";
}

export class DatabaseError extends Error {
  /** SQLSTATE or Node error code, or `unknown`. */
  readonly code: string;

  /** `detail` is our own text; never pass a driver message or a value into it. */
  constructor(step: string, code: string, detail?: string) {
    super(`database: ${step} failed (${code})${detail ? `: ${detail}` : ""}`);
    this.name = "DatabaseError";
    this.code = code;
  }
}

/** Runs one database call; a failure comes back as a `DatabaseError` with no driver text. */
export async function guard<T>(step: string, call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    if (error instanceof DatabaseError) throw error;
    throw new DatabaseError(step, errorCode(error));
  }
}
