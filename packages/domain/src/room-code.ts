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
