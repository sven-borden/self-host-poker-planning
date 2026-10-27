/**
 * One timeout per room with a running timer, on this instance: it backs up the lazy
 * deadline in `apply`, so a round reveals at its deadline even when nobody sends anything.
 * Firing only asks the room sync to run `timeUp`; `apply` and the compare-and-set decide,
 * so two instances firing for the same room still reveal once.
 */

/** Fire this long after the deadline, so the clock has surely passed it. */
export const DEADLINE_SLACK_MS = 5;
/** setTimeout's largest delay; a later deadline is armed again when this one fires. */
const MAX_DELAY_MS = 2 ** 31 - 1;

export interface DeadlineTimers {
  /**
   * Arms the room's timeout for `deadlineAt` (epoch ms), replacing another one, or clears
   * it when `deadlineAt` is undefined. The same deadline again changes nothing.
   */
  set(code: string, deadlineAt: number | undefined): void;
  clear(code: string): void;
  clearAll(): void;
  /** The deadline armed for a room, if any; for tests. */
  armed(code: string): number | undefined;
}

export interface DeadlineOptions {
  /** Epoch milliseconds; `Date.now` by default. */
  now?: () => number;
}

export function createDeadlineTimers(
  fire: (code: string) => void,
  { now = Date.now }: DeadlineOptions = {},
): DeadlineTimers {
  const timers = new Map<string, { at: number; timer: ReturnType<typeof setTimeout> }>();

  function clear(code: string) {
    const current = timers.get(code);
    if (!current) return;
    clearTimeout(current.timer);
    timers.delete(code);
  }

  return {
    set(code, deadlineAt) {
      if (timers.get(code)?.at === deadlineAt) return;
      clear(code);
      if (deadlineAt === undefined) return;
      const delay = Math.min(MAX_DELAY_MS, Math.max(0, deadlineAt - now()) + DEADLINE_SLACK_MS);
      const timer = setTimeout(() => {
        timers.delete(code);
        fire(code);
      }, delay);
      // The HTTP server keeps the process alive; a pending reveal alone must not.
      timer.unref();
      timers.set(code, { at: deadlineAt, timer });
    },
    clear,
    clearAll() {
      for (const code of [...timers.keys()]) clear(code);
    },
    armed: (code) => timers.get(code)?.at,
  };
}
