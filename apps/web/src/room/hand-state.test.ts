import { apply, type Command, createRoom, type Participant, type RoomState } from "@pp/domain";
import { type RoomView, toSnapshot } from "@pp/protocol";
import { describe, expect, it } from "vitest";
import {
  answered,
  type Confirmed,
  confirmedOf,
  type HandState,
  nextStep,
  press,
  roundKey,
  SETTLED,
  shownCard,
  withShownVote,
} from "./hand-state.ts";

// The hand's state machine against the real domain: each step's "server" is `apply`, and
// the confirmed card comes from the viewer's projection, as on the page.

const ME = "me";

function roomWith(people: Array<[string, Participant["role"]]>): RoomState {
  const state = createRoom({ ownerId: "po" });
  const participants: Record<string, Participant> = {};
  people.forEach(([id, role], i) => {
    participants[id] = { name: `Name ${id}`, role, joinedAt: i + 1, connected: true };
  });
  return { ...state, participants };
}

function run(state: RoomState, actor: string, command: Command, now = 10): RoomState {
  const result = apply(state, command, { actor, now });
  if (!result.ok) throw new Error(result.error);
  return result.state;
}

const view = (state: RoomState): RoomView =>
  toSnapshot(state, ME, { code: "abc", version: 1, now: 0 }).room;

const lobby = roomWith([
  ["po", "voter"],
  [ME, "voter"],
  ["ana", "voter"],
]);
const voting = run(lobby, "po", { type: "startRound", subject: { kind: "none" } });

/** The server's answer to `command` from the viewer: the new state, as a confirmed card. */
function serve(state: RoomState, command: { type: string; payload?: { card: string } }) {
  const domain: Command =
    command.type === "castVote"
      ? { type: "castVote", card: command.payload?.card ?? "" }
      : { type: "retractVote" };
  const result = apply(state, domain, { actor: ME, now: 20 });
  return result.ok ? { ok: true as const, state: result.state } : { ok: false as const, state };
}

describe("roundKey and confirmedOf", () => {
  it("keys a voting round by number and start, and nothing else", () => {
    expect(roundKey(view(lobby))).toBeNull();
    expect(roundKey(view(voting))).toBe("1:10");
    const revealed = run(voting, "po", { type: "reveal" });
    expect(roundKey(view(revealed))).toBeNull();
    // A restart (new deck) keeps the number, not the start.
    const restarted = run(voting, "po", { type: "updateSettings", patch: { specials: [] } }, 30);
    expect(roundKey(view(restarted))).toBe("1:30");
  });

  it("reads the viewer's card in the voting round only", () => {
    expect(confirmedOf(undefined)).toEqual({ card: null, round: null });
    expect(confirmedOf(view(voting))).toEqual({ card: null, round: "1:10" });
    const voted = run(voting, ME, { type: "castVote", card: "5" });
    expect(confirmedOf(view(voted))).toEqual({ card: "5", round: "1:10" });
    // Ana's vote does not reveal (the PO has not voted): the viewer's card stays theirs.
    const revealed = run(voted, "po", { type: "reveal" });
    expect(confirmedOf(view(revealed))).toEqual({ card: null, round: null });
  });
});

