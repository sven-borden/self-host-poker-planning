import { useCallback, useRef, useState } from "react";
import { type CommandResult, commandSender } from "../realtime/room-connection.ts";
import { useRoomStore } from "../stores/room-store.ts";
import {
  answered,
  type Confirmed,
  confirmedOf,
  type HandState,
  nextStep,
  press,
  SETTLED,
  type VoteCommand,
} from "./hand-state.ts";

type Sender = (command: VoteCommand) => Promise<CommandResult>;

/** What the viewer's own vote did, for their own live region only. */
export type VoteNews = { kind: "voted"; card: string } | { kind: "retracted" };

export interface Vote {
  state: HandState;
  /** The code of the last refusal (`round_revealed`, `offline`, …), until the next press. */
  error: string | null;
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
  const [error, setError] = useState<string | null>(null);
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
    let sentAny = false;
    for (;;) {
      const step = nextStep(current.current, confirmedNow());
      commit(step.state);
      const send = sender.current;
      if (step.command === null || send === null) break;
      sentAny = true;
      let ack: CommandResult;
      try {
        ack = await send(step.command);
      } catch {
        ack = { ok: false, code: "offline" };
      }
      if (!ack.ok) {
        commit(answered(current.current, false));
        setError(ack.code);
        return;
      }
      commit(answered(current.current, true));
    }
    const confirmed = confirmedNow();
    if (sentAny && confirmed.round !== null) {
      said.current += 1;
      setNews({
        id: said.current,
        what:
          confirmed.card === null ? { kind: "retracted" } : { kind: "voted", card: confirmed.card },
      });
    }
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
