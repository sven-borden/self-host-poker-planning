import { isRoomCode } from "@pp/domain";

/** What "Join with a code" makes of the field: a code to open, or why not. */
export type RoomInput =
  | { readonly ok: true; readonly code: string }
  | { readonly ok: false; readonly reason: "empty" | "malformed" };

/** `/r/CODE` at the end of a path, with an optional slash, query or fragment after it. */
const ROOM_PATH = /(?:^|\/)r\/([^/?#]*)\/?(?:[?#].*)?$/u;

/**
 * Reads what a person typed or pasted into "Join with a code": a bare code, a path such
 * as `/r/CODE`, or a whole room link from this site or another address
 * (`https://…/r/CODE`). White space anywhere is ignored, since codes are often read out
 * and typed in groups. Only a well-formed code (the domain's `isRoomCode`) comes back;
 * case matters, as base58 tells `a` from `A`.
 */
export function parseRoomInput(raw: string): RoomInput {
  const text = raw.replace(/\s+/gu, "");
  if (text === "") return { ok: false, reason: "empty" };
  const candidate = ROOM_PATH.exec(text)?.[1] ?? text;
  return isRoomCode(candidate) ? { ok: true, code: candidate } : { ok: false, reason: "malformed" };
}
