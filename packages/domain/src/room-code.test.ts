import { describe, expect, it } from "vitest";
import { isRoomCode, ROOM_CODE_ALPHABET, ROOM_CODE_LENGTH, ROOM_CODE_PATTERN } from "./index.ts";

describe("room codes", () => {
  it("are 10 characters of base58, at least 58 bits", () => {
    expect(ROOM_CODE_ALPHABET).toHaveLength(58);
    expect(ROOM_CODE_ALPHABET).not.toMatch(/[0OIl]/);
    expect(ROOM_CODE_LENGTH * Math.log2(ROOM_CODE_ALPHABET.length)).toBeGreaterThan(58);
  });

  it("match the pattern exactly when every character is in the alphabet", () => {
    for (let code = 0; code < 128; code += 1) {
      const char = String.fromCharCode(code);
      expect(ROOM_CODE_PATTERN.test(char.repeat(10)), char).toBe(ROOM_CODE_ALPHABET.includes(char));
    }
    expect(isRoomCode("Abc1234567")).toBe(true);
    for (const bad of ["", "Abc123456", "Abc12345678", "Abc 234567", "Abc1234567\n"]) {
      expect(isRoomCode(bad), JSON.stringify(bad)).toBe(false);
    }
  });
});
