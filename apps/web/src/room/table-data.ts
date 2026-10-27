import { MAX_MEMBERS, MAX_PARTICIPANTS } from "@pp/domain";
import type { ParticipantView, RoomView } from "@pp/protocol";
import type { TablePerson } from "../table/seat.tsx";
import type { Observer } from "../table/table-stage.tsx";

// From the server's snapshot to the table's props (#16). Pure: the room page renders what
// these return and decides nothing. #17 adds presence, the voted badge, the PO badge and
// the viewer highlight in `toTablePerson` and `toObserver`, which see the whole room.

export interface TableData {
  /** Voters in join order, the viewer first (seated at the bottom) when they vote. */
  people: TablePerson[];
  /** Observers in join order, for the row under the table. */
  observers: Observer[];
}

/** One voter as a seat. Only `present` for now; #17 adds away and voted. */
export function toTablePerson(participant: ParticipantView, _room: RoomView): TablePerson {
  return { id: participant.id, name: participant.name, status: { kind: "present" } };
}

/** One observer in the row under the table. */
export function toObserver(participant: ParticipantView, _room: RoomView): Observer {
  return { id: participant.id, name: participant.name };
}

/**
 * The seats and the observers' row. The snapshot lists people in join order. The viewer
 * sits at the bottom and the others follow clockwise in join order, starting with whoever
 * joined after the viewer, so everyone sees the same order around the table.
 */
export function tableData(room: RoomView): TableData {
  const voters = room.participants.filter((p) => p.role === "voter");
  const mine = voters.findIndex((p) => p.id === room.you);
  const seated = mine > 0 ? [...voters.slice(mine), ...voters.slice(0, mine)] : voters;
  return {
    people: seated.map((p) => toTablePerson(p, room)),
    observers: room.participants
      .filter((p) => p.role === "observer")
      .map((p) => toObserver(p, room)),
  };
}

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
