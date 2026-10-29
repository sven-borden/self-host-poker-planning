/**
 * Command ids across instances (#39). `recent-acks.ts` remembers each person's last results
 * in this process; with several instances a client that resends a command after
 * reconnecting may reach another one, whose memory is empty. With `REDIS_URL` the room sync
 * also claims each command id here before it runs the command: the first claim wins and
 * runs it, a claim while it runs answers `busy` (the client sends the same id again after
 * a pause), and a claim after it ran gets the stored answer. Nothing runs twice.
 *
 * A key holds the person's id, the room's id and the command id, never a room code, and
 * a value is an ack (`{ ok, version }` or `{ ok: false, code }`), never a card.
 */
import { type CmdAck, cmdAckSchema } from "@pp/protocol";

/** How long a claim holds while its command runs: past it, an instance that died has let go. */
export const ACK_CLAIM_MS = 15_000;
/** How long an answer stays: a resend after a reconnect comes within seconds. */
export const ACK_KEEP_MS = 120_000;
/** A claim or a settle that Redis does not answer within this fails (the caller falls back). */
export const ACK_TIMEOUT_MS = 1_000;

/** What a claim found: the command is this instance's to run, runs elsewhere, or ran. */
export type Claim = { state: "mine" } | { state: "running" } | { state: "done"; ack: CmdAck };

export interface SharedAcks {
  /** Claims `key` for this instance. Rejects when the store does not answer. */
  claim(key: string): Promise<Claim>;
  /** Stores the answer of a claimed command, or lets the claim go (null): it may run again. */
  settle(key: string, ack: CmdAck | null): Promise<void>;
}

/** The few Redis commands this needs (`@redis/client`'s names and shapes). */
export interface AckCommands {
  set(
    key: string,
    value: string,
    options: { condition?: "NX"; expiration: { type: "PX"; value: number } },
  ): Promise<unknown>;
  get(key: string): Promise<unknown>;
  del(key: string): Promise<unknown>;
}

/** The value of a claim whose command still runs. An ack is JSON, never empty. */
const RUNNING = "";

/** One key per person, room and command id. None of the three holds a space. */
export function sharedAckKey(user: string, roomId: string, commandId: string): string {
  return `pp:ack:${user} ${roomId} ${commandId}`;
}

export function redisAcks(redis: AckCommands, timeoutMs = ACK_TIMEOUT_MS): SharedAcks {
  const answer = <T>(command: Promise<T>) => within(command, timeoutMs);
  return {
    async claim(key) {
      // A second turn only when the key expired between the SET and the GET.
      for (let turn = 0; turn < 2; turn++) {
        const set = await answer(
          redis.set(key, RUNNING, {
            condition: "NX",
            expiration: { type: "PX", value: ACK_CLAIM_MS },
          }),
        );
        if (set === "OK") return { state: "mine" };
        const value = await answer(redis.get(key));
        if (value === null || value === undefined) continue;
        const ack = typeof value === "string" && value !== RUNNING ? parseAck(value) : undefined;
        return ack ? { state: "done", ack } : { state: "running" };
      }
      return { state: "running" };
    },
    async settle(key, ack) {
      if (ack === null) {
        await answer(redis.del(key));
        return;
      }
      await answer(
        redis.set(key, JSON.stringify(ack), { expiration: { type: "PX", value: ACK_KEEP_MS } }),
      );
    },
  };
}

function parseAck(value: string): CmdAck | undefined {
  try {
    const parsed = cmdAckSchema.safeParse(JSON.parse(value));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/** `promise`, or a rejection once `ms` passed without an answer. */
export function within<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("timeout")), ms);
  });
  return Promise.race([promise, timedOut]).finally(() => clearTimeout(timer));
}

/** For tests: the same contract in this process, as if every instance shared it. */
export function memoryAcks(): SharedAcks & { readonly keys: Map<string, string> } {
  const keys = new Map<string, string>();
  return {
    keys,
    claim: async (key) => {
      const value = keys.get(key);
      if (value === undefined) {
        keys.set(key, RUNNING);
        return { state: "mine" };
      }
      const ack = value === RUNNING ? undefined : parseAck(value);
      return ack ? { state: "done", ack } : { state: "running" };
    },
    settle: async (key, ack) => {
      if (ack === null) keys.delete(key);
      else keys.set(key, JSON.stringify(ack));
    },
  };
}
