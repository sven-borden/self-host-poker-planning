import { MOVE_WAIT_MS } from "@pp/protocol";
import { holdIdentity } from "./identity.ts";
import { SIGN_IN_CHANNEL } from "./sign-in.ts";

// Another tab of a guest who signs in (#48, ADR-025). The server tells it `signedIn` as the move
// starts, and the provider's callback answers only when the rooms have moved, up to
// `MOVE_WAIT_MS` later: all that time the browser holds the guest's cookie, whose session is gone.
// Asking `/get-session` with it would start a new guest and show the join form, and that answer
// clears the cookie it finds, even the new one if it lands after the callback's. So this tab
// holds the identity lock, which keeps every tab's bootstrap waiting, and reloads when the page
// the sign-in came back to says it landed (`announceSignIn`). The wait outlives the room: a tab
// that left it is still the guest's, and is still reloaded.

/**
 * How long a tab waits for that word. Past it the page is gone, or could not say: the tab reloads
 * and takes what the browser holds. Above `MOVE_WAIT_MS`, with room for the answer to arrive.
 */
export const SIGNED_IN_FALLBACK_MS = MOVE_WAIT_MS + 5_000;

/** A word this recent came before the socket's `signedIn`, which can take the longer way. */
export const SIGN_IN_CROSSED_MS = 3_000;

let channel: BroadcastChannel | null = null;
let heardAt = Number.NEGATIVE_INFINITY;
/** Ends the wait of this tab, once it has one. */
let finish: (() => void) | null = null;

/** Starts listening for a sign-in that lands; a room page does, before it can hear `signedIn`. */
export function listenForSignIn(): void {
  if (channel || typeof BroadcastChannel !== "function") return;
  channel = new BroadcastChannel(SIGN_IN_CHANNEL);
  channel.onmessage = () => {
    heardAt = Date.now();
    finish?.();
  };
}

/** The server said `signedIn`: no session is read until the page reloads, once, by `reload`. */
export function reloadOnceSignedIn(reload: () => void): void {
  if (finish) return;
  const release = holdIdentity();
  let done = false;
  finish = () => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    release();
    reload();
  };
  const timer = setTimeout(finish, SIGNED_IN_FALLBACK_MS);
  if (Date.now() - heardAt < SIGN_IN_CROSSED_MS) finish();
}

/** For tests: forgets the wait, and what was heard. */
export function resetSignInWait(): void {
  channel?.close();
  channel = null;
  finish = null;
  heardAt = Number.NEGATIVE_INFINITY;
}
