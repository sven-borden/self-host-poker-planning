import { deckCards, MIN_ANONYMOUS_REVEAL_CARDS } from "@pp/domain";
import type { ParticipantView, RoomView } from "@pp/protocol";
import { type AvatarLook, avatarLooks } from "../table/avatar.tsx";
import type { PersonFlags, SeatStatus, TablePerson } from "../table/seat.tsx";
import type { Observer } from "../table/table-stage.tsx";
import { namesakes } from "./namesakes.ts";
import { extremeOf } from "./results-view.ts";

export { namesakes };

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
 * public, so their seat says "no vote" as in a named reveal. A PO who does not vote
 * (`poVotes` off) is never thinking and never missing a vote: their seat stays present.
 * The table turns a `voted` card face up when it becomes `revealed` (#19), and lets it go
 * from the seat when it becomes `dealt`. A named reveal whose cards differ marks the seats
 * with the lowest and the highest card (`extreme`, #20); an anonymous one never does. A
 * card changed after a named reveal is marked `changed` (#29).
 */
export function seatStatus(participant: ParticipantView, room: RoomView): SeatStatus {
  const round = room.round;
  if (round === null) return { kind: "present" };
  const voted = round.voted.includes(participant.id);
  const counts = canVote(participant, room);
  const missing: SeatStatus = counts ? { kind: "revealed", card: null } : { kind: "present" };
  if (round.phase === "voting") {
    return voted ? { kind: "voted" } : counts ? { kind: "thinking" } : { kind: "present" };
  }
  if (round.anonymous) return voted ? { kind: "voted", dealt: true } : missing;
  const vote = round.votes.find((v) => v.who === participant.id);
  if (!vote) return missing;
  const extreme = extremeOf(round, vote.card);
  return {
    kind: "revealed",
    card: vote.card,
    ...(extreme ? { extreme } : {}),
    ...(vote.changedAfterReveal ? { changed: true } : {}),
  };
}

/**
 * Away, product owner, the viewer, the look the table gave them, and, when someone who
 * joined earlier has the same name, which one of that name they are (#22).
 */
export function personFlags(
  participant: ParticipantView,
  room: RoomView,
  looks?: Map<string, AvatarLook>,
  numbers?: Map<string, number>,
): PersonFlags {
  return {
    away: participant.away,
    owner: participant.isOwner,
    you: participant.id === room.you,
    look: looks?.get(participant.id),
    namesake: numbers?.get(participant.id),
  };
}

/** One voter as a seat. */
export function toTablePerson(
  participant: ParticipantView,
  room: RoomView,
  looks?: Map<string, AvatarLook>,
  numbers?: Map<string, number>,
): TablePerson {
  return {
    id: participant.id,
    name: participant.name,
    status: seatStatus(participant, room),
    ...personFlags(participant, room, looks, numbers),
  };
}

/** One observer in the row under the table. */
export function toObserver(
  participant: ParticipantView,
  room: RoomView,
  looks?: Map<string, AvatarLook>,
  numbers?: Map<string, number>,
): Observer {
  return {
    id: participant.id,
    name: participant.name,
    ...personFlags(participant, room, looks, numbers),
  };
}

/**
 * The seats and the observers' row. The snapshot lists people in join order. The viewer
 * sits at the bottom and the others follow clockwise in join order, starting with whoever
 * joined after the viewer, so everyone sees the same order around the table. Looks are
 * given in join order too, so everyone sees the same initials and colours.
 */
export function tableData(room: RoomView): TableData {
  const looks = avatarLooks(room.participants);
  const numbers = namesakes(room.participants);
  const voters = room.participants.filter((p) => p.role === "voter");
  const mine = voters.findIndex((p) => p.id === room.you);
  const seated = mine > 0 ? [...voters.slice(mine), ...voters.slice(0, mine)] : voters;
  return {
    people: seated.map((p) => toTablePerson(p, room, looks, numbers)),
    observers: room.participants
      .filter((p) => p.role === "observer")
      .map((p) => toObserver(p, room, looks, numbers)),
    looks,
  };
}

/** The people who may vote in this room: voters, less the PO when the PO does not vote. */
function canVote(participant: ParticipantView, room: RoomView): boolean {
  return participant.role === "voter" && (participant.id !== room.ownerId || room.settings.poVotes);
}

/**
 * Whether the viewer may reveal by hand, as the domain decides it (#28): the PO always;
 * under "anyone who votes", every voter too; an observer never.
 */
export function mayReveal(room: RoomView): boolean {
  if (room.you === null) return false;
  if (room.you === room.ownerId) return true;
  const you = room.participants.find((p) => p.id === room.you);
  return room.settings.whoCanReveal === "anyone" && you !== undefined && canVote(you, room);
}

/**
 * Whether the viewer's reveal waits for a second card (#28): anyone but the PO, in an
 * anonymous round with fewer than two cards down, since a lone card would show whose it
 * is. The domain refuses such a reveal (`too_few_cards`); the PO's goes through.
 */
export function revealWaits(room: RoomView): boolean {
  const round = room.round;
  return (
    room.you !== room.ownerId &&
    round?.phase === "voting" &&
    round.anonymous &&
    round.voted.length < MIN_ANONYMOUS_REVEAL_CARDS
  );
}

/**
 * The centre's "5/8 voted so far": who voted out of who can vote. Someone away counts
 * only when their vote is in (the domain's automatic reveal waits for present voters only).
 */
export function voteCount(room: RoomView): { count: number; total: number } {
  const voted = new Set(room.round?.voted ?? []);
  const counted = room.participants.filter((p) => canVote(p, room) && (!p.away || voted.has(p.id)));
  return { count: counted.filter((p) => voted.has(p.id)).length, total: counted.length };
}

/**
 * The viewer's hand, where the domain would accept or refuse their vote:
 * - `none`: an observer has no hand;
 * - `owner`: the PO in a room where the PO does not vote (`poVotes` off) has none either,
 *   and the page says why;
 * - `cards`: the round's deck and enabled specials (the room's own in the lobby), playable
 *   while Voting, and after a named reveal while the room lets votes change (`change`,
 *   #29). In the lobby, after an anonymous reveal, and after a reveal while changes are
 *   not allowed, the cards stay on screen, disabled, with the reason (`lobby`,
 *   `revealed`). The round's own `anonymous` flag decides, as in the domain.
 */
export type HandView =
  | { kind: "none" }
  | { kind: "owner" }
  | {
      kind: "cards";
      cards: string[];
      playable: boolean;
      reason: "voting" | "lobby" | "revealed" | "change";
    };

export function handView(room: RoomView, me: ParticipantView): HandView {
  if (me.role !== "voter") return { kind: "none" };
  if (!canVote(me, room)) return { kind: "owner" };
  const round = room.round;
  if (round === null) {
    const cards = deckCards(room.settings.deck, room.settings.specials);
    return { kind: "cards", cards, playable: false, reason: "lobby" };
  }
  const cards = deckCards(round.deck, round.specials);
  if (round.phase === "voting") return { kind: "cards", cards, playable: true, reason: "voting" };
  return mayChange(room)
    ? { kind: "cards", cards, playable: true, reason: "change" }
    : { kind: "cards", cards, playable: false, reason: "revealed" };
}

/**
 * Whether a vote may still change in the revealed round on the table (#29), as the domain
 * decides it: the room allows it and the round is named. An anonymous round locks its
 * votes at the reveal whatever the setting says now (ADR-011).
 */
export function mayChange(room: RoomView): boolean {
  const round = room.round;
  return round?.phase === "revealed" && !round.anonymous && room.settings.allowChangeAfterReveal;
}
