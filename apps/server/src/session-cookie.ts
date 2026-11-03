/**
 * The session token in a `Cookie` header, checked as Better Auth checks it before it looks the
 * session up, with no query (U2). Better Auth 1.7 signs the cookie through better-call's
 * `signCookieValue`: the value is `token.signature`, URI-encoded, where the signature is the
 * HMAC-SHA256 of the token under the auth secret, in base64 (44 characters). better-call does not
 * export its check, so this repeats it with `node:crypto`; `session-cookie.test.ts` holds it to a
 * cookie Better Auth itself set. The socket handshake counts its cap per session with this
 * (`realtime.ts`), so a forged cookie is refused for free and spends no one's bucket. Neither the
 * secret nor the token is ever logged or put in an error.
 */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";

/**
 * The first value of the cookie `name`, decoded, as better-call's `parseCookies` reads a header:
 * the first of two cookies with one name wins, a part without `=` is skipped, quotes come off.
 */
function cookieValue(header: string, name: string): string | undefined {
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1 || part.slice(0, eq).trim() !== name) continue;
    let value = part.slice(eq + 1).trim();
    if (value.codePointAt(0) === 34) value = value.slice(1, -1);
    try {
      return value.includes("%") ? decodeURIComponent(value) : value;
    } catch {
      return value;
    }
  }
  return undefined;
}

/**
 * The session token the cookie `name` in `header` carries, if its signature under `secret` holds,
 * else null. A valid signature says only that this server issued the token: it may since have
 * expired or been revoked, which the session middleware's lookup finds out.
 */
export function signedSessionToken(
  header: string | undefined,
  name: string,
  secret: string,
): string | null {
  const value = header === undefined ? undefined : cookieValue(header, name);
  if (value === undefined) return null;
  const dot = value.lastIndexOf(".");
  if (dot < 1) return null;
  const token = value.slice(0, dot);
  const signature = value.slice(dot + 1);
  if (signature.length !== 44 || !signature.endsWith("=")) return null;
  const given = Buffer.from(signature, "base64");
  const expected = createHmac("sha256", secret).update(token).digest();
  return given.length === expected.length && timingSafeEqual(given, expected) ? token : null;
}

/** What a session's handshakes are counted under: a hash, so the map holds no token. */
export function sessionKey(token: string): string {
  return createHash("sha256").update(token).digest("base64url");
}
