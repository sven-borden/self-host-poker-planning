import { createDecipheriv, createHash, randomBytes } from "node:crypto";
import { inspect } from "node:util";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { collectLogs } from "./test-support.ts";
import { isVaultKey, reusesSecret, Secret, Vault, vaultKeyId } from "./vault.ts";

const newKey = () => randomBytes(32).toString("base64");
const TOKEN = "fake-connector-token-do-not-log";
const ALICE = { userId: "user-alice", connector: "jira" };

const flip = (text: string, at: number) =>
  `${text.slice(0, at)}${text[at] === "A" ? "B" : "A"}${text.slice(at + 1)}`;

describe("seal and open", () => {
  it("round-trips any text", () => {
    const vault = new Vault(newKey());
    fc.assert(
      fc.property(fc.string({ unit: "grapheme", maxLength: 300 }), (text) => {
        const opened = vault.open(vault.seal(new Secret(text), ALICE), ALICE);
        expect(opened.ok && opened.token.reveal()).toBe(text);
      }),
    );
  });

  it("writes the documented format, which plain Node crypto reads with its own AAD", () => {
    const key = newKey();
    const keyBytes = Buffer.from(key, "base64");
    const sealed = new Vault(key).seal(new Secret(TOKEN), ALICE);
    expect(sealed).toMatch(/^v1\.[0-9a-f]{8}\.[\w-]{16}\.[\w-]{22}\.[\w-]+$/);

    const [version, keyId, iv, tag, ciphertext] = sealed.split(".") as [
      string,
      string,
      string,
      string,
      string,
    ];
    expect(version).toBe("v1");
    expect(keyId).toBe(
      createHash("sha256")
        .update("poker-vault-key-id\0")
        .update(keyBytes)
        .digest("hex")
        .slice(0, 8),
    );
    const decipher = createDecipheriv("aes-256-gcm", keyBytes, Buffer.from(iv, "base64url"));
    decipher.setAAD(Buffer.from(JSON.stringify(["v1", keyId, ALICE.userId, ALICE.connector])));
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    const plain = Buffer.concat([
      decipher.update(Buffer.from(ciphertext, "base64url")),
      decipher.final(),
    ]);
    expect(plain.toString()).toBe(TOKEN);
    expect(Buffer.from(iv, "base64url")).toHaveLength(12);
    expect(Buffer.from(tag, "base64url")).toHaveLength(16);
  });

  it("draws a fresh IV for every seal of the same token", () => {
    const vault = new Vault(newKey());
    const seals = Array.from({ length: 2000 }, () => vault.seal(new Secret(TOKEN), ALICE));
    expect(new Set(seals.map((sealed) => sealed.split(".")[2])).size).toBe(seals.length);
    expect(new Set(seals.map((sealed) => sealed.split(".")[4])).size).toBe(seals.length);
  });

  it("does not open for another user or connector", () => {
    const vault = new Vault(newKey());
    const sealed = vault.seal(new Secret(TOKEN), ALICE);
    expect(vault.open(sealed, { ...ALICE, userId: "user-bob" })).toEqual({
      ok: false,
      cause: "corrupt",
    });
    expect(vault.open(sealed, { ...ALICE, connector: "azure-devops" })).toEqual({
      ok: false,
      cause: "corrupt",
    });
    // The ids do not run together.
    const joined = vault.seal(new Secret(TOKEN), { userId: "a", connector: "b,c" });
    expect(vault.open(joined, { userId: "a,b", connector: "c" }).ok).toBe(false);
    const quoted = vault.seal(new Secret(TOKEN), { userId: 'a","b', connector: "c" });
    expect(vault.open(quoted, { userId: "a", connector: 'b","c' }).ok).toBe(false);
  });

  it("refuses a changed value, whichever part changed, without throwing", () => {
    const vault = new Vault(newKey());
    const sealed = vault.seal(new Secret(TOKEN), ALICE);
    const parts = sealed.split(".");
    for (const index of [2, 3, 4]) {
      const changed = [...parts];
      changed[index] = flip(changed[index] as string, 0);
      expect(vault.open(changed.join("."), ALICE)).toEqual({ ok: false, cause: "corrupt" });
    }
    for (const bad of ["", "v1", "v2.".concat(sealed.slice(3)), `${sealed}.x`, `${sealed}!`]) {
      expect(vault.open(bad, ALICE)).toEqual({ ok: false, cause: "corrupt" });
    }
    expect(vault.open(sealed.slice(0, 20), ALICE)).toEqual({ ok: false, cause: "corrupt" });
  });

  it("refuses another spelling of the same bytes, as a changed value", () => {
    const vault = new Vault(newKey());
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    const respelledAt: number[] = [0, 0, 0, 0, 0];
    for (const text of [TOKEN, "x", "xy", "xyz", "wxyz", ""]) {
      const sealed = vault.seal(new Secret(text), ALICE);
      const parts = sealed.split(".");
      expect(vault.open(sealed, ALICE)).toMatchObject({ ok: true });
      for (const index of [2, 3, 4]) {
        const part = parts[index] as string;
        if (part === "") continue;
        const bytes = Buffer.from(part, "base64url");
        for (const letter of alphabet) {
          if (letter === part.slice(-1)) continue;
          const other = `${part.slice(0, -1)}${letter}`;
          if (Buffer.from(other, "base64url").equals(bytes))
            respelledAt[index] = (respelledAt[index] ?? 0) + 1;
          const changed = [...parts];
          changed[index] = other;
          expect(vault.open(changed.join("."), ALICE)).toEqual({ ok: false, cause: "corrupt" });
        }
      }
    }
    // The tag of 16 bytes is 22 characters and the last holds 4 spare bits: 15 other spellings
    // of each, so the loop did meet respellings rather than only different bytes.
    expect(respelledAt[3]).toBe(15 * 6);
    expect(respelledAt[4] ?? 0).toBeGreaterThan(0);
  });

  it("opens only a value that is unchanged, however its last character is spelled", () => {
    const vault = new Vault(newKey());
    fc.assert(
      fc.property(
        fc.string({ unit: "grapheme", maxLength: 40 }),
        fc.integer({ min: 2, max: 4 }),
        fc.integer({ min: 0, max: 63 }),
        (text, index, pick) => {
          const sealed = vault.seal(new Secret(text), ALICE);
          const parts = sealed.split(".");
          const part = parts[index] as string;
          const letter = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"[pick];
          fc.pre(part !== "" && letter !== undefined);
          parts[index] = `${part.slice(0, -1)}${letter}`;
          expect(vault.open(parts.join("."), ALICE).ok).toBe(parts.join(".") === sealed);
        },
      ),
    );
  });

  it("cannot be told another key id: the id is authenticated", () => {
    const [current, old] = [newKey(), newKey()];
    const vault = new Vault(current, [old]);
    const sealed = new Vault(old).seal(new Secret(TOKEN), ALICE);
    const moved = sealed.replace(/^v1\.[0-9a-f]{8}/, `v1.${vaultKeyId(current)}`);
    expect(vault.open(moved, ALICE)).toEqual({ ok: false, cause: "corrupt" });
  });
});

