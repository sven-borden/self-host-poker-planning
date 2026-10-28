import { useCallback, useRef, useState } from "react";
import { type CommandResult, commandSender } from "../realtime/room-connection.ts";
import { useRoomStore } from "../stores/room-store.ts";
import {
  afterReveal,
  answered,
  type Confirmed,
  confirmedOf,
  type HandState,
  nextStep,
  press,
  SETTLED,
  type VoteCommand,
  type Wish,
} from "./hand-state.ts";
import { voteTick } from "./haptics.ts";

type Sender = (command: VoteCommand) => Promise<CommandResult>;

/**
 * What the viewer's own vote did, for their own live region only: a vote, a vote taken
 * back, or a card changed after the reveal (#29).
 */
export type VoteNews =
  | { kind: "voted"; card: string }
  | { kind: "changed"; card: string }
  | { kind: "retracted" };

export interface Vote {
  state: HandState;
  /**
   * The last refusal (`round_revealed`, `offline`, …) and the number of the round it
   * happened in, until the next press; the page shows it only while that round lasts.
   */
  error: { code: string; round: number | null } | null;
  /** Said once the server confirmed the last press; a new object each time. */
  news: { id: number; what: VoteNews } | null;
  /** A press on a card of the hand. Returns the hand's new wish (null: take back). */
  pick: (card: string) => string | null | undefined;
}

/** The server's view of the viewer's vote, read when needed rather than from a render. */
const confirmedNow = (): Confirmed => confirmedOf(useRoomStore.getState().snapshot?.room);

/**
 * Runs the hand's state machine (`hand-state.ts`) against the server: each press updates
 * the wish at once, and one command at a time goes out through the `commandSender()`
 * taken at the press, so a vote never lands in a room the page has left.
 */
export function useVote(): Vote {
  const [state, setState] = useState<HandState>(SETTLED);
  const [error, setError] = useState<Vote["error"]>(null);
  const [news, setNews] = useState<Vote["news"]>(null);
  // The machine's state for the async loop, which must not wait for a render.
  const current = useRef<HandState>(SETTLED);
  const sender = useRef<Sender | null>(null);
  const said = useRef(0);

  const commit = useCallback((next: HandState) => {
    current.current = next;
    setState(next);
  }, []);

  const pump = useCallback(async () => {
    // The wish of the last command the server accepted.
    let acked: Wish | null = null;
    for (;;) {
      const step = nextStep(current.current, confirmedNow());
      commit(step.state);
      const send = sender.current;
      if (step.command === null || send === null) break;
      let ack: CommandResult;
      try {
        ack = await send(step.command);
      } catch {
        ack = { ok: false, code: "offline" };
      }
      if (!ack.ok) {
        commit(answered(current.current, false));
        // Made for the round the PO just ended: the new round's hand is empty anyway, so
        // the pick rolls back without a word.
        if (ack.code === "round_changed") return;
        const round = useRoomStore.getState().snapshot?.room.round?.number ?? null;
        setError({ code: ack.code, round });
        return;
      }
      acked = step.state.sent;
      commit(answered(current.current, true));
    }
    // Said once the server holds the last accepted pick, in any phase: a vote that was the
    // last one is revealed at once, and the voter still hears it went in.
    const round = useRoomStore.getState().snapshot?.room.round;
    if (acked === null || round?.number !== acked.number) return;
    if ((round.yourVote ?? null) !== acked.card) return;
    said.current += 1;
    if (acked.card !== null) voteTick();
    setNews({
      id: said.current,
      what:
        acked.card === null
          ? { kind: "retracted" }
          : { kind: afterReveal(acked.round) ? "changed" : "voted", card: acked.card },
    });
  }, [commit]);

  const pick = useCallback(
    (card: string) => {
      const confirmed = confirmedNow();
      const next = press(current.current, card, confirmed);
      if (next === current.current) return undefined;
      sender.current = commandSender() as Sender;
      setError(null);
      commit(next);
      // A command already on the wire picks the new wish up when its ack comes back.
      if (!next.sending) void pump();
      return next.wish?.card ?? null;
    },
    [commit, pump],
  );

  return { state, error, news, pick };
}
