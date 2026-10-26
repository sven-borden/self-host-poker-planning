/** Room states for the repository tests, built through `apply`. Not imported by `main.ts`. */
import { apply, type Command, createRoom, type RoomState, type Round } from "@pp/domain";

export const T0 = 1_760_000_000_000;

/** Applies a command that must succeed. */
export function play(state: RoomState, actor: string, command: Command, now = T0): RoomState {
  const result = apply(state, command, { actor, now });
  if (!result.ok) throw new Error(`fixture command refused: ${result.error}`);
  return result.state;
}

/**
 * Ada (PO, u1), Bob (u2) and Cy (u3) in a voting round on "Login page"; Bob voted 5 and
 * Cy 8. Options: an anonymous round, a running 60 s timer.
 */
export function votingRoom({ anonymous = false, timer = false } = {}): RoomState {
  let s = createRoom({ ownerId: "u1" });
  s = play(s, "u1", { type: "join", name: "Ada", role: "voter" }, T0);
  s = play(s, "u2", { type: "join", name: "Bob", role: "voter" }, T0 + 1);
  s = play(s, "u3", { type: "join", name: "Cy", role: "voter" }, T0 + 2);
  s = play(
    s,
    "u1",
    {
      type: "updateSettings",
      patch: { revealNames: !anonymous, timer: { seconds: timer ? 60 : null } },
    },
    T0 + 3,
  );
  s = play(s, "u1", { type: "startRound", subject: { kind: "title", text: "Login page" } }, T0 + 4);
  s = play(s, "u2", { type: "castVote", card: "5" }, T0 + 5);
  s = play(s, "u3", { type: "castVote", card: "8" }, T0 + 6);
  return s;
}

/** `votingRoom` revealed by the PO at T0 + 10. */
export function revealedRoom(options: { anonymous?: boolean } = {}): RoomState {
  return play(votingRoom(options), "u1", { type: "reveal" }, T0 + 10);
}

/** Starts the next round on `state`: the new state and the round it ended. */
export function nextRound(state: RoomState, now = T0 + 20): { state: RoomState; ended: Round } {
  const result = apply(
    state,
    { type: "startRound", subject: { kind: "none" } },
    { actor: "u1", now },
  );
  if (!result.ok || !result.ended) throw new Error("fixture: startRound ended no round");
  return { state: result.state, ended: result.ended };
}
