/**
 * The app's rate limiter: a fixed-window counter per key, in this process. One instance
 * serves Better Auth's endpoints (as its `customStorage`), `POST /api/me/name` and
 * `POST /api/rooms`; a socket's command limit (#15) can use one of its own. Keys carry
 * their purpose as a prefix (`ip|path` for Better Auth, `rename|…`, `rooms|…`), so the
 * counters of one instance never mix.
 */

/** A window of `window` seconds that lets `max` calls through. */
export interface RateLimitRule {
  readonly window: number;
  readonly max: number;
}

/** `retryAfter`: whole seconds until the window resets, when refused; else null. */
export interface RateLimitResult {
  allowed: boolean;
  retryAfter: number | null;
}

/** Counts one call under `key`; Better Auth's `customStorage` has the same shape. */
export interface RateLimiter {
  consume(key: string, rule: RateLimitRule): Promise<RateLimitResult>;
  /**
   * Counts one call like `consume`, and hands back `release`, which takes it back: the
   * password limits (#31) reserve a try before the check, so tries at once are counted
   * exactly, and release it when the password was right. `release` does nothing once the
   * window it counted in has ended, or a second time.
   */
  reserve(key: string, rule: RateLimitRule): Promise<RateLimitResult & { release(): void }>;
}

/** At most this many counters live at once; the oldest tenth goes when it is reached. */
export const RATE_LIMIT_MAX_KEYS = 50_000;
/** Expired counters are swept at most this often. */
const SWEEP_EVERY_MS = 30_000;

/**
 * A fixed-window counter per key, in this process. Better Auth's own memory store is one
 * map shared by every instance in the process, which would leak counts between tests;
 * this one belongs to its `setupServer`. With several instances (#39) each counts on its
 * own.
 *
 * Memory stays bounded and each call costs O(1) amortized: expired counters are swept
 * every 30 s, and at `maxKeys` the oldest tenth (by window start) is dropped at once.
 */
export function memoryRateLimit(
  now: () => number = Date.now,
  maxKeys: number = RATE_LIMIT_MAX_KEYS,
): RateLimiter {
  const windows = new Map<string, { count: number; resetAt: number }>();
  let nextSweep = 0;
  const nothing = () => {};

  /** Counts one call; the counter it counted in, or null when refused. */
  function count(key: string, { window, max }: RateLimitRule) {
    const at = now();
    if (at >= nextSweep) {
      nextSweep = at + SWEEP_EVERY_MS;
      for (const [k, entry] of windows) if (entry.resetAt <= at) windows.delete(k);
    }
    const entry = windows.get(key);
    if (!entry || entry.resetAt <= at) {
      // Re-inserted, so the map stays ordered by window start.
      windows.delete(key);
      if (windows.size >= maxKeys) {
        let drop = Math.max(1, Math.floor(maxKeys / 10));
        for (const k of windows.keys()) {
          windows.delete(k);
          if (--drop === 0) break;
        }
      }
      const fresh = { count: 1, resetAt: at + window * 1000 };
      windows.set(key, fresh);
      return { allowed: true as const, retryAfter: null, entry: fresh };
    }
    if (entry.count >= max) {
      return {
        allowed: false as const,
        retryAfter: Math.ceil((entry.resetAt - at) / 1000),
        entry: null,
      };
    }
    entry.count += 1;
    return { allowed: true as const, retryAfter: null, entry };
  }

  return {
    consume: async (key, rule) => {
      const { allowed, retryAfter } = count(key, rule);
      return { allowed, retryAfter };
    },
    reserve: async (key, rule) => {
      const { allowed, retryAfter, entry } = count(key, rule);
      if (!entry) return { allowed, retryAfter, release: nothing };
      let held = true;
      return {
        allowed,
        retryAfter,
        release: () => {
          // The same counter, so a window that ended meanwhile is never touched.
          if (held && windows.get(key) === entry && entry.count > 0) entry.count -= 1;
          held = false;
        },
      };
    },
  };
}
