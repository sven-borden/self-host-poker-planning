import {
  isSignInErrorCode,
  SIGN_IN_ERROR_PARAM,
  SIGN_IN_META,
  SIGN_IN_PROVIDERS,
  type SignInErrorCode,
  type SignInProvider,
} from "@pp/protocol";

// What the page knows about signing in with Google or Microsoft (#47, ADR-023): which
// providers this install has, from a tag the server puts in `index.html` (none without keys,
// and the service worker never stores a page, so it cannot go stale), and why a sign-in came
// back without finishing.

/** The providers the server's page names, in the order they show. */
export function signInProviders(): SignInProvider[] {
  const tag = document.querySelector<HTMLMetaElement>(`meta[name="${SIGN_IN_META}"]`);
  const named = tag?.content.split(" ") ?? [];
  return SIGN_IN_PROVIDERS.filter((id) => named.includes(id));
}

/** The app's path to come back to: the server takes `/` or a room's. */
export function returnPath(): string {
  return window.location.pathname.replace(/\/+$/, "") || "/";
}

let pendingError: SignInErrorCode | null = null;

/**
 * Takes the failure a sign-in came back with out of the address, before the router or the page
 * views read it, for `takeSignInError`. A value this version does not know is a plain failure.
 */
export function readSignInError(): void {
  const url = new URL(window.location.href);
  const code = url.searchParams.get(SIGN_IN_ERROR_PARAM);
  if (code === null) return;
  url.searchParams.delete(SIGN_IN_ERROR_PARAM);
  window.history.replaceState(window.history.state, "", url);
  pendingError = isSignInErrorCode(code) ? code : "failed";
}

/** The failure `readSignInError` found, once. */
export function takeSignInError(): SignInErrorCode | null {
  const code = pendingError;
  pendingError = null;
  return code;
}
