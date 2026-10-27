/**
 * Presence grace timers (#17, architecture section 9): when a person's last socket in a
 * room leaves this instance, a timer waits `PRESENCE_GRACE_MS` before the room sync marks
 * them away, so a reload or a network blip changes nothing. A socket of theirs that enters
 * again within the grace cancels it. Firing only asks the room sync to run the `presence`
 * command; `apply` and the compare-and-set decide.
 *
 * One timer per person per room, on this instance; all of a room's timers go when its last
 * socket leaves, and all of them on shutdown.
 */

/** How long a person may be gone before they show as away. */
export const PRESENCE_GRACE_MS = 15_000;

/**
 * The grace of people the room shows as connected when its first socket reaches this
 * instance, as after a restart: every client reconnects at once and some take longer than
 * a reload, so they get more time before a round can reveal without them.
 */
export const PRESENCE_RESTART_GRACE_MS = 60_000;

export interface GraceTimers {
  /**
   * Starts the person's grace in the room, `ms` long (the timers' grace by default); one
   * already running keeps its deadline.
   */
  start(room: string, who: string, ms?: number): void;
  /** Cancels the person's grace in the room, if any. Returns whether one was running. */
  cancel(room: string, who: string): boolean;
  /** Cancels every grace of a room: its last socket left this instance. */
  clearRoom(room: string): void;
  clearAll(): void;
  /** Whether the person's grace runs in the room; for tests. */
  pending(room: string, who: string): boolean;
}

export function createGraceTimers(
  fire: (room: string, who: string) => void,
  graceMs: number = PRESENCE_GRACE_MS,
): GraceTimers {
  const rooms = new Map<string, Map<string, ReturnType<typeof setTimeout>>>();

  function cancel(room: string, who: string): boolean {
    const people = rooms.get(room);
    const timer = people?.get(who);
    if (!people || timer === undefined) return false;
    clearTimeout(timer);
    people.delete(who);
    if (people.size === 0) rooms.delete(room);
    return true;
  }

  function clearRoom(room: string) {
    const people = rooms.get(room);
    if (!people) return;
    for (const timer of people.values()) clearTimeout(timer);
    rooms.delete(room);
  }

  return {
    start(room, who, ms = graceMs) {
      let people = rooms.get(room);
      if (people?.has(who)) return;
      if (!people) {
        people = new Map();
        rooms.set(room, people);
      }
      const timer = setTimeout(() => {
        cancel(room, who);
        fire(room, who);
      }, ms);
      // The HTTP server keeps the process alive; a pending grace alone must not.
      timer.unref();
      people.set(who, timer);
    },
    cancel,
    clearRoom,
    clearAll() {
      for (const room of [...rooms.keys()]) clearRoom(room);
    },
    pending: (room, who) => rooms.get(room)?.has(who) === true,
  };
}
