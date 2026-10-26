import type { AckErrorCode } from "@pp/protocol";
import { en } from "./en.ts";
import type { TFunction } from "./i18n.ts";

// The server answers with codes, never sentences (ADR-012). Every code `@pp/protocol`
// lists has a message in every language; i18n.test.ts enumerates them.

/** True for a code this version has a message for. */
export function isKnownErrorCode(code: string): code is AckErrorCode {
  return code !== "unknown" && Object.hasOwn(en.errors, code);
}

/** The message for a server error code, or a generic one for a code this version does not know. */
export function errorMessage(t: TFunction, code: string): string {
  return isKnownErrorCode(code) ? t(`errors.${code}`) : t("errors.unknown");
}
