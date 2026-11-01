import type { AvatarId } from "@pp/domain";
import { useEffect, useSyncExternalStore } from "react";
import type { AVATAR_ART, Drawing } from "./art.ts";

// The drawings are a lazy chunk (#42): a room where nobody picked one never loads them,
// and they stay off the room route's budget. Until they arrive an avatar shows its
// initials, and it goes on showing them if they cannot load: nobody's seat waits for a
// picture, and an old chunk gone after a redeploy costs nothing but the drawing.

let art: typeof AVATAR_ART | null = null;
let loading: Promise<void> | null = null;
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Starts the load, once. A failed one is forgotten, so the next avatar tries again. */
export function loadAvatarArt(): Promise<void> {
  loading ??= import("./art.ts")
    .then((module) => {
      art = module.AVATAR_ART;
      for (const listener of listeners) listener();
    })
    .catch(() => {
      loading = null;
    });
  return loading;
}

/** The drawing of `avatar`, once loaded; null without one, or for an id this page lacks. */
export function useAvatarDrawing(avatar: string | undefined): Drawing | null {
  const drawings = useSyncExternalStore(subscribe, () => art);
  useEffect(() => {
    if (avatar !== undefined) void loadAvatarArt();
  }, [avatar]);
  if (avatar === undefined || drawings === null || !Object.hasOwn(drawings, avatar)) return null;
  return drawings[avatar as AvatarId];
}

/** For tests: forgets the load. */
export function resetAvatarArt(): void {
  art = null;
  loading = null;
}
