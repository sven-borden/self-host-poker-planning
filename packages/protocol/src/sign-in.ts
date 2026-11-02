/**
 * What the server and the page share about signing in with Google or Microsoft (#47,
 * ADR-023). The page learns from a `<meta>` tag which providers exist; a failed sign-in comes
 * back as a full-page redirect that carries one of these codes, never a sentence.
 */

/** The providers this version knows, in the order the page shows them. */
export const SIGN_IN_PROVIDERS = ["google", "microsoft"] as const;
export type SignInProvider = (typeof SIGN_IN_PROVIDERS)[number];

/** The `<meta name>` listing the configured providers; left out when there are none. */
export const SIGN_IN_META = "pp-sign-in";

/** The query parameter a failed sign-in comes back to the page with. */
export const SIGN_IN_ERROR_PARAM = "sign_in_error";

/**
 * Why a sign-in did not finish: the person went back at the provider (`cancelled`), the email
 * belongs to an account that signs in another way (`account_exists`), the provider sent no
 * email (`no_email`), too many tries (`rate_limited`), or anything else (`failed`).
 */
export const SIGN_IN_ERROR_CODES = [
  "cancelled",
  "account_exists",
  "no_email",
  "rate_limited",
  "failed",
] as const;
export type SignInErrorCode = (typeof SIGN_IN_ERROR_CODES)[number];

export function isSignInErrorCode(value: unknown): value is SignInErrorCode {
  return (SIGN_IN_ERROR_CODES as readonly unknown[]).includes(value);
}
