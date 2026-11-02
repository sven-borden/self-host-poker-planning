/**
 * What the server and the page share about signing in with Google or Microsoft (#47,
 * ADR-023). The page learns from a `<meta>` tag which providers exist; a sign-in with something
 * to say comes back as a full-page redirect that carries one of these codes, never a sentence.
 */

/** The providers this version knows, in the order the page shows them. */
export const SIGN_IN_PROVIDERS = ["google", "microsoft"] as const;
export type SignInProvider = (typeof SIGN_IN_PROVIDERS)[number];

export function isSignInProvider(value: unknown): value is SignInProvider {
  return (SIGN_IN_PROVIDERS as readonly unknown[]).includes(value);
}

/** The `<meta name>` listing the configured providers; left out when there are none. */
export const SIGN_IN_META = "pp-sign-in";

/** The query parameter a failed sign-in comes back to the page with. */
export const SIGN_IN_ERROR_PARAM = "sign_in_error";

/**
 * Why a sign-in did not finish: the person went back at the provider (`cancelled`), the email
 * belongs to an account that signs in another way (`account_exists`), the provider sent no
 * email (`no_email`), this install does not admit that Microsoft account's tenant
 * (`tenant_not_allowed`), too many tries (`rate_limited`), or anything else (`failed`). The one
 * that is no failure: the person is signed in, and some of the guest's rooms have yet to move
 * (`still_moving`, #48). Each visit to a room tries again.
 */
export const SIGN_IN_ERROR_CODES = [
  "cancelled",
  "account_exists",
  "no_email",
  "tenant_not_allowed",
  "rate_limited",
  "failed",
  "still_moving",
] as const;
export type SignInErrorCode = (typeof SIGN_IN_ERROR_CODES)[number];

export function isSignInErrorCode(value: unknown): value is SignInErrorCode {
  return (SIGN_IN_ERROR_CODES as readonly unknown[]).includes(value);
}
