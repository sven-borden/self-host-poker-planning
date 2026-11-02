import { type ComponentType, lazy, Suspense } from "react";
import { useRoomStore } from "../stores/room-store.ts";

/**
 * The control, the effects and the synth: a chunk of their own, so a room that stays silent
 * loads none of it before it needs to, and the room route's budget carries one line. The
 * music's compositions are a further chunk behind it, for someone who turned it on. A
 * failed load (an old chunk after a redeploy) costs the button, never the page.
 */
const SoundControl = lazy<ComponentType>(() =>
  import("./sound-control.tsx").catch(() => ({ default: () => null })),
);

/**
 * The sound (#44, #45) in the top bar, with the page's other preferences of this device, the
 * language and the theme, for someone at the table or watching, never someone still on the
 * join form: nothing sounds there. The room's header has no room for a fourth button on a
 * phone. The box keeps the button's place while its chunk loads, so the bar does not jump.
 */
export function RoomSoundButton() {
  const inRoom = useRoomStore(
    (state) => state.status !== "error" && (state.snapshot?.room.you ?? null) !== null,
  );
  if (!inRoom) return null;
  return (
    <Suspense fallback={<span aria-hidden="true" className="size-11 shrink-0" />}>
      <SoundControl />
    </Suspense>
  );
}
