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

/**
 * Changes to the queue per person (#52), on top of the message limit: 2 a second, bursts of
 * 30. Each one may rewrite a column of 256 KB. A paste takes at most about 20 commands, and
 * a PO moves a row a few places at a time.
 */
export const QUEUE_WRITE_LIMIT = { perSecond: 2, burst: 30 } as const;

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

/** One token bucket per key (an address: the socket handshakes, `realtime.ts`). */
export interface KeyedTokenBuckets {
  /** Takes one token from `key`'s bucket, a full one if the key is new: false when empty. */
  take(key: string): boolean;
  /** Keys held. */
  readonly size: number;
}

/** At most this many keys live at once, as the HTTP limiter's counters (`rate-limit.ts`). */
export const KEYED_BUCKETS_MAX_KEYS = 50_000;
/** Buckets that have refilled are forgotten at most this often. */
const KEYED_SWEEP_EVERY_MS = 30_000;

/**
 * A token bucket per key, in this process. A bucket that has refilled is the same as a new
 * one, so it is forgotten: every 30 s, and before a new key would pass `maxKeys`. If the map
 * is still full, the tenth whose last take is oldest goes. Memory stays bounded; only a client
 * that spreads its requests over more than `maxKeys` addresses (or IPv6 /64 networks) gets a
 * fresh bucket that way.
 */
export function createKeyedTokenBuckets(
  { perSecond, burst, now = () => performance.now() }: TokenBucketOptions,
  maxKeys: number = KEYED_BUCKETS_MAX_KEYS,
): KeyedTokenBuckets {
  /** Ordered by last take: a key moves to the end each time. */
  const buckets = new Map<string, { tokens: number; last: number }>();
  let nextSweep = now() + KEYED_SWEEP_EVERY_MS;
  const fill = (bucket: { tokens: number; last: number }, at: number) =>
    Math.min(burst, bucket.tokens + ((at - bucket.last) / 1000) * perSecond);
  const sweep = (at: number) => {
    for (const [key, bucket] of buckets) if (fill(bucket, at) >= burst) buckets.delete(key);
  };

  return {
    take(key) {
      const at = now();
      if (at >= nextSweep) {
        nextSweep = at + KEYED_SWEEP_EVERY_MS;
        sweep(at);
      }
      let bucket = buckets.get(key);
      if (bucket) {
        buckets.delete(key);
        bucket.tokens = fill(bucket, at);
      } else {
        if (buckets.size >= maxKeys) sweep(at);
        if (buckets.size >= maxKeys) {
          let drop = Math.max(1, Math.floor(maxKeys / 10));
          for (const old of buckets.keys()) {
            buckets.delete(old);
            if (--drop === 0) break;
          }
        }
        bucket = { tokens: burst, last: at };
      }
      bucket.last = at;
      buckets.set(key, bucket);
      if (bucket.tokens < 1) return false;
      bucket.tokens -= 1;
      return true;
    },
    get size() {
      return buckets.size;
    },
  };
}
