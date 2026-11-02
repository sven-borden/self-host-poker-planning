import type { RoundView, Snapshot } from "@pp/protocol";
import { useRoomStore } from "../stores/room-store.ts";

// Which final this very tab recorded (#54, ADR-030). An estimate goes to a tracker with the PO's own
// token, so one goes by itself only for a press made here: a final found in a snapshot, from a
// re-entry, from another tab or device, from anyone else or after a hand-over, waits for a press.
//
// The tab marks the press before the command leaves, since the answer follows the frame, and only
// the live frame that says this card was just set confirms it, for the room, round and item it
// was pressed on: `takeFinalPress` compares those. A snapshot from an `enter` has no causes, so a
// tab waking up confirms nothing. The room's own chunk holds this: the frame may arrive before the
// lines' chunk does.

type FinalRound = Pick<RoundView, "number" | "startedAt" | "subject">;

interface Press {
  id: string;
  card: string;
  /** From the answer: a later frame is someone else's, and a press never lands twice. */
  version?: number;
  stop: () => void;
}

let press: Press | null = null;
/** A press its frame confirmed, until the lines take it. */
let confirmed: string | null = null;

const finalId = (code: string, round: FinalRound, card: string) =>
  JSON.stringify([code, round.number, round.startedAt, round.subject, card]);

function drop() {
  press?.stop();
  press = null;
}

/** What a press's answer says of it. */
export type FinalAnswer = { ok: true; version: number } | { ok: false };

function hear(snapshot: Snapshot) {
  if (press === null) return;
  const { id, card, version } = press;
  if (version !== undefined && snapshot.version > version) {
    drop();
    return;
  }
  if (!snapshot.causes.some((cause) => cause.type === "finalSet" && cause.card === card)) return;
  confirmed = id;
  drop();
}

/**
 * The PO pressed "Record". Call it before the command leaves, and call what it returns with the
 * answer: a press refused confirms nothing, and neither does a frame past the answer's version.
 */
export function markFinalPress(
  code: string,
  round: FinalRound,
  card: string,
): (answer: FinalAnswer) => void {
  drop();
  confirmed = null;
  const mine: Press = {
    id: finalId(code, round, card),
    card,
    stop: useRoomStore.subscribe((state, before) => {
      if (state.snapshot !== null && state.snapshot !== before.snapshot) hear(state.snapshot);
    }),
  };
  press = mine;
  return (answer) => {
    if (press !== mine) return;
    if (answer.ok) mine.version = answer.version;
    else drop();
  };
}

/** True once, for the final this tab pressed and its live frame confirmed. */
export function takeFinalPress(code: string, round: FinalRound, card: string): boolean {
  if (confirmed !== finalId(code, round, card)) return false;
  confirmed = null;
  return true;
}

/** Nothing pressed: for a test's start. */
export function forgetFinalPress() {
  drop();
  confirmed = null;
}
