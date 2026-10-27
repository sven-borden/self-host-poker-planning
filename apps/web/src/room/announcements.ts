import type { CauseView, RoomView } from "@pp/protocol";
import type { TFunction } from "../i18n/i18n.ts";

// What the table's live region says (#17): joins, leaves, away and back, votes, a new
// round (#18) and the reveal (#19), read from a snapshot's causes. Never a card: a vote
// cause carries who, never what, and the reveal is said without its cards (#20 says the
// results). Pure, so the batching rules are tested without timers; `live-announcer.tsx`
// runs them.

export type LiveKind = "roundStarted" | "joined" | "left" | "away" | "back" | "voted" | "revealed";

export interface LiveEvent {
  kind: LiveKind;
  /** The person, or "" for the room's own events (a new round). */
  who: string;
  /** The name as the room showed it when the event happened. */
  name: string;
}

/** Said in this order, whatever order the events came in: the last vote, then the reveal. */
const ORDER: readonly LiveKind[] = [
  "roundStarted",
  "joined",
  "left",
  "away",
  "back",
  "voted",
  "revealed",
];

/** Events that undo each other inside one batch: nothing is said for either. */
const UNDOES: Partial<Record<LiveKind, LiveKind>> = {
  joined: "left",
  left: "joined",
  away: "back",
  back: "away",
};

function nameOf(id: string, ...rooms: (RoomView | null)[]): string | null {
  for (const room of rooms) {
    const person = room?.participants.find((p) => p.id === id);
    if (person) return person.name;
  }
  return null;
}

/**
 * The events in `causes`, the causes of the change from `previous` to `next`. The viewer's
 * own actions are left out: they see them happen, and their own controls speak for them.
 * A vote counts only when the person had not voted yet in this round: changing a card is
 * not news, and saying so would hint that something changed. A person who left is named
 * from `previous`. A new round and the reveal (forced, automatic or at the deadline) are
 * said to everyone, the PO who caused them too: the hand and the centre change under
 * their focus.
 */
export function liveEvents(
  next: RoomView,
  causes: readonly CauseView[],
  previous: RoomView | null,
): LiveEvent[] {
  const before =
    previous?.round && next.round && previous.round.number === next.round.number
      ? new Set(previous.round.voted)
      : new Set<string>();
  const events: LiveEvent[] = [];
  for (const cause of causes) {
    let kind: LiveKind;
    switch (cause.type) {
      case "roundStarted":
      case "revealed":
        events.push({ kind: cause.type, who: "", name: "" });
        continue;
      case "joined":
      case "left":
      case "away":
      case "back":
        kind = cause.type;
        break;
      case "kicked":
        kind = "left";
        break;
      case "voteCast":
        if (cause.who === undefined || before.has(cause.who)) continue;
        kind = "voted";
        break;
      default:
        continue;
    }
    const who = cause.who;
    if (who === undefined || who === next.you) continue;
    const name = nameOf(who, next, previous);
    if (name !== null) events.push({ kind, who, name });
  }
  return events;
}

/**
 * Adds `events` to a batch waiting to be said: a repeat is dropped, and an event that
 * undoes one in the batch (a person away and back again) removes both. A new round makes
 * a reveal still waiting in the batch moot (a timer's reveal resolved by the next round's
 * start): the revealed cards are already gone.
 */
export function mergeEvents(pending: readonly LiveEvent[], events: readonly LiveEvent[]) {
  let merged = [...pending];
  for (const event of events) {
    if (event.kind === "roundStarted") merged = merged.filter((e) => e.kind !== "revealed");
    const undone = UNDOES[event.kind];
    const opposite = merged.findIndex((e) => e.who === event.who && e.kind === undone);
    if (opposite >= 0) {
      merged = merged.filter((_, i) => i !== opposite);
      continue;
    }
    if (merged.some((e) => e.who === event.who && e.kind === event.kind)) continue;
    merged.push(event);
  }
  return merged;
}

function sentence(t: TFunction, kind: LiveKind, events: readonly LiveEvent[]): string {
  const first = events[0];
  const one = events.length === 1 && first !== undefined;
  const name = first?.name ?? "";
  const count = events.length;
  switch (kind) {
    case "roundStarted":
      return t("live.roundStarted");
    case "joined":
      return one ? t("live.joined", { name }) : t("live.joinedMany", { count });
    case "left":
      return one ? t("live.left", { name }) : t("live.leftMany", { count });
    case "away":
      return one ? t("live.away", { name }) : t("live.awayMany", { count });
    case "back":
      return one ? t("live.back", { name }) : t("live.backMany", { count });
    case "voted":
      return one ? t("live.voted", { name }) : t("live.votedMany", { count });
    case "revealed":
      return t("live.revealed");
  }
}

/**
 * One announcement for a batch: a sentence per kind, naming the person when there is one
 * ("Ana voted."), counting them when there are several ("3 people voted.").
 */
export function describeEvents(t: TFunction, events: readonly LiveEvent[]): string {
  return ORDER.flatMap((kind) => {
    const ofKind = events.filter((e) => e.kind === kind);
    return ofKind.length > 0 ? [sentence(t, kind, ofKind)] : [];
  }).join(" ");
}
