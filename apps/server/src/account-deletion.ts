/**
 * Someone deletes their account (#51, ADR-029). This is the one step in the product that cannot be
 * undone, so it runs in an order that leaves nobody half deleted, whatever fails and whenever a
 * process dies, following a guest's way to an account (`guest-link.ts`):
 *
 * 1. `begin`: the marker is written, the person's sessions end and the connectors' tokens go, in
 *    one transaction. A failure here changes nothing, and the person is told so. From here on nobody
 *    acts as this person: a sign-in to the account is refused (`refuses`), and it starts the
 *    deletion again.
 * 2. The sockets of the person and of any guest on its way here hear `accountDeleted` and close,
 *    on every instance.
 * 3. Every room that names the person is dealt with, one at a time. Deleted when the person chose
 *    that or nobody can take it, by a statement; otherwise through its runner (`removeAccount`), so
 *    its people see a `leave` or a hand-over. A room that fails stops nothing but step 5. The rooms
 *    are looked up again until none is left, for a command that was in flight.
 * 4. Every named round loses the person, keeping the card, whatever came of the rooms.
 * 5. `finish`, in one transaction, the `user` row last, and only if every room was dealt with. Its
 *    cascade takes the marker, the sessions, the accounts, the grants and the guest links.
 *
 * Guests still on their way to the account (#48) are the same person: they go with it, and their
 * moves stop at `begin`, as `linkOf` then finds nothing to do.
 *
 * Everything past `begin` runs again until it is done: at once, for a moment while the person
 * waits; at a sign-in or an `enter`; and before every purge, so a few minutes after a start and
 * then daily. Each step is a no-op once done, so two instances, or a run that overlaps another,
 * cannot do it twice.
 *
 * Log lines hold counts, a room's id, an error's code and class. Never a person's id, name or
 * address, a room's code, or anything out of a room. A deletion that stays stuck says so louder
 * (`DELETION_STUCK_MS`); nothing here gives it up, and ADR-029 says what ends it.
 */
import { randomBytes } from "node:crypto";
import type { AccountRemoval } from "@pp/domain";
import { MOVE_WAIT_MS } from "@pp/protocol";
import type { AccountDeletionStore, RoomChoices } from "./db/account-deletions.ts";
import { errorCode } from "./db/errors.ts";
import type { GuestRoom } from "./db/guest-links.ts";
import type { Logger } from "./logger.ts";
import type { ServerRun } from "./sync/room-sync.ts";

/** Passes in one run; the next run goes on. */
export const MAX_PASSES = 4;

/** A deletion older than this has seen a daily sweep fail: someone should look. */
export const DELETION_STUCK_MS = 24 * 60 * 60 * 1000;

/** A new id for a revealed card or a free role: the shape of a user's, and nothing else names it. */
const newGhost = () => randomBytes(16).toString("hex");

export interface AccountRooms {
  removeAccount(room: GuestRoom, removal: AccountRemoval): Promise<ServerRun>;
  roomDeleted(id: string): void;
  dropAccount(who: string): void;
}

export interface AccountDeletions {
  /**
   * `account` asked to go. Rejects when the marker could not be written: nothing changed.
   * Otherwise resolves whether all of it is gone by the end of the wait; if not, it finishes later.
   */
  start(account: string, choices: RoomChoices): Promise<boolean>;
  /** Whether this account is going; if so, its deletion runs again, unawaited. */
  refuses(account: string): Promise<boolean>;
  /** Runs again what this account has left to do, unawaited. Never rejects. */
  resume(account: string): Promise<void>;
  /** Runs again every deletion nobody finished. Never rejects. */
  sweep(): Promise<void>;
}

export interface AccountDeletionOptions {
  store: AccountDeletionStore;
  rooms: AccountRooms;
  logger: Logger;
  /** For tests: `MOVE_WAIT_MS` otherwise. */
  waitMs?: number;
}

/** An error's code and class, the most a log line says of it: its message may hold a value. */
function reasonOf(error: unknown): { err: string; class: string } {
  const named = typeof error === "object" && error !== null ? error.constructor?.name : undefined;
  return { err: errorCode(error), class: named ?? typeof error };
}

