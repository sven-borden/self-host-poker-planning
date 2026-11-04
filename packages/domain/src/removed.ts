/**
 * Who the PO removed, and when (U5): `RoomState.removed`. A person whose socket was down at the
 * kick never heard `kicked`; their next `enter` reads this and tells them, and only them. The
 * record is server-held, like `keeperId`: no snapshot carries it.
 *
 * Bounded twice. In time: an entry counts for `REMOVAL_NOTICE_MS` (24 hours), and every write of
 * the room (`apply`) drops what is older. In size: a kick keeps at most `MAX_REMOVED` entries,
 * newest first. A `join` takes the person's own entry out, so someone back in the room never
 * hears of the old removal again; an account's deletion takes it out too (ADR-029), and a guest's
 * sign-in moves it to the account (ADR-025).
 */
import { MAX_MEMBERS, type RoomState, type UserId } from "./room.ts";

/**
 * How long a removal is told to the person at their next `enter`. A removal sets no lockout of
 * its own (it drops a password grant, which the password form asks for again), so this is the
 * span of a working day and the night after it: a network blip, a laptop asleep, a phone tab in
 * the background. A person back after that does not expect the seat they had.
 */
export const REMOVAL_NOTICE_MS = 24 * 60 * 60 * 1000;

/** A room remembers at most this many removals: as many people as it can ever hold. */
export const MAX_REMOVED = MAX_MEMBERS;

type Removals = Record<UserId, number>;

const live = (now: number) => (at: number) => now - at < REMOVAL_NOTICE_MS;

/** The state with `record` as its removals; no key at all when the record is empty. */
function withRecord(state: RoomState, record: Removals): RoomState {
  if (Object.keys(record).length > 0) return { ...state, removed: record };
  const { removed: _, ...rest } = state;
  return rest;
}

/**
 * Whether `who` should hear, at this `enter`, that the PO removed them: they have an entry
 * younger than `REMOVAL_NOTICE_MS` and no seat. Nobody else's answer depends on it.
 */
export function wasRemoved(
  state: Pick<RoomState, "removed" | "participants">,
  who: UserId,
  now: number,
): boolean {
  const removed = state.removed;
  if (removed === undefined || !Object.hasOwn(removed, who)) return false;
  if (Object.hasOwn(state.participants, who)) return false;
  return live(now)(removed[who] as number);
}

/** A kick: `who` removed at `now`, the expired entries gone, the newest `MAX_REMOVED` kept. */
export function addRemoval(state: RoomState, who: UserId, now: number): RoomState {
  const others = Object.entries(state.removed ?? {})
    .filter(([id, at]) => id !== who && live(now)(at))
    .sort(([a, at], [b, bt]) => bt - at || (a < b ? -1 : 1))
    .slice(0, MAX_REMOVED - 1);
  return withRecord(state, Object.fromEntries([[who, now], ...others]));
}

/** `who`'s entry gone (they joined again, or their account went); the same state without one. */
export function dropRemoval(state: RoomState, who: UserId): RoomState {
  const removed = state.removed;
  if (removed === undefined || !Object.hasOwn(removed, who)) return state;
  return withRecord(
    state,
    Object.fromEntries(Object.entries(removed).filter(([id]) => id !== who)),
  );
}

/** The entries older than `REMOVAL_NOTICE_MS` gone; the same state when none is. */
export function pruneRemovals(state: RoomState, now: number): RoomState {
  const removed = state.removed;
  if (removed === undefined) return state;
  const entries = Object.entries(removed);
  const kept = entries.filter(([, at]) => live(now)(at));
  return kept.length === entries.length ? state : withRecord(state, Object.fromEntries(kept));
}

/**
 * A guest's entry becomes the account's (#48): the person who signs in is the one removed. Not
 * when the account has a seat here, which no removal can be about; the later of two entries wins.
 */
export function moveRemoval(state: RoomState, guest: UserId, account: UserId): RoomState {
  const removed = state.removed;
  if (removed === undefined || !Object.hasOwn(removed, guest)) return state;
  const at = removed[guest] as number;
  const rest = Object.fromEntries(Object.entries(removed).filter(([id]) => id !== guest));
  if (Object.hasOwn(state.participants, account)) return withRecord(state, rest);
  const theirs = Object.hasOwn(rest, account) ? (rest[account] as number) : at;
  return withRecord(state, { ...rest, [account]: Math.max(at, theirs) });
}
