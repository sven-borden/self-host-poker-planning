import { describe, expect, it } from "vitest";
import { parseRoomInput } from "./room-input.ts";

const CODE = "Abc1234567";

describe("parseRoomInput", () => {
  it("takes a bare code as it is", () => {
    expect(parseRoomInput(CODE)).toEqual({ ok: true, code: CODE });
  });

  it("ignores white space anywhere, as a code read out in groups is typed", () => {
    for (const typed of [
      ` ${CODE} `,
      "Abc12 34567",
      "Abc 123 4567",
      "\tAbc1234567\n",
      "A b c 1 2 3 4 5 6 7",
    ]) {
      expect(parseRoomInput(typed), typed).toEqual({ ok: true, code: CODE });
    }
  });

  it("finds the code in a pasted link, from this site or another address", () => {
    for (const link of [
      `https://poker.example.com/r/${CODE}`,
      `http://localhost:4173/r/${CODE}`,
      `https://poker.example.com/r/${CODE}/`,
      `https://poker.example.com/r/${CODE}?from=chat#top`,
      `https://poker.example.com/team/r/${CODE}`,
      `poker.example.com/r/${CODE}`,
      `/r/${CODE}`,
      `r/${CODE}`,
      ` https://poker.example.com/r/ ${CODE} `,
    ]) {
      expect(parseRoomInput(link), link).toEqual({ ok: true, code: CODE });
    }
  });

  it("says when the field is empty", () => {
    for (const typed of ["", "   ", "\n"]) {
      expect(parseRoomInput(typed)).toEqual({ ok: false, reason: "empty" });
    }
  });

  it("refuses anything that is not a well-formed code", () => {
    for (const typed of [
      "abc",
      "Abc12345678",
      "0OIl000000",
      "abcdefghi!",
      "https://poker.example.com/",
      "https://poker.example.com/r/",
      "https://poker.example.com/r/abc",
      `https://poker.example.com/r/${CODE}/extra`,
      `https://poker.example.com/x/${CODE}`,
      "ａbcdefghij",
    ]) {
      expect(parseRoomInput(typed), typed).toEqual({ ok: false, reason: "malformed" });
    }
  });

  it("keeps the case, which base58 tells apart", () => {
    expect(parseRoomInput("abc1234567")).toEqual({ ok: true, code: "abc1234567" });
    expect(parseRoomInput("ABC1234567")).toEqual({ ok: true, code: "ABC1234567" });
  });
});
