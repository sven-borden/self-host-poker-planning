/**
 * The last command results of each person, keyed by room and command id, so that a client
 * which sends a command again (after a reconnect, or because its ack was lost) gets the
 * same answer and the command is applied once. In this process: a restart forgets it, and
 * so does another instance.
 *
 * Bounded per person and in people: one person's commands evict only their own older
 * results, never someone else's. When too many people are known, the one who has not
 * sent a command for longest is forgotten first.
 */
import type { CmdAck } from "@pp/protocol";

/**
 * Results kept per person: at the message limit (10 a second) that is 10 s of commands,
 * far longer than a client takes to resend after a reconnect.
 */
export const RECENT_ACKS_PER_USER = 100;
/** People whose results are kept; a result is about 200 bytes. */
export const RECENT_ACKS_USERS = 1000;

export interface RecentAcksOptions {
  perUser?: number;
  users?: number;
  /** A result it accepts is dropped once known, so the same id can run again. */
  forget?: (ack: CmdAck) => boolean;
}

export interface RecentAcks {
  /**
   * The result for `user` and `key`: the remembered one (also while it is still
   * running), or the one `run` produces, remembered from now on. A result `forget`
   * accepts, or a rejection, is dropped once it is known, so the same id can run again.
   */
  remember(user: string, key: string, run: () => Promise<CmdAck>): Promise<CmdAck>;
  /** Results held, all people together. */
  readonly size: number;
}

export function createRecentAcks({
  perUser = RECENT_ACKS_PER_USER,
  users = RECENT_ACKS_USERS,
  forget = () => false,
}: RecentAcksOptions = {}): RecentAcks {
  /** Per person, least recently used first; the people are ordered the same way. */
  const byUser = new Map<string, Map<string, Promise<CmdAck>>>();
  let size = 0;

  function entriesOf(user: string): Map<string, Promise<CmdAck>> {
    let entries = byUser.get(user);
    if (entries) {
      byUser.delete(user);
    } else {
      entries = new Map();
      if (byUser.size >= users) {
        const oldest = byUser.entries().next().value;
        if (oldest) {
          byUser.delete(oldest[0]);
          size -= oldest[1].size;
        }
      }
    }
    byUser.set(user, entries);
    return entries;
  }

  return {
    remember(user, key, run) {
      const entries = entriesOf(user);
      const known = entries.get(key);
      if (known) {
        // Most recently used goes last.
        entries.delete(key);
        entries.set(key, known);
        return known;
      }
      const pending = run();
      entries.set(key, pending);
      size += 1;
      if (entries.size > perUser) {
        const oldest = entries.keys().next().value;
        if (oldest !== undefined) {
          entries.delete(oldest);
          size -= 1;
        }
      }
      // A rejection (a bug in a step, which stores nothing) is forgotten too; the caller
      // handles the rejection itself.
      const drop = () => {
        if (entries.get(key) !== pending) return;
        entries.delete(key);
        // A person forgotten in the meantime no longer counts in `size`.
        if (byUser.get(user) === entries) size -= 1;
      };
      pending.then((ack) => {
        if (forget(ack)) drop();
      }, drop);
      return pending;
    },
    get size() {
      return size;
    },
  };
}

/** One key per room and command id, within a person's results. Neither holds a space. */
export function ackKey(roomId: string, commandId: string): string {
  return `${roomId} ${commandId}`;
}
