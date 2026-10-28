import type { RoomView } from "@pp/protocol";

// The hand's state machine (#18): optimistic, confirmed by the server, rolled back on a
// refusal. Pure, so the unit tests drive it step by step; `use-vote.ts` runs it.
//
// The server holds the vote; the snapshot's `yourVote` is the confirmed card. A press
// records a wish (the card the viewer wants, or null to take the vote back) and the hand
// shows it at once. One command is on the wire at a time: when its ack comes back, the
// store already holds the snapshot it produced (the server broadcasts before it acks), so
// the next step compares the latest wish with the confirmed card and sends again only if
// they differ. Fast presses therefore collapse into one command per difference, and the
// hand always ends on the server's card. A refusal drops every wish.

/**
 * The round and phase a wish belongs to: the round's number and start, and whether it is
 * revealed (a change after the reveal, #29), or null in the lobby. A wish made while
 * Voting never carries over the reveal.
 */
export type RoundKey = string | null;

/** Whether a wish was made after the reveal: a change of card (#29). */
export const afterReveal = (round: string): boolean => round.endsWith(":revealed");

/** What the server holds for the viewer: their card (null for none) in the current round. */
export interface Confirmed {
  card: string | null;
  round: RoundKey;
  /** The round's number, or null in the lobby. */
  number: number | null;
  /** How many times a deck change restarted it (#26), or null in the lobby. */
  restart: number | null;
  /** The round is revealed: a press changes the vote, never takes it back (#29). */
  revealed: boolean;
}

export interface Wish {
  /** The card the viewer asked for, or null to take the vote back. */
  card: string | null;
  round: string;
  /**
   * The round's number, sent with the command: the server refuses it (`round_changed`)
   * if the PO started the next round while it was on the wire.
   */
  number: number;
  /** The round's restarts, sent too: a deck change keeps the number (#26). */
  restart: number;
}

export interface HandState {
  /** The latest press the server has not confirmed yet; null when the hand is settled. */
  wish: Wish | null;
  /** A command is on the wire. */
  sending: boolean;
  /** The wish the last command carried: a second identical send would loop. */
  sent: Wish | null;
}

export type VoteCommand =
  | { type: "castVote"; payload: { card: string; round: number; restart: number } }
  | { type: "retractVote"; payload: { round: number; restart: number } };

export const SETTLED: HandState = { wish: null, sending: false, sent: null };

/** A round's identity: a restart (new deck) keeps the number, not the start. */
export function roundKey(room: RoomView): RoundKey {
  const round = room.round;
  if (round === null) return null;
  const key = `${round.number}:${round.startedAt}`;
  return round.phase === "voting" ? key : `${key}:revealed`;
}

/**
 * The viewer's confirmed card in the current round, from the snapshot. Whether the
 * server would take a press after the reveal is the hand's business (`handView`): a
 * disabled hand presses nothing.
 */
export function confirmedOf(room: RoomView | undefined): Confirmed {
  const round = room ? roundKey(room) : null;
  if (round === null) {
    return { card: null, round: null, number: null, restart: null, revealed: false };
  }
  return {
    card: room?.round?.yourVote ?? null,
    round,
    number: room?.round?.number ?? null,
    restart: room?.round?.restarts ?? 0,
    revealed: room?.round?.phase === "revealed",
  };
}

/** The card the hand shows as the viewer's vote: the wish for this round, else the server's. */
export function shownCard(state: HandState, confirmed: Confirmed): string | null {
  return state.wish !== null && state.wish.round === confirmed.round
    ? state.wish.card
    : confirmed.card;
}

/**
 * A press on `card`: a vote for it, or, when it is the card shown, taking the vote back.
 * After the reveal (#29) a press only changes the vote: the card shown pressed again does
 * nothing, since a vote taken back would leave the results (the server refuses it with
 * `not_voting`). In the lobby nothing changes (the hand is disabled there anyway).
 */
export function press(state: HandState, card: string, confirmed: Confirmed): HandState {
  const { round, number, restart } = confirmed;
  if (round === null || number === null || restart === null) return state;
  const same = shownCard(state, confirmed) === card;
  if (same && confirmed.revealed) return state;
  return { ...state, wish: { card: same ? null : card, round, number, restart } };
}

const sameWish = (a: Wish | null, b: Wish | null) =>
  a !== null && b !== null && a.card === b.card && a.round === b.round;

/**
 * The next step: the command to send now, or none. Nothing goes out while a command is on
 * the wire. A wish for another round, or one the server already holds, is dropped. A wish
 * the last command already carried is dropped too: its ack said yes, yet the snapshot
 * disagrees, so the server's card wins rather than sending the same command forever.
 */
export function nextStep(
  state: HandState,
  confirmed: Confirmed,
): { state: HandState; command: VoteCommand | null } {
  if (state.sending || state.wish === null) return { state, command: null };
  const { wish } = state;
  if (
    wish.round !== confirmed.round ||
    wish.card === confirmed.card ||
    sameWish(wish, state.sent)
  ) {
    return { state: SETTLED, command: null };
  }
  const command: VoteCommand =
    wish.card === null
      ? { type: "retractVote", payload: { round: wish.number, restart: wish.restart } }
      : {
          type: "castVote",
          payload: { card: wish.card, round: wish.number, restart: wish.restart },
        };
  return { state: { ...state, sending: true, sent: wish }, command };
}

/**
 * The ack of the command on the wire. Accepted: the wish stays until `nextStep` compares
 * it with the new snapshot. Refused (after the reveal, offline, a `busy` that gave up):
 * every wish is dropped, so the hand shows the server's card again.
 */
export function answered(state: HandState, ok: boolean): HandState {
  return ok ? { ...state, sending: false } : SETTLED;
}

/**
 * The room as the viewer sees it with their unconfirmed pick: during Voting, `voted` and
 * `yourVote` follow the card shown, so their seat, the count in the centre and the hand
 * agree at once. Everyone else still learns the vote from the server only.
 */
export function withShownVote(room: RoomView, card: string | null): RoomView {
  const round = room.round;
  const me = room.you;
  if (round?.phase !== "voting" || me === null || (round.yourVote ?? null) === card) return room;
  const others = round.voted.filter((id) => id !== me);
  const { yourVote: _, ...rest } = round;
  return {
    ...room,
    round: {
      ...rest,
      voted: card === null ? others : [...others, me],
      ...(card === null ? {} : { yourVote: card }),
    },
  };
}
