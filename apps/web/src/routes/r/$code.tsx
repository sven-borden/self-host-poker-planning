import { createFileRoute } from "@tanstack/react-router";
import { useEffect } from "react";
import { RiseIn } from "../../motion/motion.tsx";
import { openRoom } from "../../realtime/room-connection.ts";
import { RoomStatus } from "../../room/room-status.tsx";

export const Route = createFileRoute("/r/$code")({
  component: RoomPage,
});

/** Follows the room over its socket while the page is open (`openRoom`). */
function RoomPage() {
  const { code } = Route.useParams();
  useEffect(() => openRoom(code), [code]);
  return (
    <RiseIn>
      <RoomStatus code={code} />
    </RiseIn>
  );
}
