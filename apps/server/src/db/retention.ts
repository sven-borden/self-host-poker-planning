/**
 * The retention purge (#35, ADR-014): rooms idle longer than `ROOM_TTL_DAYS`, with their
 * history, grants and password counters, and the guests nobody can use any more. The
 * schedule lives in `retention.ts`; this file holds the SQL and the lock.
 *
 * "Idle" is decided by each statement's own `WHERE`, on rows it has locked: a commit or a
 * visit that lands during a run moves `last_active_at` and keeps the room, and a room
 * whose row a commit holds right now is skipped (`skip locked`). Nothing here logs; the
 * caller logs the counts.
 */
import type pg from "pg";
import { PASSWORD_LIMITS } from "../room-password.ts";
import { guard } from "./errors.ts";

/** The session advisory lock of a purge: one instance at a time runs it. */
export const RETENTION_LOCK_KEY = 7_000_035;

/** Rows per statement: no statement holds many row locks for long. */
export const PURGE_BATCH = 500;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * A guest younger than this is never purged, whatever its sessions: Better Auth writes
 * the user before its first session, and a sign-in in progress must not lose its user.
 */
export const GUEST_MIN_AGE_MS = DAY_MS;

/**
 * A visit moves `last_active_at` only when it is older than this: a day, or a 24th of the
 * period when that is shorter (an hour at `ROOM_TTL_DAYS=1`). So one write a day at most,
 * and a room visited at any moment stays at least 23/24 of the period after that visit,
 * whichever instance the visit reached.
 */
export function touchAfterMs(ttlDays: number): number {
  return Math.min(DAY_MS, (ttlDays * DAY_MS) / 24);
}

/** Rooms idle since before this instant are purged. */
export function cutoffOf(now: Date, ttlDays: number): Date {
  return new Date(now.getTime() - ttlDays * DAY_MS);
}

export interface PurgeOptions {
  /**
   * The run's clock, for tests. Left out (production), the run reads Postgres's `now()`
   * on its locked session: `last_active_at` is written by that clock too, so an app clock
   * running ahead cannot make a room look idle sooner.
   */
  now?: Date;
  ttlDays: number;
  /** Rooms (by id) with a socket on this instance: kept this run, however idle. */
  occupied?: readonly string[];
  batchSize?: number;
  /** Shutdown: no further batch starts; the counts so far come back. */
  signal?: AbortSignal;
}

export interface PurgeCounts {
  rooms: number;
  /** `round_history` rows deleted with those rooms. */
  history: number;
  guests: number;
  /** Rooms that stay whose ended window of wrong passwords was cleared. */
  passwordWindows: number;
  /** Delete statements run. */
  batches: number;
  /** The run stopped early for a shutdown. */
  interrupted: boolean;
}

export interface RetentionStore {
  /**
   * Runs one purge under `RETENTION_LOCK_KEY`. Resolves `null` without deleting anything
   * when another instance holds the lock.
   */
  purge(options: PurgeOptions): Promise<PurgeCounts | null>;
  /**
   * A visit to the room (by id): moves `last_active_at` to now when it is older than
   * `touchAfterMs(ttlDays)`, so a team that only opens its room keeps it. One `UPDATE`,
   * usually of no row.
   */
  touchRoom(id: string, ttlDays: number): Promise<void>;
}

/**
 * Idle rooms, oldest first, locked and deleted in one statement. A room is idle when its
 * `last_active_at` is before the cutoff, it has no socket on this instance, and its owner
 * is not a signed-in user (ADR-014: those rooms stay until deleted; a guest owner, or one
 * deleted already, does not keep a room). Once `for update` holds a row it re-checks the
 * `WHERE` on the row's latest version, so a commit or a visit that landed after the
 * statement began keeps its room, and nothing can move a locked row before `gone` deletes
 * it. `history` counts the rows the cascade deletes: the statement still sees them.
 */
const DELETE_ROOMS = `
  with doomed as (
    select r.id from room r
    where r.last_active_at < $1::timestamptz
      and r.id <> all($2::uuid[])
      and not exists (
        select 1 from "user" u where u.id = r.owner_user_id and u.is_anonymous is not true
      )
    order by r.last_active_at
    limit $3
    for update of r skip locked
  ),
  gone as (
    delete from room r using doomed d
    where r.id = d.id
    returning r.id
  )
  select
    (select count(*) from gone)::int as rooms,
    (select count(*) from round_history h where h.room_id in (select id from gone))::int as history`;

