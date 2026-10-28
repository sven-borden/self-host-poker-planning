/**
 * Room passwords (#31, architecture section 8): the rule a password follows, its argon2id
 * hash as a PHC string, and the constant-time check. Node's own `crypto.argon2` (24.7 and
 * later) does the work on libuv's thread pool, so no native module ships in the image.
 *
 * Nothing here logs, and no error it throws carries the password or the hash.
 */
import { argon2, randomBytes, timingSafeEqual } from "node:crypto";
import { MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH } from "@pp/domain";

/** OWASP's argon2id minimum: 19 MiB, 2 passes, 1 lane. About 25 ms on a laptop core. */
export const ARGON2_PARAMS = { memory: 19_456, passes: 2, parallelism: 1 } as const;
/** Salt and tag lengths, in bytes. */
const SALT_BYTES = 16;
const TAG_BYTES = 32;

/**
 * The hash gate (#31): at most `running` hashings or checks at once, at most `waiting`
 * more in line, each for at most `waitMs`; past that, `busy`.
 */
export const HASH_GATE = { running: 2, waiting: 32, waitMs: 2000 } as const;

/**
 * The password as it is hashed and checked: NFC-normalised, so "é" typed as one code
 * point or as "e" and a combining accent is the same password. Never trimmed: a space is
 * a character like any other. Null when it is not 6 to 128 characters or not well-formed
 * text (a lone surrogate), which the API answers with `bad_password`.
 */
export function normalisePassword(raw: string): string | null {
  if (!raw.isWellFormed()) return null;
  const text = raw.normalize("NFC");
  const length = [...text].length;
  return length >= MIN_PASSWORD_LENGTH && length <= MAX_PASSWORD_LENGTH ? text : null;
}

interface Argon2Run {
  memory: number;
  passes: number;
  parallelism: number;
  salt: Buffer;
  tagLength: number;
}

function derive(password: string, run: Argon2Run): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    argon2(
      "argon2id",
      {
        message: Buffer.from(password, "utf8"),
        nonce: run.salt,
        parallelism: run.parallelism,
        tagLength: run.tagLength,
        memory: run.memory,
        passes: run.passes,
      },
      (error, key) => (error ? reject(new Error("argon2 failed")) : resolve(key)),
    );
  });
}

const b64 = (bytes: Buffer) => bytes.toString("base64").replace(/=+$/, "");

/**
 * The PHC string of a normalised password: `$argon2id$v=19$m=19456,t=2,p=1$salt$tag`, the
 * salt random and both unpadded base64, so the parameters travel with the hash and a
 * later change of them still checks the old ones.
 */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const { memory, passes, parallelism } = ARGON2_PARAMS;
  const tag = await derive(password, { memory, passes, parallelism, salt, tagLength: TAG_BYTES });
  return `$argon2id$v=19$m=${memory},t=${passes},p=${parallelism}$${b64(salt)}$${b64(tag)}`;
}

/**
 * The only PHC string a room may hold: the parameters this code writes, a 16-byte salt
 * and a 32-byte tag, both unpadded base64.
 */
const PHC = new RegExp(
  String.raw`^\$argon2id\$v=19\$m=${ARGON2_PARAMS.memory},t=${ARGON2_PARAMS.passes},p=${ARGON2_PARAMS.parallelism}\$([A-Za-z0-9+/]{22})\$([A-Za-z0-9+/]{43})$`,
);

/** A stored hash this code did not write. Its message never holds the hash. */
export class CorruptHashError extends Error {
  constructor() {
    super("corrupt password hash");
    this.name = "CorruptHashError";
  }
}

/**
 * Whether a normalised password matches a stored PHC string: the key is derived again
 * with the stored salt and compared with `timingSafeEqual`, so the time taken says
 * nothing about how much of it matched. Only the parameters in `ARGON2_PARAMS` are
 * accepted: a hash with others (a cost of gigabytes, or a cheap one) was not written
 * here, and throws `CorruptHashError` before any work.
 */
export async function verifyPassword(password: string, phc: string): Promise<boolean> {
  const match = PHC.exec(phc);
  if (!match) throw new CorruptHashError();
  const [, salt, tag] = match as unknown as [string, string, string];
  const expected = Buffer.from(tag, "base64");
  const { memory, passes, parallelism } = ARGON2_PARAMS;
  const actual = await derive(password, {
    memory,
    passes,
    parallelism,
    salt: Buffer.from(salt, "base64"),
    tagLength: TAG_BYTES,
  });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** The hash gate: `run` resolves null when the line is full or the wait ran out. */
export interface HashGate {
  run<T>(task: () => Promise<T>): Promise<T | null>;
  /** Runs in progress, and runs waiting, for tests. */
  readonly busy: number;
  readonly waiting: number;
}

/**
 * At most `running` argon2 runs at once (19 MiB each), so a flood of tries can neither
 * take the memory nor starve libuv's 4 threads. The next ones wait in line, first come
 * first served: at most `waiting` of them, each at most `waitMs`. One that finds the line
 * full, or waits longer, resolves null (`busy`) without running.
 */
export function createHashGate({
  running = HASH_GATE.running,
  waiting = HASH_GATE.waiting,
  waitMs = HASH_GATE.waitMs,
}: {
  running?: number;
  waiting?: number;
  waitMs?: number;
} = {}): HashGate {
  let busy = 0;
  /** Each waiter's wake-up: it takes over the place of the run that ended. */
  const line: Array<() => void> = [];

  function place(): Promise<boolean> {
    if (busy < running) {
      busy += 1;
      return Promise.resolve(true);
    }
    if (line.length >= waiting) return Promise.resolve(false);
    return new Promise((resolve) => {
      const wake = () => {
        clearTimeout(timer);
        resolve(true);
      };
      const timer = setTimeout(() => {
        line.splice(line.indexOf(wake), 1);
        resolve(false);
      }, waitMs);
      line.push(wake);
    });
  }

  return {
    async run(task) {
      if (!(await place())) return null;
      try {
        return await task();
      } finally {
        // The place goes to the first in line, or is freed.
        const next = line.shift();
        if (next) next();
        else busy -= 1;
      }
    },
    get busy() {
      return busy;
    },
    get waiting() {
      return line.length;
    },
  };
}