describe("the hand's state machine", () => {
  const confirmed = confirmedOf(view(voting));

  it("shows a pick at once (optimistic) and sends one castVote", () => {
    const pressed = press(SETTLED, "5", confirmed);
    expect(shownCard(pressed, confirmed)).toBe("5");
    const step = nextStep(pressed, confirmed);
    expect(step.command).toEqual({ type: "castVote", payload: { card: "5" } });
    expect(step.state.sending).toBe(true);
    // Nothing else goes out while it is on the wire.
    expect(nextStep(step.state, confirmed).command).toBeNull();
  });

  it("settles on the server's card once the ack and its snapshot are in (confirmed)", () => {
    const step = nextStep(press(SETTLED, "5", confirmed), confirmed);
    const server = serve(voting, step.command ?? { type: "none" });
    const now = confirmedOf(view(server.state));
    const after = nextStep(answered(step.state, true), now);
    expect(after).toEqual({ state: SETTLED, command: null });
    expect(shownCard(after.state, now)).toBe("5");
  });

  it("rolls back to the confirmed card on a refusal", () => {
    const voted = run(voting, ME, { type: "castVote", card: "3" });
    const before = confirmedOf(view(voted));
    const step = nextStep(press(SETTLED, "8", before), before);
    expect(shownCard(step.state, before)).toBe("8");
    // The PO revealed before the vote arrived: refused.
    const revealed = run(voted, "po", { type: "reveal" });
    expect(serve(revealed, step.command ?? { type: "none" }).ok).toBe(false);
    const back = answered(step.state, false);
    expect(back).toEqual(SETTLED);
    expect(shownCard(back, before)).toBe("3");
  });

  it("pressing the card shown takes the vote back", () => {
    const voted = confirmedOf(view(run(voting, ME, { type: "castVote", card: "5" })));
    const pressed = press(SETTLED, "5", voted);
    expect(shownCard(pressed, voted)).toBeNull();
    expect(nextStep(pressed, voted).command).toEqual({ type: "retractVote" });
  });

  it("a press on another card changes the vote", () => {
    const voted = confirmedOf(view(run(voting, ME, { type: "castVote", card: "5" })));
    expect(nextStep(press(SETTLED, "8", voted), voted).command).toEqual({
      type: "castVote",
      payload: { card: "8" },
    });
  });

  it("collapses a fast double click into the server's final state", () => {
    let server = voting;
    let state: HandState = press(SETTLED, "5", confirmedOf(view(server)));
    let step = nextStep(state, confirmedOf(view(server)));
    // The second click lands while castVote 5 is on the wire: the wish is now "none".
    state = press(step.state, "5", confirmedOf(view(server)));
    expect(shownCard(state, confirmedOf(view(server)))).toBeNull();
    const sent: string[] = [];
    while (step.command !== null) {
      sent.push(step.command.type);
      const answer = serve(server, step.command);
      server = answer.state;
      state = answered(state, answer.ok);
      step = nextStep(state, confirmedOf(view(server)));
      state = step.state;
    }
    expect(sent).toEqual(["castVote", "retractVote"]);
    expect(state).toEqual(SETTLED);
    expect(confirmedOf(view(server)).card).toBeNull();
  });

  it("sends nothing when quick presses end where the server already is", () => {
    const pressed = press(press(SETTLED, "5", confirmed), "5", confirmed);
    expect(nextStep(pressed, confirmed)).toEqual({ state: SETTLED, command: null });
  });

  it("keeps showing a pending pick when another snapshot arrives for the same round", () => {
    const step = nextStep(press(SETTLED, "5", confirmed), confirmed);
    // Ana votes meanwhile: a new snapshot, the viewer's card still unconfirmed.
    const other = confirmedOf(view(run(voting, "ana", { type: "castVote", card: "2" })));
    expect(shownCard(step.state, other)).toBe("5");
  });

  it("drops a pending pick when the round changes under it", () => {
    const step = nextStep(press(SETTLED, "5", confirmed), confirmed);
    const next = run(voting, "po", { type: "startRound", subject: { kind: "none" } }, 40);
    const now = confirmedOf(view(next));
    expect(shownCard(step.state, now)).toBeNull();
    expect(nextStep(answered(step.state, true), now)).toEqual({ state: SETTLED, command: null });
  });

  it("gives up rather than sending the same command again when the snapshot disagrees", () => {
    const step = nextStep(press(SETTLED, "5", confirmed), confirmed);
    // Acked, yet the snapshot still shows no vote (it was lost): the server's card wins.
    expect(nextStep(answered(step.state, true), confirmed)).toEqual({
      state: SETTLED,
      command: null,
    });
  });

  it("ignores presses outside Voting", () => {
    const outside: Confirmed = { card: null, round: null };
    expect(press(SETTLED, "5", outside)).toBe(SETTLED);
  });
});

describe("withShownVote", () => {
  it("folds the viewer's pick into voted and yourVote while Voting", () => {
    const room = view(voting);
    expect(withShownVote(room, null)).toBe(room);
    const shown = withShownVote(room, "5");
    expect(shown.round?.voted).toEqual([ME]);
    expect(shown.round?.yourVote).toBe("5");
    const voted = view(
      run(run(voting, "ana", { type: "castVote", card: "2" }), ME, {
        type: "castVote",
        card: "3",
      }),
    );
    const back = withShownVote(voted, null);
    expect(back.round?.voted).toEqual(["ana"]);
    expect(back.round).not.toHaveProperty("yourVote");
  });

  it("leaves the lobby, a revealed round and a viewer outside the room alone", () => {
    expect(withShownVote(view(lobby), "5")).toEqual(view(lobby));
    const revealed = view(run(voting, "po", { type: "reveal" }));
    expect(withShownVote(revealed, "5")).toBe(revealed);
    const stranger = toSnapshot(voting, "nobody", { code: "abc", version: 1, now: 0 }).room;
    expect(withShownVote(stranger, "5")).toBe(stranger);
  });
});
