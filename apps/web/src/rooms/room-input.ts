import { isRoomCode } from "@pp/domain";

/** What "Join with a code" makes of the field: a code to open, or why not. */
export type RoomInput =
  | { readonly ok: true; readonly code: string }
  | { readonly ok: false; readonly reason: "empty" | "malformed" }
  /** A room link for another host: not opened here, the person is offered that host. */
  | {
      readonly ok: false;
      readonly reason: "otherHost";
      readonly host: string;
      readonly href: string;
    };

/** `/r/CODE` at the end of a path, with an optional slash, query or fragment after it. */
const ROOM_PATH = /(?:^|\/)r\/([^/?#]*)\/?(?:[?#].*)?$/u;

/** White space and the invisible characters a chat or a document slips into a paste. */
const INVISIBLE = /[\s\u{200B}-\u{200D}\u{2060}\u{FEFF}\u{00AD}]+/gu;

/** Quotes, brackets and punctuation a code is often wrapped in or followed by. */
const LEADING = /^[\p{Pi}\p{Pf}\p{Ps}"'`<.,;:!?\u{2026}*_~]+/u;
const TRAILING = /[\p{Pi}\p{Pf}\p{Pe}"'`>.,;:!?\u{2026}*_~]+$/u;

/** Dashes of every kind (hyphen, en and em dash, minus), as codes are read out in groups. */
const DASHES = /[\p{Pd}\u{2212}]/gu;

/** A whole address: a scheme and `//`. */
const ABSOLUTE = /^[a-z][a-z\d+.-]*:\/\//iu;

/**
 * Reads what a person typed or pasted into "Join with a code": a bare code, a path such
 * as `/r/CODE`, or a whole room link (`https://…/r/CODE`). White space, zero-width
 * characters and dashes are ignored, since codes are read out and typed in groups, and
 * surrounding quotes, brackets and punctuation are trimmed. Only a well-formed code (the
 * domain's `isRoomCode`) comes back; case matters, as base58 tells `a` from `A`.
 *
 * A full http(s) link whose host is not `here` (the page's `location.host`) is not opened
 * on this server: the same code on another instance is another room, or none. It comes
 * back as `otherHost`, with the link to offer instead (design brief, #24).
 */
export function parseRoomInput(raw: string, here: string): RoomInput {
  const text = raw.replace(INVISIBLE, "").replace(LEADING, "").replace(TRAILING, "");
  if (text === "") return { ok: false, reason: "empty" };
  if (ABSOLUTE.test(text)) return parseLink(text, here);
  return asCode(ROOM_PATH.exec(text)?.[1] ?? text);
}

function asCode(candidate: string): RoomInput {
  const code = candidate.replace(DASHES, "");
  return isRoomCode(code) ? { ok: true, code } : { ok: false, reason: "malformed" };
}

function parseLink(text: string, here: string): RoomInput {
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, reason: "malformed" };
  }
  const parsed = asCode(ROOM_PATH.exec(url.pathname)?.[1] ?? "");
  if (!parsed.ok || url.host === here.toLowerCase()) return parsed;
  return { ok: false, reason: "otherHost", host: url.host, href: url.href };
}