/**
 * Guests nobody can use any more: anonymous, at least a day old, without a session that
 * has not expired (a guest's session lasts `ROOM_TTL_DAYS` after the last visit), and
 * owning no room. Their sessions, accounts and grants go by cascade. A signed-in user
 * (`is_anonymous` false or null) is never one.
 */
const DELETE_GUESTS = `
  with doomed as (
    select u.id from "user" u
    where u.is_anonymous = true
      and u.created_at < $2::timestamptz
      and not exists (
        select 1 from session s where s.user_id = u.id and s.expires_at > $1::timestamptz
      )
      and not exists (select 1 from room r where r.owner_user_id = u.id)
    limit $3
    for update of u skip locked
  ),
  gone as (delete from "user" u using doomed d where u.id = d.id returning u.id)
  select count(*)::int as guests from gone`;

/** The ended windows of wrong passwords of the rooms that stay (#31). */
const CLEAR_PASSWORD_WINDOWS = `
  update room set password_failures = 0, password_failures_since = null
  where password_failures_since < $1::timestamptz - make_interval(secs => $2)`;

const TOUCH_ROOM = `
  update room set last_active_at = now()
  where id = $1::uuid and last_active_at < now() - make_interval(secs => $2)`;

export function createRetentionStore(pool: pg.Pool): RetentionStore {
  async function batches(
    client: pg.PoolClient,
    step: string,
    text: string,
    params: unknown[],
    size: number,
    signal: AbortSignal | undefined,
    /** Adds a batch's counts to the run's; returns how many rows it deleted. */
    take: (row: Record<string, number | undefined>) => number,
  ): Promise<{ batches: number; interrupted: boolean }> {
    let done = 0;
    for (;;) {
      if (signal?.aborted) return { batches: done, interrupted: true };
      const { rows } = await guard(step, () =>
        client.query<Record<string, number>>(text, [...params, size]),
      );
      done += 1;
      if (take(rows[0] ?? {}) < size) return { batches: done, interrupted: false };
    }
  }

  return {
    purge: async (options) => {
      const { ttlDays, occupied = [], batchSize = PURGE_BATCH, signal } = options;
      const client = await guard("purge", () => pool.connect());
      let locked = false;
      let failed = false;
      try {
        const { rows } = await guard("lock purge", () =>
          client.query<{ locked: boolean; now: Date }>(
            "select pg_try_advisory_lock($1::bigint) as locked, now() as now",
            [RETENTION_LOCK_KEY],
          ),
        );
        const [lock] = rows;
        if (!lock?.locked) return null;
        locked = true;
        const now = options.now ?? lock.now;
        const counts: PurgeCounts = {
          rooms: 0,
          history: 0,
          guests: 0,
          passwordWindows: 0,
          batches: 0,
          interrupted: false,
        };
        // Rooms first: a guest whose last room just went may go in the same run.
        const rooms = await batches(
          client,
          "purge rooms",
          DELETE_ROOMS,
          [cutoffOf(now, ttlDays).toISOString(), [...occupied]],
          batchSize,
          signal,
          (row) => {
            counts.rooms += row.rooms ?? 0;
            counts.history += row.history ?? 0;
            return row.rooms ?? 0;
          },
        );
        counts.batches += rooms.batches;
        if (rooms.interrupted) return { ...counts, interrupted: true };
        const guests = await batches(
          client,
          "purge guests",
          DELETE_GUESTS,
          [now.toISOString(), new Date(now.getTime() - GUEST_MIN_AGE_MS).toISOString()],
          batchSize,
          signal,
          (row) => {
            counts.guests += row.guests ?? 0;
            return row.guests ?? 0;
          },
        );
        counts.batches += guests.batches;
        if (guests.interrupted) return { ...counts, interrupted: true };
        const cleared = await guard("clear password windows", () =>
          client.query(CLEAR_PASSWORD_WINDOWS, [now.toISOString(), PASSWORD_LIMITS.room.window]),
        );
        counts.passwordWindows = cleared.rowCount ?? 0;
        return counts;
      } catch (error) {
        failed = true;
        throw error;
      } finally {
        if (!locked) {
          // A client whose query failed may be broken: the pool drops it.
          client.release(failed);
        } else {
          // The lock is the session's: unlock before the client goes back to the pool. If
          // that fails, the pool drops the client, and the lock ends with its session.
          await client.query("select pg_advisory_unlock($1::bigint)", [RETENTION_LOCK_KEY]).then(
            () => client.release(),
            () => client.release(true),
          );
        }
      }
    },

    touchRoom: async (id, ttlDays) => {
      await guard("touch room", () => pool.query(TOUCH_ROOM, [id, touchAfterMs(ttlDays) / 1000]));
    },
  };
}
