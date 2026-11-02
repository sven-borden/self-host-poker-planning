import type { ConnectorName, RoomView } from "@pp/protocol";
import { useRef } from "react";
import { connectorOn, ROUND_SYSTEMS } from "./connector.ts";
import { useConnectorChunk } from "./use-connector-chunk.ts";

const loadLines = () => import("./write-back.tsx");

/**
 * Where a tracker's estimates report, in the PO's room (#54). Nothing loads until a round from a
 * tracker has been on the table, and from then on it stays for this visit: a failed write outlives
 * its round. A snapshot names the tracker to the PO alone, so nobody else gets here. Should its
 * chunk fail to load, the room goes on without the lines: the toast says so.
 */
function Lines({ room, name }: { room: RoomView; name: ConnectorName }) {
  const seen = useRef(false);
  if (room.round?.system === ROUND_SYSTEMS[name] && connectorOn(name)) seen.current = true;
  const chunk = useConnectorChunk(seen.current, loadLines, name);
  if (chunk === null) return null;
  return <chunk.WriteBackLines code={room.code} round={room.round} name={name} />;
}

/** One set of lines per tracker: a queue can hold items of both. */
export function TrackerLines({ room }: { room: RoomView }) {
  return (
    <>
      <Lines room={room} name="jira" />
      <Lines room={room} name="azure-devops" />
    </>
  );
}
