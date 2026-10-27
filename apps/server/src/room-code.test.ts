import { describe, expect, it } from "vitest";
import {
  generateRoomCode,
  isRoomCode,
  ROOM_CODE_ALPHABET,
  ROOM_CODE_LENGTH,
  ROOM_CODE_PATTERN,
} from "./room-code.ts";

describe("room codes", () => {
  it("are 10 characters of base58, about 58 bits", () => {
    expect(ROOM_CODE_ALPHABET).toHaveLength(58);
    expect(new Set(ROOM_CODE_ALPHABET).size).toBe(58);
    expect(ROOM_CODE_ALPHABET).not.toMatch(/[0OIl]/);
    expect(ROOM_CODE_LENGTH * Math.log2(ROOM_CODE_ALPHABET.length)).toBeGreaterThan(58);
    // The pattern accepts exactly the alphabet.
    for (let unit = 0x20; unit < 0x7f; unit++) {
      const char = String.fromCharCode(unit);
      expect(ROOM_CODE_PATTERN.test(char.repeat(10)), char).toBe(ROOM_CODE_ALPHABET.includes(char));
    }
    const code = generateRoomCode();
    expect(code).toHaveLength(ROOM_CODE_LENGTH);
    expect(isRoomCode(code)).toBe(true);
  });

  it("draws 10,000 codes without a duplicate and with a roughly uniform first character", () => {
    const codes = Array.from({ length: 10_000 }, () => generateRoomCode());
    expect(new Set(codes).size).toBe(codes.length);
    expect(codes.every(isRoomCode)).toBe(true);
    const counts = new Map<string, number>();
    for (const code of codes) counts.set(code[0] ?? "", (counts.get(code[0] ?? "") ?? 0) + 1);
    // Every character comes first; about 172 times each (σ ≈ 13), so 100 to 250 is
    // more than 5 σ either way. A chi-square over 57 degrees of freedom stays far below
    // 120 unless the draw is biased.
    expect(counts.size).toBe(58);
    const expected = codes.length / 58;
    let chiSquare = 0;
    for (const count of counts.values()) {
      expect(count).toBeGreaterThan(100);
      expect(count).toBeLessThan(250);
      chiSquare += (count - expected) ** 2 / expected;
    }
    expect(chiSquare).toBeLessThan(120);
  });

  it("drops the bytes from 232 up, so no character is favoured (rejection sampling)", () => {
    const batches = [
      [232, 255, 240, 0, 57, 58, 231, 115, 116, 173, 174, 1, 2, 3, 4, 5],
      [6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21],
    ];
    const sizes: number[] = [];
    const code = generateRoomCode((size) => {
      sizes.push(size);
      return Uint8Array.from(batches.shift() ?? []);
    });
    // 0 → "1", 57 → "z", 58 → "1", 231 → "z" (231 % 58 = 57), 115 → "z", 116 → "1", …
    expect(code).toBe("1z1zz1z123");
    expect(sizes).toEqual([16]);
    // A batch of rejects only: another batch is drawn.
    const more = [Array(16).fill(250), Array(16).fill(9)];
    expect(generateRoomCode(() => Uint8Array.from(more.shift() ?? []))).toBe("A".repeat(10));
  });

  it("refuses anything that is not a code", () => {
    for (const bad of [
      "",
      "abc",
      "1234567890a",
      "0OIl000000",
      "abcdefghi ",
      "ABCDEFGHI/",
      "ａbcdefghij",
    ]) {
      expect(isRoomCode(bad), bad).toBe(false);
    }
    expect(isRoomCode("abcdefghij")).toBe(true);
  });
});
