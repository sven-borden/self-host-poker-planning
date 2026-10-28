import { MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH } from "@pp/domain";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ARGON2_PARAMS,
  CorruptHashError,
  createHashGate,
  hashPassword,
  normalisePassword,
  verifyPassword,
} from "./password.ts";

describe("normalisePassword", () => {
  it("takes 6 to 128 characters, counted as code points after NFC", () => {
    expect(MIN_PASSWORD_LENGTH).toBe(6);
    expect(normalisePassword("a".repeat(MIN_PASSWORD_LENGTH))).toBe("aaaaaa");
    expect(normalisePassword("a".repeat(MIN_PASSWORD_LENGTH - 1))).toBeNull();
    expect(normalisePassword("a".repeat(MAX_PASSWORD_LENGTH))).toHaveLength(MAX_PASSWORD_LENGTH);
    expect(normalisePassword("a".repeat(MAX_PASSWORD_LENGTH + 1))).toBeNull();
    // Six emoji are six characters, though twelve UTF-16 units.
    expect(normalisePassword("🔒🔑🚪🔒🔑🚪")).not.toBeNull();
    expect(normalisePassword("🔒🔑🚪")).toBeNull();
  });

  it("makes a composed and a decomposed accent the same password", () => {
    const composed = "caf\u{e9} au lait";
    const decomposed = "cafe\u{301} au lait";
    expect(composed).not.toBe(decomposed);
    expect(normalisePassword(decomposed)).toBe(composed);
  });

  it("never trims: spaces count, and a password of spaces is a password", () => {
    expect(normalisePassword("  ab  ")).toBe("  ab  ");
    expect(normalisePassword("      ")).toBe("      ");
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

  it("accepts only its own parameters: any other hash is corrupt, before any work (N2)", async () => {
    const hash = await hashPassword("open sesame");
    const salt = "c2FsdHNhbHRzYWx0c2FsdA";
    const tag = "a".repeat(43);
    for (const phc of [
      "",
      "plain",
      hash.replace("m=19456,t=2", "m=8192,t=3"),
      // A cost of 9.5 GiB and 999 passes would hold the gate for minutes.
      `$argon2id$v=19$m=9999999,t=999,p=1$${salt}$${tag}`,
      `$argon2id$v=19$m=19456,t=2,p=2$${salt}$${tag}`,
      `$argon2i$v=19$m=19456,t=2,p=1$${salt}$${tag}`,
      `$argon2id$v=19$m=19456,t=2,p=1$YQ$${tag}`,
      `$argon2id$v=19$m=19456,t=2,p=1$${salt}$YWJjZGVmZ2hpamtsbW5vcA`,
    ]) {
      const refused = verifyPassword("open sesame", phc);
      await expect(refused).rejects.toBeInstanceOf(CorruptHashError);
      await expect(refused).rejects.not.toThrow(phc || "never");
    }
  });
});

describe("createHashGate", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  /** A task that ends when the test says so. */
  function held() {
    const ends: Array<() => void> = [];
    const order: number[] = [];
    let n = 0;
    const task = () => {
      const mine = ++n;
      return new Promise<number>((resolve) =>
        ends.push(() => {
          order.push(mine);
          resolve(mine);
        }),
      );
    };
    return { ends, order, task };
  }

  it("runs at most two at once and lines the next ones up, first come first served (S1)", async () => {
    const gate = createHashGate();
    const { ends, order, task } = held();
    const runs = Array.from({ length: 5 }, () => gate.run(task));
    await Promise.resolve();
    expect([gate.busy, gate.waiting]).toEqual([2, 3]);
    // Each run that ends hands its place to the first in line.
    for (let i = 0; i < 5; i++) {
      await vi.waitFor(() => expect(ends.length).toBe(Math.min(i + 2, 5)));
      ends[i]?.();
    }
    expect(await Promise.all(runs)).toEqual([1, 2, 3, 4, 5]);
    expect(order).toEqual([1, 2, 3, 4, 5]);
    expect([gate.busy, gate.waiting]).toEqual([0, 0]);
  });

  it("refuses at once when 32 wait, and a wait longer than 2 s", async () => {
    vi.useFakeTimers();
    const gate = createHashGate();
    const { ends, task } = held();
    const runs = Array.from({ length: 34 }, () => gate.run(task));
    expect([gate.busy, gate.waiting]).toEqual([2, 32]);
    expect(await gate.run(task)).toBeNull();
    await vi.advanceTimersByTimeAsync(1999);
    expect(gate.waiting).toBe(32);
    await vi.advanceTimersByTimeAsync(1);
    expect(gate.waiting).toBe(0);
    const results = await Promise.all(runs.slice(2));
    expect(results.every((r) => r === null)).toBe(true);
    for (const end of ends) end();
    expect(await Promise.all(runs.slice(0, 2))).toEqual([1, 2]);
    expect(gate.busy).toBe(0);
    expect(await gate.run(async () => "again")).toBe("again");
  });

  it("frees its place when a run fails, or hands it on", async () => {
    const gate = createHashGate({ running: 1 });
    const failing = gate.run(() => Promise.reject(new Error("boom")));
    const next = gate.run(async () => "next");
    await expect(failing).rejects.toThrow("boom");
    expect(await next).toBe("next");
    expect([gate.busy, gate.waiting]).toEqual([0, 0]);
  });
});