export function createAccountDeletions(options: AccountDeletionOptions): AccountDeletions {
  const { store, rooms, waitMs = MOVE_WAIT_MS } = options;
  const log = options.logger.child({ part: "account-deletion" });
  /** The run of each account on this instance: a second request joins the first. */
  const running = new Map<string, Promise<boolean>>();

  /** One pass over `who`'s rooms: how many it found, or `failed`. */
  async function clearRooms(
    who: string,
    choices: RoomChoices,
    level: "warn" | "error",
  ): Promise<number | "failed"> {
    const found = await store.roomsOf(who);
    let failed = 0;
    for (const room of found) {
      try {
        const wish = Object.hasOwn(choices, room.id) ? choices[room.id] : undefined;
        const chosen = wish !== undefined && "delete" in wish;
        // A room with nobody in it goes whatever was chosen: a chosen heir who left takes nothing.
        if (
          (chosen && (await store.deleteKept(room.id, who))) ||
          (await store.deleteAlone(room.id, who))
        ) {
          rooms.roomDeleted(room.id);
          continue;
        }
        const removal: AccountRemoval = {
          who,
          ghost: newGhost(),
          vacant: newGhost(),
          ...(wish !== undefined && "to" in wish && { heir: wish.to }),
        };
        if ((await rooms.removeAccount(room, removal)) === "failed") failed += 1;
      } catch (error) {
        failed += 1;
        log[level](
          { room: room.id, ...reasonOf(error) },
          "account deletion: a room did not change",
        );
      }
    }
    if (failed > 0) {
      log[level]({ rooms: found.length, failed }, "account deletion: not every room changed");
      return "failed";
    }
    return found.length;
  }

  async function erase(account: string): Promise<boolean> {
    const marker = await store.markerOf(account);
    if (marker === null) return true;
    const stuck = Date.now() - marker.since.getTime() > DELETION_STUCK_MS;
    const level = stuck ? "error" : "warn";
    try {
      await store.endSessions(account);
      rooms.dropAccount(account);
      for (const guest of await store.guestsOf(account)) rooms.dropAccount(guest);
      for (let done = 0; done < MAX_PASSES; done++) {
        const people = [account, ...(await store.guestsOf(account))];
        let found = 0;
        let failed = false;
        for (const who of people) {
          const cleared = await clearRooms(who, marker.choices, level);
          if (cleared === "failed") failed = true;
          else found += cleared;
        }
        // A room that fails holds up the last step alone: everything else goes now.
        if (failed || found === 0) {
          for (const who of people) await store.anonymiseRounds(who);
        }
        if (failed) return false;
        if (found > 0) continue;
        if (await store.finish(account)) {
          log.info("account deletion finished");
          return true;
        }
      }
      log[level]("account deletion: the person's rooms kept changing");
    } catch (error) {
      log[level](reasonOf(error), "account deletion stopped");
    }
    return false;
  }

  function finish(account: string): Promise<boolean> {
    const current = running.get(account);
    if (current) return current;
    const run = erase(account)
      .catch((error: unknown) => {
        log.warn(reasonOf(error), "account deletion: the marker was not read");
        return false;
      })
      .finally(() => running.delete(account));
    running.set(account, run);
    return run;
  }

  /** `run`, or false once the wait is over; `run` goes on. */
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

  const refuses = async (account: string) => {
    if ((await store.markerOf(account)) === null) return false;
    void finish(account);
    return true;
  };

  return {
    start: async (account, choices) => {
      await store.begin(account, choices);
      return waitFor(finish(account));
    },

    refuses,

    resume: async (account) => {
      try {
        await refuses(account);
      } catch (error) {
        log.warn({ err: errorCode(error) }, "account deletion: the marker was not read");
      }
    },

    sweep: async () => {
      try {
        for (const account of await store.pending()) await finish(account);
      } catch (error) {
        log.warn({ err: errorCode(error) }, "account deletion: pending deletions not read");
      }
    },
  };
}
