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

/** The per-socket message limit (architecture section 5): 10 a second, bursts of 20. */
export const SOCKET_MESSAGE_LIMIT = { perSecond: 10, burst: 20 } as const;

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
