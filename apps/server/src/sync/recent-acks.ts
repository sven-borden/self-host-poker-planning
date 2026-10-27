/**
 * The last command results, keyed by user, room and command id, so that a client which
 * sends a command again (after a reconnect, or because its ack was lost) gets the same
 * answer and the command is applied once. A small LRU in this process: a restart forgets
 * it, and so does another instance.
 */
import type { CmdAck } from "@pp/protocol";

/** About 2 kB per 10 entries; enough for a few hundred busy rooms. */
export const RECENT_ACKS_SIZE = 5000;

export interface RecentAcks {
  /**
   * The result for `key`: the remembered one (also while it is still running), or the one
   * `run` produces, remembered from now on. A result `forget` accepts, or a rejection, is
   * dropped once it is known, so the same id can run again.
   */
  remember(key: string, run: () => Promise<CmdAck>): Promise<CmdAck>;
  readonly size: number;
}

export function createRecentAcks(
  max: number = RECENT_ACKS_SIZE,
  forget: (ack: CmdAck) => boolean = () => false,
): RecentAcks {
  const entries = new Map<string, Promise<CmdAck>>();
  return {
    remember(key, run) {
      const known = entries.get(key);
      if (known) {
        // Most recently used goes last.
        entries.delete(key);
        entries.set(key, known);
        return known;
      }
      const pending = run();
      entries.set(key, pending);
      if (entries.size > max) {
        const oldest = entries.keys().next().value;
        if (oldest !== undefined) entries.delete(oldest);
      }
      // A rejection (a bug in a step, which stores nothing) is forgotten too; the caller
      // handles the rejection itself.
      const drop = () => {
        if (entries.get(key) === pending) entries.delete(key);
      };
      pending.then((ack) => {
        if (forget(ack)) drop();
      }, drop);
      return pending;
    },
    get size() {
      return entries.size;
    },
  };
}

/** One key per user, room and command id. None of the three can hold a space. */
export function ackKey(userId: string, room: string, commandId: string): string {
  return `${userId} ${room} ${commandId}`;
}
