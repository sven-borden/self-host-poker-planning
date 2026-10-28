import type { HistoryRoundView, RoomView } from "@pp/protocol";
import type { TFunction } from "../i18n/i18n.ts";
import { durationWords } from "./timer-view.ts";

/** A caption: 11 px at the default text size, in rem so that it grows with the reader's text size. */
export const CAPTION = "m-0 font-mono text-[0.6875rem] tracking-[0.08em] text-ink-2 uppercase";

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

/** A length in whole seconds, split into hours, the minutes past the hour and the seconds past the minute. */
export interface SplitSeconds {
  total: number;
  hours: number;
  minutes: number;
  seconds: number;
}

/** `seconds` rounded to whole seconds (at least 0), split into hours, minutes and seconds. */
export function splitSeconds(seconds: number): SplitSeconds {
  const total = Math.max(0, Math.round(seconds));
  return {
    total,
    hours: Math.floor(total / 3600),
    minutes: Math.floor((total % 3600) / 60),
    seconds: total % 60,
  };
}

/**
 * How long the voting took (`revealedAt − startedAt`) in whole seconds, split into hours,
 * the minutes past the hour and the seconds past the minute.
 */
export function votingTime(
  round: Pick<HistoryRoundView, "startedAt" | "revealedAt">,
): SplitSeconds {
  return splitSeconds((round.revealedAt - round.startedAt) / 1000);
}

/** A length as the history shows it: "42 s", "2 min 13 s", or from an hour on "1 h 2 min". */
export function shortDuration(t: TFunction, { hours, minutes, seconds }: SplitSeconds): string {
  if (hours > 0) return t("history.tookHours", { hours, minutes });
  if (minutes > 0) return t("history.took", { minutes, seconds });
  return t("history.tookSeconds", { seconds });
}

/**
 * A length said in words: "2 minutes 13 seconds", and from an hour on the hours and
 * minutes ("1 hour 2 minutes").
 */
export function durationSpoken(t: TFunction, time: SplitSeconds): string {
  const { total, hours, minutes } = time;
  if (hours === 0) return durationWords(t, total);
  const inHours = t("history.hours", { count: hours });
  if (minutes === 0) return inHours;
  return t("history.hoursMinutes", {
    hours: inHours,
    minutes: t("timer.minutes", { count: minutes }),
  });
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
