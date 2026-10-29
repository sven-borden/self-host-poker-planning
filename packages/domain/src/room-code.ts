/**
 * The shape of a room code (architecture section 8): 10 characters of base58, about 58.6
 * bits. The server draws codes (`apps/server/src/room-code.ts`); the web app checks a
 * typed or pasted code against the same rule before it opens `/r/:code`.
 */

/** Bitcoin's base58: digits and letters without 0, O, I and l, which read alike. */
export const ROOM_CODE_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
export const ROOM_CODE_LENGTH = 10;
/** A well-formed room code; anything else cannot name a room. */
export const ROOM_CODE_PATTERN = /^[1-9A-HJ-NP-Za-km-z]{10}$/;

export function isRoomCode(value: string): boolean {
  return ROOM_CODE_PATTERN.test(value);
}

/** The segment after `/r/` or `/api/rooms/` in a path or a URL, in any case. */
const ROOM_PATH = /(\/(?:r|api\/rooms)\/+)[^/?#\s"'`<>]+/gi;

/**
 * `text` with the segment after `/r/` or `/api/rooms/`, and every one of `codes` wherever
 * it stands, replaced by `:code`. For what leaves on purpose (#40: error reports and page
 * views): a room code is a bearer capability (architecture section 11). A code-shaped word
 * elsewhere stays: ten letters such as "connection" fit the alphabet.
 */
export function hideRoomCodes(text: string, codes: Iterable<string> = []): string {
  let hidden = text.replace(ROOM_PATH, "$1:code");
  for (const code of codes) if (code) hidden = hidden.replaceAll(code, ":code");
  return hidden;
}

/** `value` with `hideRoomCodes` applied to every string in it, keys included. */
export function hideRoomCodesIn<T>(value: T, codes: readonly string[] = []): T {
  if (typeof value === "string") return hideRoomCodes(value, codes) as T;
  if (Array.isArray(value)) return value.map((item) => hideRoomCodesIn(item, codes)) as T;
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [
      hideRoomCodes(key, codes),
      hideRoomCodesIn(child, codes),
    ]),
  ) as T;
}
