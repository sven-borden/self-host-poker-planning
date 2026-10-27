import { setDisplayName } from "../identity/identity.ts";
import { useIdentityStore } from "../stores/identity-store.ts";

/**
 * Saves a cleaned display name on the user, so the next room prefills it, and resolves
 * with the name that `join` or `rename` should carry. Nothing is sent when the name is
 * already the saved one: `/api/me/name` allows 10 calls a minute per user, and a join must
 * not depend on it. A failed save does not stop the command either: it carries the name
 * as typed (cleaned; the server cleans it again), and only the next room's prefill misses
 * it. The room itself shows the name, so the failure is not reported.
 */
export async function saveName(name: string): Promise<string> {
  if (name === useIdentityStore.getState().name) return name;
  try {
    return await setDisplayName(name);
  } catch {
    return name;
  }
}
