import { MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH } from "@pp/domain";
import { describe, expect, it } from "vitest";
import {
  ARGON2_PARAMS,
  createHashGate,
  hashPassword,
  normalisePassword,
  verifyPassword,
} from "./password.ts";

describe("normalisePassword", () => {
  it("takes 4 to 128 characters, counted as code points after NFC", () => {
    expect(normalisePassword("a".repeat(MIN_PASSWORD_LENGTH))).toBe("aaaa");
    expect(normalisePassword("a".repeat(MIN_PASSWORD_LENGTH - 1))).toBeNull();
    expect(normalisePassword("a".repeat(MAX_PASSWORD_LENGTH))).toHaveLength(MAX_PASSWORD_LENGTH);
    expect(normalisePassword("a".repeat(MAX_PASSWORD_LENGTH + 1))).toBeNull();
    // Four emoji are four characters, though eight UTF-16 units.
    expect(normalisePassword("🔒🔑🗝️🚪")).not.toBeNull();
    expect(normalisePassword("🔒🔑")).toBeNull();
  });

  it("makes a composed and a decomposed accent the same password", () => {
    const composed = "caf\u{e9}!";
    const decomposed = "cafe\u{301}!";
    expect(composed).not.toBe(decomposed);
    expect(normalisePassword(decomposed)).toBe(composed);
  });

  it("never trims: spaces count, and a password of spaces is a password", () => {
    expect(normalisePassword("  ab  ")).toBe("  ab  ");
    expect(normalisePassword("    ")).toBe("    ");
  });

  it("refuses text that is not well formed (a lone surrogate)", () => {
    expect(normalisePassword("abc\u{d800}")).toBeNull();
  });
});

describe("hashPassword and verifyPassword", () => {
  it("stores a PHC string with OWASP's argon2id parameters and a random salt", async () => {
    const [one, two] = await Promise.all([
      hashPassword("open sesame"),
      hashPassword("open sesame"),
    ]);
    const { memory, passes, parallelism } = ARGON2_PARAMS;
    expect(one).toMatch(
      new RegExp(
        `^\\$argon2id\\$v=19\\$m=${memory},t=${passes},p=${parallelism}\\$[A-Za-z0-9+/]{22}\\$[A-Za-z0-9+/]{43}$`,
      ),
    );
    expect(memory).toBe(19 * 1024);
    expect(one).not.toBe(two);
    expect(one).not.toContain("open sesame");
  });

  it("checks the right password and refuses any other", async () => {
    const hash = await hashPassword("open sesame");
    expect(await verifyPassword("open sesame", hash)).toBe(true);
    expect(await verifyPassword("open sesame ", hash)).toBe(false);
    expect(await verifyPassword("Open sesame", hash)).toBe(false);
  });

  it("checks with the parameters stored in the hash, not the current ones", async () => {
    const hash = await hashPassword("open sesame");
    const cheaper = hash.replace("m=19456,t=2", "m=8192,t=3");
    expect(await verifyPassword("open sesame", cheaper)).toBe(false);
  });

  it("refuses a stored string it did not write, without throwing", async () => {
    for (const phc of [
      "",
      "plain",
      "$argon2i$v=19$m=19456,t=2,p=1$c2FsdHNhbHQ$aGFzaA",
      "$argon2id$v=19$m=19456,t=2,p=1$YQ$YWJjZGVmZ2hpamtsbW5vcA",
    ]) {
      expect(await verifyPassword("open sesame", phc)).toBe(false);
    }
  });
});

describe("createHashGate", () => {
  it("runs at most `max` at once and refuses the next one at once, never queues it", async () => {
    const gate = createHashGate(2);
    const releases: Array<() => void> = [];
    const task = () => new Promise<string>((resolve) => releases.push(() => resolve("done")));
    const first = gate.run(task);
    const second = gate.run(task);
    expect(gate.busy).toBe(2);
    expect(await gate.run(task)).toBeNull();
    for (const release of releases) release();
    expect(await Promise.all([first, second])).toEqual(["done", "done"]);
    expect(gate.busy).toBe(0);
    expect(await gate.run(async () => "again")).toBe("again");
  });

  it("frees its place when a run fails", async () => {
    const gate = createHashGate(1);
    await expect(gate.run(() => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    expect(gate.busy).toBe(0);
  });
});
