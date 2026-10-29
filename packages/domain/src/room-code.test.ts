import { describe, expect, it } from "vitest";
import {
  hideRoomCodes,
  isRoomCode,
  ROOM_CODE_ALPHABET,
  ROOM_CODE_LENGTH,
  ROOM_CODE_PATTERN,
} from "./index.ts";

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

  it("are hidden in room paths and wherever a known code stands", () => {
    const cases: Array<[string, string]> = [
      ["https://poker.example.com/r/Abc1234567?x=1#y", "https://poker.example.com/r/:code?x=1#y"],
      ["GET /api/rooms/Abc1234567/password", "GET /api/rooms/:code/password"],
      ["at /R//abc and /API/Rooms/xyz", "at /R//:code and /API/Rooms/:code"],
      ['"/r/Abc1234567"', '"/r/:code"'],
      ["/r/:code", "/r/:code"],
      ["the connection dropped", "the connection dropped"],
      ["/rooms/Abc1234567 /rx/Abc1234567", "/rooms/Abc1234567 /rx/Abc1234567"],
    ];
    for (const [text, hidden] of cases) expect(hideRoomCodes(text), text).toBe(hidden);
    expect(hideRoomCodes("room Abc1234567 failed, Abc1234567 again", ["Abc1234567", ""])).toBe(
      "room :code failed, :code again",
    );
  });
});
