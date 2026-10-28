import type { HistoryRoundView, RoomView } from "@pp/protocol";

/** The rounds the history panel holds, newest first, and where the next page starts. */
export interface HistoryList {
  rounds: HistoryRoundView[];
  /** The `before` of the next page; undefined once the oldest round is loaded. */
  next: number | undefined;
}

export const NO_ROUNDS: HistoryList = { rounds: [], next: undefined };

/** A page as the server answered it. */
export interface HistoryPageView {
  rounds: HistoryRoundView[];
  next?: number | undefined;
}

/**
 * The first page fetched again (a new round started, or the table's round got its final):
 * it replaces the rounds it covers and keeps the older ones already loaded, so a panel
 * scrolled through earlier pages keeps them and its "Show earlier rounds" goes on where
 * it was. When the page does not reach the rounds held (more rounds ended since than a
 * page holds), keeping them would hide the rounds between: the page then replaces them,
 * and "Show earlier rounds" goes on from the page's own end.
 */
export function withFirstPage(current: HistoryList, page: HistoryPageView): HistoryList {
  const { next } = page;
  if (next === undefined) return { rounds: page.rounds, next: undefined };
  // The page's oldest round is `next`. Round numbers are whole, so rounds held from
  // `next − 1` on join it without a gap.
  const top = current.rounds[0]?.number;
  if (top === undefined || top < next - 1) return { rounds: page.rounds, next };
  const older = current.rounds.filter((round) => round.number < next);
  return { rounds: [...page.rounds, ...older], next: older.length > 0 ? current.next : next };
}

/** An earlier page added at the end; a round already shown is not repeated. */
export function withEarlierPage(current: HistoryList, page: HistoryPageView): HistoryList {
  const shown = new Set(current.rounds.map((round) => round.number));
  return {
    rounds: [...current.rounds, ...page.rounds.filter((round) => !shown.has(round.number))],
    next: page.next,
  };
}

/**
 * What makes the panel fetch its first page again while it is open: the table's round
 * number (a new round makes the one before it history) and its final estimate (#32).
 */
export function historyKey(room: Pick<RoomView, "round"> | undefined): string {
  const round = room?.round;
  if (!round) return "lobby";
  return round.phase === "revealed" ? `${round.number}:${round.final ?? ""}` : `${round.number}:`;
}

/** How long the voting took (`revealedAt − startedAt`), in whole minutes and seconds. */
export function votingTime(round: Pick<HistoryRoundView, "startedAt" | "revealedAt">): {
  total: number;
  minutes: number;
  seconds: number;
} {
  const total = Math.max(0, Math.round((round.revealedAt - round.startedAt) / 1000));
  return { total, minutes: Math.floor(total / 60), seconds: total % 60 };
}

/** Whether two instants fall on the same calendar day where the reader is. */
export function sameDay(a: number, b: number): boolean {
  const x = new Date(a);
  const y = new Date(b);
  return (
    x.getFullYear() === y.getFullYear() &&
    x.getMonth() === y.getMonth() &&
    x.getDate() === y.getDate()
  );
}