describe("rotation", () => {
  it("seals with the current key and opens with the old ones", () => {
    const [before, after, older] = [newKey(), newKey(), newKey()];
    const sealedBefore = new Vault(before).seal(new Secret(TOKEN), ALICE);
    const sealedOlder = new Vault(older).seal(new Secret(TOKEN), ALICE);
    const vault = new Vault(after, [before, older]);

    for (const sealed of [sealedBefore, sealedOlder]) {
      const opened = vault.open(sealed, ALICE);
      expect(opened.ok && opened.token.reveal()).toBe(TOKEN);
      expect(opened.ok && opened.onCurrentKey).toBe(false);
    }
    const resealed = vault.seal(new Secret(TOKEN), ALICE);
    expect(resealed.split(".")[1]).toBe(vaultKeyId(after));
    expect(vault.open(resealed, ALICE)).toMatchObject({ ok: true, onCurrentKey: true });
  });

  it("says when a value's key is gone: a wrong key is never tried", () => {
    const sealed = new Vault(newKey()).seal(new Secret(TOKEN), ALICE);
    expect(new Vault(newKey()).open(sealed, ALICE)).toEqual({ ok: false, cause: "unknown_key" });
  });
});

describe("what a key may be", () => {
  it("is 32 bytes of plain base64", () => {
    expect(isVaultKey(newKey())).toBe(true);
    const short = randomBytes(31).toString("base64");
    const long = randomBytes(33).toString("base64");
    const urlSafe = "-_".repeat(21).concat("-w==").slice(0, 44);
    for (const bad of ["", "not base64", short, long, urlSafe, `${newKey()}\n`, ` ${newKey()}`]) {
      expect(isVaultKey(bad)).toBe(false);
    }
    // The last character carries spare bits, so this is a typing error.
    expect(isVaultKey(Buffer.alloc(32, 7).toString("base64").replace("c=", "d="))).toBe(false);
  });

  it("is not one byte repeated", () => {
    expect(isVaultKey(Buffer.alloc(32).toString("base64"))).toBe(false);
    expect(isVaultKey(Buffer.alloc(32, 0xff).toString("base64"))).toBe(false);
  });

  it("has an id only when it is a key", () => {
    const key = newKey();
    expect(vaultKeyId(key)).toMatch(/^[0-9a-f]{8}$/);
    expect(vaultKeyId(key)).toBe(vaultKeyId(key));
    expect(vaultKeyId("nope")).toBeUndefined();
  });

  it("does not build from a value that is no key", () => {
    expect(() => new Vault("nope")).toThrow("vault: invalid key");
    let message = "";
    try {
      new Vault("hunter2-do-not-log");
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).not.toContain("hunter2");
  });

  it("notices the session secret, however it is written", () => {
    const key = newKey();
    expect(reusesSecret(key, key)).toBe(true);
    expect(reusesSecret(key, Buffer.from(key, "base64").toString("base64url"))).toBe(true);
    expect(reusesSecret(key, newKey())).toBe(false);
  });
});

