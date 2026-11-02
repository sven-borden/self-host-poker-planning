/**
 * The vault (#53, ADR-026): AES-256-GCM over the tokens of the connectors, with Node's own
 * `crypto`. A sealed value is one line of text:
 *
 *   v1.<key id>.<iv>.<tag>.<ciphertext>
 *
 * `v1` is the format, the key id is 8 hex digits derived from the key, and the three others
 * are base64url: a fresh random 96-bit IV for each `seal`, the 128-bit GCM tag, and the
 * ciphertext. The additional authenticated data holds the format, the key id, the user and
 * the connector, so a value copied onto another user or connector does not open.
 *
 * Nothing in here throws on a value it cannot open, and nothing prints a token or a key:
 * `Secret` and `Vault` keep theirs in private fields and print a fixed text however they are
 * logged. Keys come from `config.ts`, which alone reads the environment.
 */
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createSecretKey,
  type KeyObject,
  randomBytes,
} from "node:crypto";

const FORMAT = "v1";
const ALGORITHM = "aes-256-gcm";
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const SEALED = /^v1\.([0-9a-f]{8})\.([\w-]{16})\.([\w-]{22})\.([\w-]*)$/;

/** What `util.inspect` (so `console.log`) calls instead of walking an object. */
const INSPECT = Symbol.for("nodejs.util.inspect.custom");

/**
 * A token on its way through the server. It prints as `[secret]` to `pino`, `JSON.stringify`,
 * `console.log` and a template string; only `reveal()` gives the value, and only a connector
 * talking to its provider calls that.
 */
export class Secret {
  readonly #value: string;

  constructor(value: string) {
    this.#value = value;
  }

  reveal(): string {
    return this.#value;
  }

  toString(): string {
    return "[secret]";
  }

  toJSON(): string {
    return "[secret]";
  }

  [INSPECT](): string {
    return "[secret]";
  }
}

/** The row a sealed value belongs to: part of what the tag proves. */
export interface SealContext {
  readonly userId: string;
  readonly connector: string;
}

/**
 * Why a stored value did not open. `unknown_key`: its key is not among this server's (lost,
 * or dropped too soon). `corrupt`: its key is here but it does not verify, because it was
 * changed, moved to another row, or is not a value this version can read.
 */
export type OpenFailure = "unknown_key" | "corrupt";

export type OpenResult =
  | { readonly ok: true; readonly token: Secret; readonly onCurrentKey: boolean }
  | { readonly ok: false; readonly cause: OpenFailure };

/** The bytes of a key as `POKER_VAULT_KEY` writes them, or undefined when it is not a key. */
function decodeVaultKey(value: string): Buffer | undefined {
  const bytes = Buffer.from(value, "base64");
  if (bytes.length !== KEY_BYTES || bytes.toString("base64") !== value) return undefined;
  // One byte repeated (`AAAA…=`) is a placeholder, like `xxxx…` for a session secret.
  return bytes.every((byte) => byte === bytes[0]) ? undefined : bytes;
}

export const isVaultKey = (value: string): boolean => decodeVaultKey(value) !== undefined;

/**
 * A key's id: 32 bits of a hash, safe in a database dump. Derived, so that two different keys
 * cannot be given one id by hand, which would make every row of the older look tampered with.
 */
function keyIdOf(bytes: Buffer): string {
  return createHash("sha256")
    .update("poker-vault-key-id\0")
    .update(bytes)
    .digest("hex")
    .slice(0, 8);
}

/** The id of a valid key (`isVaultKey`). `config.ts` compares these to refuse a repeated key. */
export function vaultKeyId(value: string): string | undefined {
  const bytes = decodeVaultKey(value);
  return bytes && keyIdOf(bytes);
}

/** True when `key` is `secret`, written the same way or as the same bytes. */
export function reusesSecret(key: string, secret: string): boolean {
  const bytes = decodeVaultKey(key);
  return key === secret || (bytes?.equals(Buffer.from(secret, "base64")) ?? false);
}

const encode = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");

/** Unambiguous whatever the ids hold: JSON quotes each one. */
const additionalData = (keyId: string, { userId, connector }: SealContext) =>
  Buffer.from(JSON.stringify([FORMAT, keyId, userId, connector]), "utf8");

/** The keys of this server: one that seals, and every key that may still open. */
export class Vault {
  readonly #keys: ReadonlyMap<string, KeyObject>;
  readonly #currentKeyId: string;

  /** `current` and `old` have passed `isVaultKey` and hold no key twice (`loadConfig`). */
  constructor(current: string, old: readonly string[] = []) {
    const keys = new Map<string, KeyObject>();
    for (const value of [current, ...old]) {
      const bytes = decodeVaultKey(value);
      if (!bytes) throw new Error("vault: invalid key");
      keys.set(keyIdOf(bytes), createSecretKey(bytes));
    }
    this.#keys = keys;
    this.#currentKeyId = [...keys.keys()][0] as string;
  }

  /** The id of the key that seals: 8 hex digits in every row's value, nothing of the key. */
  get currentKeyId(): string {
    return this.#currentKeyId;
  }

  seal(token: Secret, context: SealContext): string {
    const key = this.#keys.get(this.#currentKeyId) as KeyObject;
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: TAG_BYTES });
    cipher.setAAD(additionalData(this.#currentKeyId, context));
    const ciphertext = Buffer.concat([cipher.update(token.reveal(), "utf8"), cipher.final()]);
    return [
      FORMAT,
      this.#currentKeyId,
      encode(iv),
      encode(cipher.getAuthTag()),
      encode(ciphertext),
    ].join(".");
  }

  open(sealed: string, context: SealContext): OpenResult {
    const parts = SEALED.exec(sealed);
    if (!parts) return { ok: false, cause: "corrupt" };
    const [, keyId = "", ivText = "", tagText = "", ciphertextText = ""] = parts;
    const key = this.#keys.get(keyId);
    if (!key) return { ok: false, cause: "unknown_key" };
    // Base64url has spare bits in a last character, so several spellings decode to the same
    // bytes. Only the one `seal` writes opens: a value that has changed in any way is refused.
    const iv = Buffer.from(ivText, "base64url");
    const tag = Buffer.from(tagText, "base64url");
    const ciphertext = Buffer.from(ciphertextText, "base64url");
    if (encode(iv) !== ivText || encode(tag) !== tagText || encode(ciphertext) !== ciphertextText) {
      return { ok: false, cause: "corrupt" };
    }
    try {
      // `authTagLength` makes Node refuse a short tag; without it a 4-byte tag would open.
      const decipher = createDecipheriv(ALGORITHM, key, iv, { authTagLength: TAG_BYTES });
      decipher.setAAD(additionalData(keyId, context));
      decipher.setAuthTag(tag);
      const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
      return {
        ok: true,
        token: new Secret(plain.toString("utf8")),
        onCurrentKey: keyId === this.#currentKeyId,
      };
    } catch {
      return { ok: false, cause: "corrupt" };
    }
  }

  toString(): string {
    return "[vault]";
  }

  toJSON(): string {
    return "[vault]";
  }

  [INSPECT](): string {
    return "[vault]";
  }
}
