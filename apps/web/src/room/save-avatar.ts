import type { AvatarId } from "@pp/domain";
import { setSavedAvatar } from "../identity/identity.ts";
import { useIdentityStore } from "../stores/identity-store.ts";

/**
 * Saves the avatar on the user, so the next room starts with it (#42). As with `saveName`,
 * nothing is sent when it is already the saved one, and a failed save stops nothing: the
 * command carries the avatar anyway, and only the next room misses it.
 */
export async function saveAvatar(avatar: AvatarId | null): Promise<void> {
  if (avatar === useIdentityStore.getState().avatar) return;
  try {
    await setSavedAvatar(avatar);
  } catch {
    // The room shows the avatar all the same.
  }
}
