// The pace of the summary's history requests (#34). The server answers a person's history
// requests from a bucket of its own (#36: 10 at once, then 2 a second) and every message,
// votes included, from a shared one: paging through a long history must leave both room
// for the list's own requests and for the person's commands. So the summary takes at most
// 8 at once, then 2 a second, across every open of the panel.

export interface PaceOptions {
  /** Requests that may go at once, after a quiet spell. */
  burst: number;
  /** Requests a second once the burst is spent. */
  perSecond: number;
}

/** The summary's pace: under #36's history limit, with room to spare for the list. */
export const SUMMARY_PACE: PaceOptions = { burst: 8, perSecond: 2 };

export interface Pacer {
  /**
   * Waits for a request's turn: true once it may go, false once `stopped()` says it should
   * not go any more (the panel closed, a newer read took over).
   */
  wait(stopped: () => boolean): Promise<boolean>;
  /** Back to a full burst (tests). */
  reset(): void;
}

/** A token bucket on the page's clock: `burst` tokens, refilled at `perSecond`. */
export function createPacer({ burst, perSecond }: PaceOptions): Pacer {
  let tokens = burst;
  let at = Date.now();
  const refill = () => {
    const now = Date.now();
    tokens = Math.min(burst, tokens + (Math.max(0, now - at) / 1000) * perSecond);
    at = now;
  };
  return {
    async wait(stopped) {
      for (;;) {
        if (stopped()) return false;
        refill();
        if (tokens >= 1) {
          tokens -= 1;
          return true;
        }
        const ms = Math.ceil(((1 - tokens) / perSecond) * 1000);
        await new Promise((resolve) => setTimeout(resolve, ms));
      }
    },
    reset() {
      tokens = burst;
      at = Date.now();
    },
  };
}
