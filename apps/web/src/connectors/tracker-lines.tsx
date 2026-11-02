import type { RoomView } from "@pp/protocol";
import { lazy, Suspense, useRef } from "react";
import { connectorOn } from "./connector.ts";

const WriteBackLines = lazy(() =>
  import("./write-back.tsx").then((module) => ({ default: module.WriteBackLines })),
);

/**
 * Where a tracker's estimates report, in the PO's room (#54). Nothing loads until a round from a
 * tracker has been on the table, and from then on it stays for this visit: a failed write outlives
 * its round. A snapshot names the tracker to the PO alone, so nobody else gets here.
 */
export function TrackerLines({ room }: { room: RoomView }) {
  const seen = useRef(false);
  if (room.round?.system === "jira" && connectorOn("jira")) seen.current = true;
  if (!seen.current) return null;
  return (
    <Suspense fallback={null}>
      <WriteBackLines code={room.code} round={room.round} />
    </Suspense>
  );
}
