import { MAX_MEMBERS, MAX_PARTICIPANTS } from "@pp/domain";
import type { RoomView } from "@pp/protocol";

// In the room route's own chunk (room-view.tsx needs it before anyone is seated), apart
// from table-data.ts, which brings the table's code and stays in the lazy seated chunk.

/**
 * Whether nobody can join any more, as the snapshot shows it: 16 people who count
 * (observers count unless the room says otherwise), or the hard cap of members. When
 * observers do not count, an observer can still join a room whose 16 seats are taken.
 * The server stays the judge (`room_full`); this only spares a form that cannot succeed.
 */
export function isRoomFull(room: RoomView): boolean {
  const members = room.participants.length;
  if (members >= MAX_MEMBERS) return true;
  return room.settings.observersCount && members >= MAX_PARTICIPANTS;
}
