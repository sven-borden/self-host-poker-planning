import { describe, expect, it } from "vitest";
import { parseRoomInput } from "./room-input.ts";

const CODE = "Abc1234567";
/** The page's own `location.host` in these tests. */
const HERE = "poker.example.com";
const parse = (typed: string) => parseRoomInput(typed, HERE);

describe("parseRoomInput", () => {
  it("takes a bare code as it is", () => {
    expect(parse(CODE)).toEqual({ ok: true, code: CODE });
  });

  it("ignores white space anywhere, as a code read out in groups is typed", () => {
    for (const typed of [
      ` ${CODE} `,
      "Abc12 34567",
      "Abc 123 4567",
      "\tAbc1234567\n",
      "A b c 1 2 3 4 5 6 7",
      "Abc12\u{00A0}34567",
    ]) {
      expect(parse(typed), typed).toEqual({ ok: true, code: CODE });
    }
  });

  it("ignores dashes of every kind between the groups", () => {
    for (const typed of [
      "Abc-123-4567",
      "Abc12-34567",
      "Abc12\u{2013}34567",
      "Abc12\u{2014}34567",
      "Abc12\u{2010}34567",
      "Abc12\u{2212}34567",
      "-Abc1234567-",
    ]) {
      expect(parse(typed), JSON.stringify(typed)).toEqual({ ok: true, code: CODE });
    }
  });

  it("ignores zero-width characters a chat slips into a paste", () => {
    for (const typed of [
      "Abc12\u{200B}34567",
      "\u{200B}Abc1234567",
      "Abc1234567\u{200B}",
      "Abc\u{200C}12\u{200D}34567",
      "\u{FEFF}Abc1234567",
      "Abc12\u{2060}34567",
      "Abc12\u{00AD}34567",
    ]) {
      expect(parse(typed), JSON.stringify(typed)).toEqual({ ok: true, code: CODE });
    }
  });

  it("trims a trailing period or other punctuation", () => {
    for (const typed of [
      `${CODE}.`,
      `${CODE},`,
      `${CODE}!`,
      `${CODE}?`,
      `${CODE}:`,
      `${CODE};`,
      `${CODE}\u{2026}`,
      `${CODE}...`,
      `https://${HERE}/r/${CODE}.`,
    ]) {
      expect(parse(typed), typed).toEqual({ ok: true, code: CODE });
    }
  });

  it("trims surrounding quotes and brackets", () => {
    for (const typed of [
      `"${CODE}"`,
      `'${CODE}'`,
      `\`${CODE}\``,
      `\u{201C}${CODE}\u{201D}`,
      `\u{2018}${CODE}\u{2019}`,
      `\u{201E}${CODE}\u{201C}`,
      `\u{00AB}\u{202F}${CODE}\u{202F}\u{00BB}`,
      `(${CODE})`,
      `[${CODE}]`,
      `{${CODE}}`,
      `<${CODE}>`,
      `<https://${HERE}/r/${CODE}>`,
      `("${CODE}").`,
      `*${CODE}*`,
    ]) {
      expect(parse(typed), typed).toEqual({ ok: true, code: CODE });
    }
  });

  it("finds the code in a pasted link from this site", () => {
    for (const link of [
      `https://${HERE}/r/${CODE}`,
      `http://${HERE}/r/${CODE}`,
      `https://${HERE}/r/${CODE}/`,
      `https://${HERE}/r/${CODE}?from=chat#top`,
      `https://${HERE}/team/r/${CODE}`,
      `https://POKER.Example.com/r/${CODE}`,
      `HTTPS://${HERE}/r/${CODE}`,
      `${HERE}/r/${CODE}`,
      `/r/${CODE}`,
      `r/${CODE}`,
      ` https://${HERE}/r/ ${CODE} `,
    ]) {
      expect(parse(link), link).toEqual({ ok: true, code: CODE });
    }
  });

  it("compares the host with its port", () => {
    expect(parseRoomInput(`http://localhost:5173/r/${CODE}`, "localhost:5173")).toEqual({
      ok: true,
      code: CODE,
    });
    expect(parseRoomInput(`http://localhost:4173/r/${CODE}`, "localhost:5173")).toMatchObject({
      ok: false,
      reason: "otherHost",
      host: "localhost:4173",
    });
  });

  it("does not open a room link for another host, and offers that link instead", () => {
    expect(parse(`https://poker.other.org/r/${CODE}?from=chat`)).toEqual({
      ok: false,
      reason: "otherHost",
      host: "poker.other.org",
      href: `https://poker.other.org/r/${CODE}?from=chat`,
    });
    expect(parse(`"http://other.example.com:8080/team/r/${CODE}".`)).toEqual({
      ok: false,
      reason: "otherHost",
      host: "other.example.com:8080",
      href: `http://other.example.com:8080/team/r/${CODE}`,
    });
  });

  it("refuses a link that is not http or https, or holds no room code", () => {
    for (const typed of [
      `javascript://${HERE}/r/${CODE}`,
      `ftp://${HERE}/r/${CODE}`,
      `file:///r/${CODE}`,
      `data://text/r/${CODE}`,
      "https://poker.other.org/",
      "https://poker.other.org/r/abc",
      `https://poker.other.org/x/${CODE}`,
      "https://[bad/r/Abc1234567",
    ]) {
      expect(parse(typed), typed).toEqual({ ok: false, reason: "malformed" });
    }
  });

  it("says when the field is empty", () => {
    for (const typed of ["", "   ", "\n", "\u{200B}", '""', "()", "."]) {
      expect(parse(typed), JSON.stringify(typed)).toEqual({ ok: false, reason: "empty" });
    }
  });

  it("refuses anything that is not a well-formed code", () => {
    for (const typed of [
      "abc",
      "Abc12345678",
      "0OIl000000",
      "abcdefghi!",
      `https://${HERE}/`,
      `https://${HERE}/r/`,
      `https://${HERE}/r/abc`,
      `https://${HERE}/r/${CODE}/extra`,
      `https://${HERE}/x/${CODE}`,
      "\u{FF41}bcdefghij",
      "Abc12_34567",
    ]) {
      expect(parse(typed), typed).toEqual({ ok: false, reason: "malformed" });
    }
  });

  it("keeps the case, which base58 tells apart", () => {
    expect(parse("abc1234567")).toEqual({ ok: true, code: "abc1234567" });
    expect(parse("ABC1234567")).toEqual({ ok: true, code: "ABC1234567" });
  });
});
