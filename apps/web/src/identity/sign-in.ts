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

/** The app's path to come back to: the server takes `/`, `/rooms`, `/account` or a room's. */
export function returnPath(): string {
  return window.location.pathname.replace(/\/+$/, "") || "/";
}

/** The channel on which the page a sign-in came back to tells this browser's other tabs (#48). */
export const SIGN_IN_CHANNEL = "pp-sign-in";

/** In `sessionStorage`, which a tab keeps across the provider's pages: this tab went to sign in. */
const LEFT_TO_SIGN_IN = "pp-left-to-sign-in";

/** Notes that this tab is leaving for a provider, for `announceSignIn` when it comes back. */
export function noteLeavingToSignIn(): void {
  try {
    sessionStorage.setItem(LEFT_TO_SIGN_IN, "1");
  } catch {
    // Storage refused: the other tabs fall back on their timer (`SIGNED_IN_FALLBACK_MS`).
  }
}

/**
 * A tab that went to sign in has come back with the new cookie: the other tabs of a guest who
 * signed in are waiting for this word (`sign-in-wait.ts`). After `readSignInError`, and before
 * anything reads the session, since those tabs hold the identity lock. A sign-in that failed
 * has no new cookie, and nobody waits for it; rooms still moving (`still_moving`) are no failure.
 */
export function announceSignIn(): void {
  let left = false;
  try {
    left = sessionStorage.getItem(LEFT_TO_SIGN_IN) !== null;
    sessionStorage.removeItem(LEFT_TO_SIGN_IN);
  } catch {
    return;
  }
  const failed = pendingError !== null && pendingError !== "still_moving";
  if (!left || failed || typeof BroadcastChannel !== "function") return;
  const channel = new BroadcastChannel(SIGN_IN_CHANNEL);
  channel.postMessage({ finished: true });
  channel.close();
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
