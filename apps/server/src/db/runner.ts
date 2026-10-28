/**
 * The write path of every command (architecture section 6): per-room in-process queue →
 * load → step (`apply`) → compare-and-set commit → on a lost commit, reload and run the
 * step again on the fresh state. The queue avoids needless conflicts on one instance;
 * the version check keeps several instances correct.
 */
import type { RoomState, Round, UserId } from "@pp/domain";
import { historyRound } from "./history.ts";
import type { AccessWrite, RoomStore } from "./rooms.ts";

/** What a step returns; `ApplyResult` fits (both of its branches). */
export interface StepResult {
  state: RoomState;
  /**
   * `ApplyResult.ended`: the round this step replaced; history when it was revealed. A
   * revealed round with a final estimate is written too whenever a step changes it
   * (`historyRound`).
   */
  ended?: Round;
  /**
   * The room's password and grants to write with this commit, in its transaction (#31): a
   * kick drops the removed person's grant, a new password writes the hash and the grants.
   * Ignored when the step changed nothing.
   */
  access?: AccessWrite;
}

/**
 * The step ran and its result is stored. `changed` is false when the step returned the
 * loaded state itself (`===`): nothing was written and `version` is the loaded one.
 * `before` is the state the step ran on (the last one loaded).
 */
export interface RunSuccess<R extends StepResult> {
  ok: true;
  id: string;
  code: string;
  version: number;
  changed: boolean;
  before: RoomState;
  result: R;
}

/**
 * `room_not_found`: no such code. `conflict`: every attempt lost the compare-and-set.
 * `password_required`: the step needed a grant (`AccessWrite.requireGrant`) the user no
 * longer holds when it committed (#31); nothing was written.
 */
export type RunErrorCode = "room_not_found" | "conflict" | "password_required";

export type RunOutcome<R extends StepResult> = RunSuccess<R> | { ok: false; error: RunErrorCode };

export interface CommandRunner {
  /**
   * Runs `step` on the room's current state and stores the result. The step must be pure
   * and synchronous (it may run again, on a newer state, after a lost commit); it reads
   * the clock itself, for example `(state) => apply(state, command, { actor, now: Date.now() })`.
   * A database failure rejects with a `DatabaseError`; a throwing step rejects with its
   * error. Neither blocks the queue.
   *
   * A retry reads the clock again: the step's own `now` and the history row's
   * `finished_at` are those of the retry, so a deadline is judged at the time of the
   * attempt that lands. That is on purpose: the state it runs on is that of the retry too.
   *
   * A rejection does not prove that nothing was stored: when the connection drops after
   * Postgres committed but before the reply arrived, the new version is stored and `run`
   * still rejects. Callers reload and broadcast on a `DatabaseError`; they never apply the
   * command again blindly.
   */
  run<R extends StepResult>(code: string, step: (state: RoomState) => R): Promise<RunOutcome<R>>;
  /** Rooms with a queued or running command; for tests and metrics. */
  busyRooms(): number;
}

/** Retries after a lost compare-and-set before `run` answers `conflict`. */
export const MAX_RETRIES = 3;

export interface RunnerOptions {
  /** Epoch milliseconds, for a history row's `finished_at`. Default `Date.now`. */
  now?: () => number;
  maxRetries?: number;
}

export function createCommandRunner(store: RoomStore, options: RunnerOptions = {}): CommandRunner {
  const { now = Date.now, maxRetries = MAX_RETRIES } = options;
  const tails = new Map<string, Promise<unknown>>();

  function enqueue<T>(code: string, task: () => Promise<T>): Promise<T> {
    const previous = tails.get(code) ?? Promise.resolve();
    const result = previous.then(task, task);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    tails.set(code, tail);
    void tail.then(() => {
      if (tails.get(code) === tail) tails.delete(code);
    });
    return result;
  }

  async function attempt<R extends StepResult>(
    code: string,
    step: (state: RoomState) => R,
  ): Promise<RunOutcome<R>> {
    for (let tries = 0; tries <= maxRetries; tries++) {
      const loaded = await store.loadRoom(code);
      if (!loaded) return { ok: false, error: "room_not_found" };
      const result = step(loaded.state);
      const base = { ok: true as const, id: loaded.id, code: loaded.code, before: loaded.state };
      if (result.state === loaded.state) {
        return { ...base, version: loaded.version, changed: false, result };
      }
      // The round it ended, or the revealed round once its final estimate is recorded (#32).
      const round = historyRound(loaded.state, result.state, result.ended);
      const ended = round && {
        round,
        participants: names(loaded.state, result.state),
        finishedAt: now(),
      };
      const committed = await store.commitRoom(
        loaded.id,
        loaded.version,
        result.state,
        ended,
        result.access,
      );
      if (committed === "password_required") return { ok: false, error: committed };
      if (committed) return { ...base, version: loaded.version + 1, changed: true, result };
    }
    return { ok: false, error: "conflict" };
  }

  return {
    run: (code, step) => enqueue(code, () => attempt(code, step)),
    busyRooms: () => tails.size,
  };
}

/** Everyone in the room before or after the command, for the names in a history row. */
function names(before: RoomState, after: RoomState): EndedParticipants {
  const all: EndedParticipants = Object.create(null);
  for (const state of [before, after]) {
    for (const [id, p] of Object.entries(state.participants)) {
      all[id] = { name: p.name, joinedAt: p.joinedAt };
    }
  }
  return all;
}

type EndedParticipants = Record<UserId, { name: string; joinedAt: number }>;
