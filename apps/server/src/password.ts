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

/** At most this many hashings or checks run at once; past that, `rate_limited`. */
export const MAX_CONCURRENT_HASHES = 4;

/**
 * The password as it is hashed and checked: NFC-normalised, so "é" typed as one code
 * point or as "e" and a combining accent is the same password. Never trimmed: a space is
 * a character like any other. Null when it is not 4 to 128 characters or not well-formed
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

const PHC =
  /^\$argon2id\$v=19\$m=(\d{1,7}),t=(\d{1,3}),p=(\d{1,2})\$([A-Za-z0-9+/]+)\$([A-Za-z0-9+/]+)$/;

/**
 * Whether a normalised password matches a stored PHC string: the key is derived again
 * with the stored salt and parameters and compared with `timingSafeEqual`, so the time
 * taken says nothing about how much of it matched. A string this code did not write is
 * no match.
 */
export async function verifyPassword(password: string, phc: string): Promise<boolean> {
  const match = PHC.exec(phc);
  if (!match) return false;
  const [, m, t, p, salt, tag] = match as unknown as [
    string,
    string,
    string,
    string,
    string,
    string,
  ];
  const expected = Buffer.from(tag, "base64");
  const run = {
    memory: Number(m),
    passes: Number(t),
    parallelism: Number(p),
    salt: Buffer.from(salt, "base64"),
    tagLength: expected.length,
  };
  if (run.salt.length < 8 || expected.length < 16) return false;
  const actual = await derive(password, run);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** A gate of `max` concurrent runs: `run` resolves null at once when they are all taken. */
export interface HashGate {
  run<T>(task: () => Promise<T>): Promise<T | null>;
  /** Runs in progress, for tests. */
  readonly busy: number;
}

/**
 * At most `max` argon2 runs at once (19 MiB each), so a flood of tries can neither take
 * the memory nor queue up behind libuv's 4 threads: the fifth is refused, never queued.
 */
export function createHashGate(max: number = MAX_CONCURRENT_HASHES): HashGate {
  let busy = 0;
  return {
    async run(task) {
      if (busy >= max) return null;
      busy += 1;
      try {
        return await task();
      } finally {
        busy -= 1;
      }
    },
    get busy() {
      return busy;
    },
  };
}
