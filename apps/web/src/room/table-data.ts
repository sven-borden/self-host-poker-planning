import type { ParticipantView, RoomView } from "@pp/protocol";
import { type AvatarLook, avatarLooks } from "../table/avatar.tsx";
import type { PersonFlags, SeatStatus, TablePerson } from "../table/seat.tsx";
import type { Observer } from "../table/table-stage.tsx";

// From the server's snapshot to the table's props (#16, #17). Pure: the room page renders
// what these return and decides nothing. Before reveal the snapshot says only who voted
// (`round.voted`), never what: that is all a seat can show.

export interface TableData {
  /** Voters in join order, the viewer first (seated at the bottom) when they vote. */
  people: TablePerson[];
  /** Observers in join order, for the row under the table. */
  observers: Observer[];
  /** Initials and colours, unique among everyone in the room (`avatarLooks`). */
  looks: Map<string, AvatarLook>;
}

/**
 * Where a voter stands in the round: present in the lobby; thinking or voted while
 * Voting; after a named reveal, their card (or none). After an anonymous reveal no card
 * belongs to anyone, so a seat shows only that its person voted; who did not vote is
 * public, so their seat says "no vote" as in a named reveal. #19 builds the flip on the
 * `revealed` status.
 */
export function seatStatus(participant: ParticipantView, room: RoomView): SeatStatus {
  const round = room.round;
  if (round === null) return { kind: "present" };
  const voted = round.voted.includes(participant.id);
  if (round.phase === "voting") return { kind: voted ? "voted" : "thinking" };
  if (round.anonymous) return voted ? { kind: "voted" } : { kind: "revealed", card: null };
  const vote = round.votes.find((v) => v.who === participant.id);
  return { kind: "revealed", card: vote?.card ?? null };
}

/** Away, product owner, the viewer, and the look the table gave them. */
export function personFlags(
  participant: ParticipantView,
  room: RoomView,
  looks?: Map<string, AvatarLook>,
): PersonFlags {
  return {
    away: participant.away,
    owner: participant.isOwner,
    you: participant.id === room.you,
    look: looks?.get(participant.id),
  };
}

/** One voter as a seat. */
export function toTablePerson(
  participant: ParticipantView,
  room: RoomView,
  looks?: Map<string, AvatarLook>,
): TablePerson {
  return {
    id: participant.id,
    name: participant.name,
    status: seatStatus(participant, room),
    ...personFlags(participant, room, looks),
  };
}

/** One observer in the row under the table. */
export function toObserver(
  participant: ParticipantView,
  room: RoomView,
  looks?: Map<string, AvatarLook>,
): Observer {
  return { id: participant.id, name: participant.name, ...personFlags(participant, room, looks) };
}

/**
 * The seats and the observers' row. The snapshot lists people in join order. The viewer
 * sits at the bottom and the others follow clockwise in join order, starting with whoever
 * joined after the viewer, so everyone sees the same order around the table. Looks are
 * given in join order too, so everyone sees the same initials and colours.
 */
export function tableData(room: RoomView): TableData {
  const looks = avatarLooks(room.participants);
  const voters = room.participants.filter((p) => p.role === "voter");
  const mine = voters.findIndex((p) => p.id === room.you);
  const seated = mine > 0 ? [...voters.slice(mine), ...voters.slice(0, mine)] : voters;
  return {
    people: seated.map((p) => toTablePerson(p, room, looks)),
    observers: room.participants
      .filter((p) => p.role === "observer")
      .map((p) => toObserver(p, room, looks)),
    looks,
  };
}
