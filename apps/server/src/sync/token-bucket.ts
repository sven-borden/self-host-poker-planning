/**
 * A token bucket: `burst` tokens to start with, refilled at `perSecond`. Each message a
 * socket sends takes one; an empty bucket answers `rate_limited` without closing anything.
 */

export interface TokenBucketOptions {
  perSecond: number;
  burst: number;
  /** Milliseconds; `performance.now` by default (monotonic, unlike `Date.now`). */
  now?: () => number;
}

/** The per-person message limit (architecture section 5): 10 a second, bursts of 20. */
export const SOCKET_MESSAGE_LIMIT = { perSecond: 10, burst: 20 } as const;

/**
 * Roster commands per person (`join`, `leave`, `rename`, `setRole`), on top of the message
 * limit: 10 a minute, bursts of 10. Each one is a commit that every socket of the room hears
 * (and a screen reader announces), and `/api/me/name` allows the same 10 names a minute.
 */
export const ROSTER_LIMIT = { perSecond: 10 / 60, burst: 10 } as const;

/**
 * History requests per person (#33), on top of the message limit: 2 a second, bursts of
 * 10. Each one is a database read of up to 50 rounds; the web app asks once on open, once
 * per new round and once per older page.
 */
export const HISTORY_LIMIT = { perSecond: 2, burst: 10 } as const;

export interface TokenBucket {
  /** Takes one token: false when the bucket is empty. */
  take(): boolean;
}

export function createTokenBucket({
  perSecond,
  burst,
  now = () => performance.now(),
}: TokenBucketOptions): TokenBucket {
  let tokens = burst;
  let last = now();
  return {
    take() {
      const at = now();
      tokens = Math.min(burst, tokens + ((at - last) / 1000) * perSecond);
      last = at;
      if (tokens < 1) return false;
      tokens -= 1;
      return true;
    },
  };
}
