import { MAX_TIMER_SECONDS, MIN_TIMER_SECONDS } from "@pp/domain";
import type { RoundView } from "@pp/protocol";
import type { TFunction } from "../i18n/i18n.ts";

// The vote timer as the page shows it (#27): pure, so the clock, the ring and the words
// are tested without timers. `timer.tsx` draws it; the server alone decides the reveal.

/** The PO's presets, in seconds: in the room settings and in the centre's menu. */
export const TIMER_PRESETS = [30, 60, 120] as const;
/** What "+30 s" adds, in seconds. */
export const EXTEND_SECONDS = 30;
/** The last stretch, in milliseconds: the ring turns `--warn` and pulses at 1 Hz. */
export const WARN_MS = 10_000;

/** The round's timer: none, running towards a deadline, or time up (the PO reveals). */
export type TimerState =
  | { kind: "none" }
  | { kind: "running"; deadlineAt: number; startedAt: number | null }
  | { kind: "up" };

export function timerState(round: RoundView | null): TimerState {
  if (round?.phase !== "voting") return { kind: "none" };
  if (round.deadlineAt !== undefined) {
    return {
      kind: "running",
      deadlineAt: round.deadlineAt,
      startedAt: round.timerStartedAt ?? null,
    };
  }
  return round.timeUpAt !== undefined ? { kind: "up" } : { kind: "none" };
}

/** Milliseconds left at `serverNow` (the server's clock); never below 0. */
export function remainingMs(deadlineAt: number, serverNow: number): number {
  return Math.max(0, deadlineAt - serverNow);
}

/** The whole seconds shown for `ms` left: 0.2 s left still reads 0:01, so 0:00 is the end. */
export const shownSeconds = (ms: number) => Math.ceil(Math.max(0, ms) / 1000);

/** "0:45", "2:00", "60:00": minutes and two-digit seconds, digits as everywhere. */
export function clockText(ms: number): string {
  const seconds = shownSeconds(ms);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/** Whether `ms` left is the last stretch (the warn phase): under 10 s, not yet 0. */
export const inWarnPhase = (ms: number) => ms > 0 && shownSeconds(ms) <= WARN_MS / 1000;

/**
 * How much of the ring is left, 0 to 1: the time left out of the timer's whole length
 * (`deadlineAt − timerStartedAt`, which an extension lengthens). A server that sends no
 * start gives `fallbackTotal`, the time left when this page first saw the deadline.
 */
export function ringLeft(ms: number, total: number): number {
  if (!(total > 0)) return ms > 0 ? 1 : 0;
  return Math.min(1, Math.max(0, ms / total));
}

/** A length in words, for screen readers and the live region: "1 minute 30 seconds". */
export function durationWords(t: TFunction, seconds: number): string {
  const whole = Math.max(0, Math.round(seconds));
  const minutes = Math.floor(whole / 60);
  const rest = whole % 60;
  if (minutes === 0) return t("timer.seconds", { count: rest });
  if (rest === 0) return t("timer.minutes", { count: minutes });
  return t("timer.minutesSeconds", {
    minutes: t("timer.minutes", { count: minutes }),
    seconds: t("timer.seconds", { count: rest }),
  });
}

/** A length on a button: "30 s", "60 s", "2 min", or "2:30". */
export function shortDuration(t: TFunction, seconds: number): string {
  if (seconds < 120) return t("timer.shortSeconds", { n: seconds });
  if (seconds % 60 === 0) return t("timer.shortMinutes", { n: seconds / 60 });
  return clockText(seconds * 1000);
}

/**
 * A length the PO typed: whole seconds ("90") or minutes and seconds ("1:30", "01:30"),
 * spaces around it ignored; null when it is neither or lies outside 5 s to 60 min.
 */
export function parseDuration(text: string): number | null {
  const typed = text.trim();
  let seconds: number;
  const clock = /^(\d{1,2}):([0-5]\d)$/.exec(typed);
  if (clock) {
    seconds = Number(clock[1]) * 60 + Number(clock[2]);
  } else if (/^\d{1,4}$/.test(typed)) {
    seconds = Number(typed);
  } else {
    return null;
  }
  return seconds >= MIN_TIMER_SECONDS && seconds <= MAX_TIMER_SECONDS ? seconds : null;
}

/** A length as the custom field shows it again: "90" stays seconds below 2 min, else m:ss. */
export const typedDuration = (seconds: number) =>
  seconds < 120 ? String(seconds) : clockText(seconds * 1000);
