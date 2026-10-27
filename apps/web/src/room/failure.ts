import { errorMessage } from "../i18n/errors.ts";
import type { TFunction } from "../i18n/i18n.ts";
import { COOKIES_BLOCKED } from "../identity/identity.ts";

/** The code of a failed call: an `IdentityError`'s, or `unknown`. */
export function codeOf(error: unknown): string {
  const code = Reflect.get(Object(error), "code");
  return typeof code === "string" ? code : "unknown";
}

/**
 * What a refused join, rename, role change or leave says to the reader: the server's
 * code, or the browser's own trouble (no network, cookies blocked, the room not live).
 */
export function failureMessage(t: TFunction, code: string): string {
  if (code === "network") return t("common.network");
  if (code === COOKIES_BLOCKED) return t("identity.cookiesBlocked");
  if (code === "offline") return t("room.offline");
  return errorMessage(t, code);
}
