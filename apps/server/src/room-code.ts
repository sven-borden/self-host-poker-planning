/**
 * Room codes (architecture section 8): 10 characters of base58 from `crypto.randomBytes`,
 * about 58.6 bits. The code is the room's address (`/r/:code`) and its only secret until
 * a password is set (W2), so it is drawn without bias and never logged.
 */
import { randomBytes } from "node:crypto";
import { ROOM_CODE_ALPHABET, ROOM_CODE_LENGTH } from "@pp/domain";

// The shape of a code lives in the domain, which the web app shares.
export { isRoomCode, ROOM_CODE_ALPHABET, ROOM_CODE_LENGTH, ROOM_CODE_PATTERN } from "@pp/domain";

/** `crypto.randomBytes`, or a stub in tests. */
export type RandomBytes = (size: number) => Uint8Array;

/**
 * Bytes at or above this (232 = 4 × 58) are dropped: `byte % 58` over 0 to 231 hits every
 * character exactly four times, so the draw has no modulo bias (rejection sampling).
 */
const ACCEPT_BELOW = 256 - (256 % ROOM_CODE_ALPHABET.length);
/** Bytes drawn per batch: 10 are needed, about 9 % of the draws are dropped. */
const BATCH = 16;

export function generateRoomCode(random: RandomBytes = randomBytes): string {
  let code = "";
  while (code.length < ROOM_CODE_LENGTH) {
    for (const byte of random(BATCH)) {
      if (byte >= ACCEPT_BELOW) continue;
      code += ROOM_CODE_ALPHABET[byte % ROOM_CODE_ALPHABET.length];
      if (code.length === ROOM_CODE_LENGTH) break;
    }
  }
  return code;
}