describe("nothing prints a token or a key", () => {
  const key = newKey();
  const vault = new Vault(key);
  const secret = new Secret(TOKEN);

  it("not from a Secret or a Vault, however it is turned into text", () => {
    for (const value of [
      secret,
      vault,
      { nested: { secret, vault } },
      [secret],
      new Map([[1, secret]]),
    ]) {
      for (const text of [
        JSON.stringify(value),
        inspect(value, { depth: 10, showHidden: true }),
        String(value),
        `${value}`,
      ]) {
        expect(text).not.toContain(TOKEN);
        expect(text).not.toContain(key);
      }
    }
    expect(secret.reveal()).toBe(TOKEN);
    expect(Object.keys(secret)).toEqual([]);
    expect(Object.keys(vault)).toEqual([]);
    expect(structuredClone({ a: 1, b: { ...secret } })).toEqual({ a: 1, b: {} });
  });

  it("not in a log line when held as a Secret, nor a plain string by a telling name", () => {
    const logs = collectLogs("trace");
    logs.logger.info({ secret, vault, deep: { token: secret } }, "objects");
    logs.logger.error({ err: new Error("failed"), context: { secret } }, "with an error");
    logs.logger.info(
      {
        token: TOKEN,
        accessToken: TOKEN,
        refreshToken: TOKEN,
        vaultKey: key,
        connector: { token: TOKEN, accessToken: TOKEN, refreshToken: TOKEN, vaultKey: key },
      },
      "plain strings",
    );
    // A Secret needs no name on the redact list, at any depth: it prints for itself.
    logs.logger.info(
      { whatever: { a: { b: { c: { d: { e: secret } } } } }, list: [[secret]] },
      "deep",
    );
    const output = logs.raw.join("");
    expect(output).not.toContain(TOKEN);
    expect(output).not.toContain(key);
    expect(logs.lines[3]).toMatchObject({
      whatever: { a: { b: { c: { d: { e: "[secret]" } } } } },
      list: [["[secret]"]],
    });
    expect(logs.lines[0]).toMatchObject({ vault: "[vault]", deep: { token: "[redacted]" } });
    expect(logs.lines[1]).toMatchObject({ context: { secret: "[redacted]" } });
  });

  it("not in what a failed open returns", () => {
    const sealed = vault.seal(secret, ALICE);
    const failed = vault.open(sealed, { ...ALICE, userId: "user-bob" });
    expect(JSON.stringify(failed)).toBe('{"ok":false,"cause":"corrupt"}');
  });

  it("not the sealed value's token either", () => {
    const sealed = vault.seal(secret, ALICE);
    expect(sealed).not.toContain(TOKEN);
    expect(sealed).not.toContain(Buffer.from(TOKEN).toString("base64url"));
    expect(sealed).not.toContain(key);
  });
});
