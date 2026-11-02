/**
 * A guest who signs in keeps everything (#48, ADR-025). Better Auth makes a new user for the
 * account, and this moves what the guest holds to it, in an order that loses nothing whatever
 * fails and whenever a process dies:
 *
 * 1. `begin`: the link row is written and the guest's sessions end, in one transaction. A
 *    failure here ends the sign-in: the error reaches `finishSignIn`, no cookie goes out, and
 *    the person is still the guest they were. If the process dies after this, or before the
 *    answer leaves, the row remains: the move goes on without them, and signing in again is
 *    the way back to the rooms, as for anyone who lost a cookie.
 * 2. The guest's sockets hear `signedIn` and close, so nobody acts as a guest that is going.
 * 3. Every room that names the guest moves, one at a time, through its runner. A room that fails
 *    does not stop the others, and rooms already moved stay moved. The rooms are looked up
 *    again until a pass changes nothing, for a command that was in flight when the sockets
 *    closed.
 * 4. Only after a pass with no failure: `complete` moves what is left and deletes the guest, in
 *    one transaction.
 *
 * Everything past `begin` runs again until it is done: at once in the callback, which waits a
 * few seconds and then lets the person go on; at every `enter` of the account; and before every
 * purge, so a few minutes after a start and then daily. While the row exists the purge leaves the
 * guest and the guest's rooms alone. Each step is a no-op once done, so two instances, or a run
 * that overlaps another, cannot do it twice.
 *
 * Log lines hold counts and codes. Never a person's id, name or address, or a room's code.
 */

import { errorCode } from "./db/errors.ts";
import type { GuestLinkStore } from "./db/guest-links.ts";
import type { Logger } from "./logger.ts";
import type { ServerRun } from "./sync/room-sync.ts";

/** How long a sign-in or an `enter` waits for a move, which then goes on without it. */
export const MOVE_WAIT_MS = 5_000;

/** Passes over a guest's rooms in one run; the next run goes on. */
export const MAX_PASSES = 4;

export interface GuestRooms {
  moveGuest(code: string, guest: string, account: string): Promise<ServerRun>;
  dropGuest(guest: string): void;
}

export interface GuestLinks {
  /**
   * `guest` signed in as `account`. Rejects when the link could not be written: the sign-in ends
   * there. Otherwise resolves whether all of it moved in time; if not, it moves later.
   */
  link(guest: string, account: string): Promise<boolean>;
  /** Runs again whatever this account's guests still have to move. Never rejects. */
  settle(account: string): Promise<void>;
  /** Runs again every move nobody finished. Never rejects. */
  sweep(): Promise<void>;
}

export interface GuestLinkOptions {
  store: GuestLinkStore;
  rooms: GuestRooms;
  logger: Logger;
  /** For tests: `MOVE_WAIT_MS` otherwise. */
  waitMs?: number;
}

export function createGuestLinks(options: GuestLinkOptions): GuestLinks {
  const { store, rooms, waitMs = MOVE_WAIT_MS } = options;
  const log = options.logger.child({ part: "guest-link" });
  /** The run of each guest on this instance: an `enter` joins the callback's. */
  const running = new Map<string, Promise<boolean>>();

  /** One pass over the guest's rooms; true when it found nothing left to do. */
  async function pass(guest: string, account: string): Promise<boolean | "failed"> {
    let changed = 0;
    let failed = 0;
    for (const code of await store.roomsOf(guest)) {
      const outcome = await rooms.moveGuest(code, guest, account).catch(() => "failed" as const);
      if (outcome === "changed") changed += 1;
      if (outcome === "failed") failed += 1;
    }
    if (failed > 0) {
      log.warn({ moved: changed, failed }, "guest link: not every room moved");
      return "failed";
    }
    return changed === 0;
  }

  async function move(guest: string): Promise<boolean> {
    const account = await store.accountOf(guest);
    if (account === null) return true;
    rooms.dropGuest(guest);
    for (let done = 0; done < MAX_PASSES; done++) {
      const finished = await pass(guest, account);
      if (finished === "failed") return false;
      if (finished) {
        await store.complete(guest, account);
        return true;
      }
    }
    log.warn("guest link: the guest's rooms kept changing");
    return false;
  }

  function finish(guest: string): Promise<boolean> {
    const current = running.get(guest);
    if (current) return current;
    const run = move(guest)
      .catch((error: unknown) => {
        log.warn({ err: errorCode(error) }, "guest link: the move stopped");
        return false;
      })
      .finally(() => running.delete(guest));
    running.set(guest, run);
    return run;
  }

  /** `run`, or false once `waitMs` passed; `run` goes on. */
  async function waitFor(run: Promise<boolean>): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), waitMs);
      timer.unref();
    });
    try {
      return await Promise.race([run, late]);
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    link: async (guest, account) => {
      await store.begin(guest, account);
      return waitFor(finish(guest));
    },

    settle: async (account) => {
      try {
        const guests = await store.guestsOf(account);
        if (guests.length > 0) await waitFor(Promise.all(guests.map(finish)).then(() => true));
      } catch (error) {
        log.warn({ err: errorCode(error) }, "guest link: pending moves not read");
      }
    },

    sweep: async () => {
      try {
        for (const guest of await store.pending()) await finish(guest);
      } catch (error) {
        log.warn({ err: errorCode(error) }, "guest link: pending moves not read");
      }
    },
  };
}
