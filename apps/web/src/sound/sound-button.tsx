import { lazy, Suspense } from "react";
import { useRoomStore } from "../stores/room-store.ts";

/**
 * The control, the effects and the synth: a chunk of their own, so a room that stays silent
 * loads none of it before it needs to, and the room route's budget carries one line. A
 * failed load (an old chunk after a redeploy) costs the button, never the page.
 */
const SoundControl = lazy(() =>
  import("./sound-control.tsx").catch(() => ({ default: () => null })),
);

/**
 * The room header's sound (#44), beside "History", for someone at the table or watching,
 * never someone still on the join form: nothing sounds there. The box keeps the button's
 * place while its chunk loads, so the header does not jump.
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
