import {
  apply,
  type Cause,
  type Command,
  createRoom,
  OWNER_CLAIM_AFTER_MS,
  type RoomState,
} from "@pp/domain";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { projectCauses, toSnapshot } from "./project.ts";
import { type Snapshot, snapshotSchema } from "./schemas.ts";
import { meta, OWNER, PEOPLE, play, scenarioArb, VIEWERS } from "./test-support.ts";
import { PROTOCOL_VERSION } from "./version.ts";

const T = 1_700_000_000_000;
const META = { code: "roomcode", version: 7, now: T + 99 };

/** Runs `[actor, command]` pairs through the domain, one millisecond apart. */
function run(steps: ReadonlyArray<[string, Command]>, state = createRoom({ ownerId: "po" })) {
  let current: RoomState = state;
  let causes: Cause[] = [];
  for (const [i, [actor, command]] of steps.entries()) {
    const result = apply(current, command, { actor, now: T + i });
    if (!result.ok) throw new Error(`${command.type} refused: ${result.error}`);
    current = result.state;
    causes = result.causes;
  }
  return { state: current, causes };
}

const join = (who: string, role: "voter" | "observer" = "voter"): [string, Command] => [
  who,
  { type: "join", name: `name ${who}`, role },
];
const vote = (who: string, card: string): [string, Command] => [who, { type: "castVote", card }];
const settings = (patch: object): [string, Command] => ["po", { type: "updateSettings", patch }];
const start: [string, Command] = ["po", { type: "startRound", subject: { kind: "none" } }];
const reveal: [string, Command] = ["po", { type: "reveal" }];

function votingRoom(anonymous: boolean) {
  return run(votingRoomSteps(anonymous));
}

describe("toSnapshot", () => {
  it("carries the protocol, the version, the server clock and the room code", () => {
    const { state } = run([join("po")]);
    const snapshot = toSnapshot(state, "po", META);
    expect(snapshot).toMatchObject({
      protocol: PROTOCOL_VERSION,
      version: 7,
      serverNow: T + 99,
      room: { code: "roomcode", ownerId: "po", round: null, you: "po" },
      causes: [],
    });
    expect(snapshot.room.settings).toStrictEqual(state.settings);
    expect(snapshot.room.settings).not.toBe(state.settings);
  });

  it("lists participants by join time then id, with presence and ownership, nothing else", () => {
    const { state } = run([join("po"), join("z"), join("a")]);
    const tied: RoomState = {
      ...state,
      participants: {
        ...state.participants,
        // Same join time as "a": the id breaks the tie.
        b: { name: "bee", role: "observer", joinedAt: T + 2, connected: true, avatar: "fox" },
        z: { name: "zed", role: "voter", joinedAt: T + 1, connected: false, awaySince: T + 50 },
      },
    };
    const { room } = toSnapshot(tied, "nobody", META);
    expect(room.you).toBeNull();
    expect(room.participants).toStrictEqual([
      { id: "po", name: "name po", role: "voter", connected: true, away: false, isOwner: true },
      { id: "z", name: "zed", role: "voter", connected: false, away: true, isOwner: false },
      { id: "a", name: "name a", role: "voter", connected: true, away: false, isOwner: false },
      {
        id: "b",
        name: "bee",
        role: "observer",
        avatar: "fox",
        connected: true,
        away: false,
        isOwner: false,
      },
    ]);
  });

  it("while Voting, shows who voted in participant order and only the viewer's own card", () => {
    const { state } = votingRoom(false);
    const forB = toSnapshot(state, "b", META).room.round;
    expect(forB).toStrictEqual({
      number: 1,
      subject: { kind: "none" },
      startedAt: T + 5,
      deck: { kind: "preset", id: "fib" },
      specials: ["?", "☕"],
      voted: ["po", "c", "b"],
      yourVote: "8",
      phase: "voting",
      anonymous: false,
    });
    const forObserver = toSnapshot(state, "o", META).room.round;
    expect(forObserver).not.toHaveProperty("yourVote");
    expect(JSON.stringify(forObserver)).not.toMatch(/"(8|3)"/);
  });

  it("carries a running timer's deadline", () => {
    const { state } = run([join("po"), start, ["po", { type: "startTimer", seconds: 30 }]]);
    expect(toSnapshot(state, "po", META).room.round).toMatchObject({
      deadlineAt: T + 2 + 30_000,
      timerStartedAt: T + 2,
    });
  });

  it("says that time is up while the round waits for the PO (#27)", () => {
    const { state } = run([
      join("po"),
      ["po", { type: "updateSettings", patch: { timer: { revealAtEnd: false } } }],
      start,
      ["po", { type: "startTimer", seconds: 5 }],
    ]);
    const up = apply(state, { type: "timeUp" }, { actor: "po", now: T + 3 + 5_000 });
    const round = toSnapshot(up.state, "po", META).room.round;
    expect(round).toMatchObject({ phase: "voting", timeUpAt: T + 3 + 5_000 });
    expect(round).not.toHaveProperty("deadlineAt");
    expect(round).not.toHaveProperty("timerStartedAt");
  });

  it("after a named reveal, lists every vote with its voter and the results", () => {
    const { state, causes } = run([
      ...votingRoomSteps(false),
      reveal,
      vote("c", "5"),
      ["po", { type: "setFinal", card: "5" }],
    ]);
    const snapshot = toSnapshot(state, "o", { ...META, causes });
    expect(snapshot.room.round).toMatchObject({
      phase: "revealed",
      anonymous: false,
      revealedAt: T + 9,
      final: "5",
      voted: ["po", "c", "b"],
      votes: [
        { who: "po", card: "?", changedAfterReveal: false },
        { who: "c", card: "5", changedAfterReveal: true },
        { who: "b", card: "8", changedAfterReveal: false },
      ],
      results: { core: ["5", "8"], distribution: expect.any(Array) },
    });
    expect(snapshot.room.round).not.toHaveProperty("cards");
    expect(snapshot.causes).toStrictEqual([{ type: "finalSet", card: "5" }]);
  });

  it("after an anonymous reveal, shows the cards in deck order and who voted, never who played what", () => {
    const { state } = run([...votingRoomSteps(true), reveal]);
    const round = toSnapshot(state, "c", META).room.round;
    expect(round).toMatchObject({
      phase: "revealed",
      anonymous: true,
      voted: ["po", "c", "b"],
      cards: ["3", "8", "?"],
      yourVote: "3",
      results: { core: ["3", "8"] },
    });
    expect(round).not.toHaveProperty("votes");
    expect(toSnapshot(state, "o", META).room.round).not.toHaveProperty("yourVote");
  });

  it("names a voter who left after a named reveal by the name the vote kept (#19)", () => {
    const { state } = run([...votingRoomSteps(false), reveal, ["b", { type: "leave" }]]);
    const round = toSnapshot(state, "o", META).room.round;
    expect(round).toMatchObject({
      voted: ["po", "c", "b"],
      votes: [
        { who: "po", card: "?", changedAfterReveal: false },
        { who: "c", card: "3", changedAfterReveal: false },
        { who: "b", card: "8", changedAfterReveal: false, name: "name b" },
      ],
    });
    // Someone back in the room is named by the participants alone.
    const back = run([["b", { type: "join", name: "back again", role: "voter" }]], state).state;
    const again = toSnapshot(back, "o", META).room.round;
    expect(again && "votes" in again ? again.votes : []).toContainEqual({
      who: "b",
      card: "8",
      changedAfterReveal: false,
    });
  });

  it("keeps a departed voter's card after an anonymous reveal, so leaving names nobody", () => {
    const { state } = run([...votingRoomSteps(true), reveal, ["b", { type: "leave" }]]);
    const round = toSnapshot(state, "o", META).room.round;
    expect(round).toMatchObject({ voted: ["po", "c", "b"], cards: ["3", "8", "?"] });
  });

  it("keeps the cards of an anonymous round fixed after reveal: a change is refused", () => {
    const frames = watch([...votingRoomSteps(true), reveal, vote("c", "13")]);
    const change = frames.at(-1);
    expect(change?.error).toBe("round_revealed");
    expect(change?.causes).toStrictEqual([]);
    expect(cardsOf(change)).toStrictEqual(["3", "8", "?"]);
  });
});

/**
 * The review of #68: when changes after an anonymous reveal were allowed, the set of
 * people who could still change shrank as voters left or the PO stopped voting, and the
 * next change tied the changer to both cards. Both scenarios, as the observer `o` sees them.
 */
describe("an anonymous round locks its votes at reveal", () => {
  const anonymousWithChanges = {
    revealNames: false,
    allowChangeAfterReveal: true,
    revealWhenAllVoted: false,
  };

  it("a voter leaving after the reveal lets nobody change a card", () => {
    const frames = watch([
      join("po"),
      join("a"),
      join("b"),
      join("o", "observer"),
      settings({ ...anonymousWithChanges, poVotes: false }),
      start,
      vote("a", "3"),
      vote("b", "8"),
      reveal,
      ["a", { type: "leave" }],
      vote("b", "13"),
    ]);
    const [revealed, left, change] = frames.slice(-3);
    expect(frames.slice(0, -1).map((f) => f.error)).toStrictEqual(
      frames.slice(0, -1).map(() => undefined),
    );
    expect(change?.error).toBe("round_revealed");
    expect(change?.causes).toStrictEqual([]);
    for (const frame of [revealed, left, change]) expect(cardsOf(frame)).toStrictEqual(["3", "8"]);
  });

  it("the PO turning poVotes off after the reveal lets nobody change a card", () => {
    const frames = watch([
      join("po"),
      join("b"),
      join("o", "observer"),
      settings(anonymousWithChanges),
      start,
      vote("po", "3"),
      vote("b", "8"),
      reveal,
      settings({ poVotes: false }),
      vote("b", "13"),
    ]);
    const [revealed, poOut, change] = frames.slice(-3);
    expect(frames.slice(0, -1).map((f) => f.error)).toStrictEqual(
      frames.slice(0, -1).map(() => undefined),
    );
    expect(change?.error).toBe("round_revealed");
    expect(change?.causes).toStrictEqual([]);
    for (const frame of [revealed, poOut, change]) expect(cardsOf(frame)).toStrictEqual(["3", "8"]);
  });
});

type Seen = {
  error: string | undefined;
  round: Snapshot["room"]["round"];
  causes: Snapshot["causes"];
};

/** Runs the steps like `run` but past refusals, keeping what `viewer` sees after each one. */
function watch(steps: ReadonlyArray<[string, Command]>, viewer = "o"): Seen[] {
  let state = createRoom({ ownerId: "po" });
  return steps.map(([actor, command], i) => {
    const result = apply(state, command, { actor, now: T + i });
    state = result.state;
    const { room, causes } = toSnapshot(state, viewer, { ...META, causes: result.causes });
    return { error: result.ok ? undefined : result.error, round: room.round, causes };
  });
}

const cardsOf = (seen: Seen | undefined) =>
  seen?.round && "cards" in seen.round ? seen.round.cards : undefined;

/** Four people joined (`c` before `b`); `b`, `po` and `c` voted, in that order. */
function votingRoomSteps(anonymous: boolean): Array<[string, Command]> {
  return [
    join("po"),
    join("c"),
    join("b"),
    join("o", "observer"),
    settings({ revealNames: !anonymous, revealWhenAllVoted: false, allowChangeAfterReveal: true }),
    start,
    vote("b", "8"),
    vote("po", "?"),
    vote("c", "3"),
  ];
}

describe("projectCauses", () => {
  const anonymousRevealed = run([...votingRoomSteps(true), reveal]).state.round;
  const anonymousVoting = votingRoom(true).state.round;

  it("strips the voter from vote causes in an anonymous round after reveal, even if the domain sent one", () => {
    const causes: Cause[] = [
      { type: "voteCast", who: "c" },
      { type: "voteRetracted", who: "b" },
      { type: "joined", who: "d" },
    ];
    expect(projectCauses(causes, anonymousRevealed)).toStrictEqual([
      { type: "voteCast" },
      { type: "voteRetracted" },
      { type: "joined", who: "d" },
    ]);
  });

  it("keeps who revealed after an anonymous reveal: it ties nobody to a card (#28)", () => {
    expect(
      projectCauses([{ type: "revealed", by: "manual", who: "c" }], anonymousRevealed),
    ).toStrictEqual([{ type: "revealed", by: "manual", who: "c" }]);
  });

  it("keeps the voter while Voting: others learn who voted, never what", () => {
    expect(projectCauses([{ type: "voteCast", who: "c" }], anonymousVoting)).toStrictEqual([
      { type: "voteCast", who: "c" },
    ]);
    expect(projectCauses([{ type: "voteRetracted" }], null)).toStrictEqual([
      { type: "voteRetracted" },
    ]);
  });

  it("copies every cause field by field: an extra field never travels, an unknown cause is dropped", () => {
    const sneaky = [
      { type: "voteCast", who: "c", card: "8" },
      { type: "revealed", by: "timer", votes: { c: "8" } },
      { type: "revealed", by: "manual", who: "c", card: "8" },
      { type: "secret", card: "8" },
      { type: "roundStarted", number: 2, restarted: true },
      { type: "roundStarted", number: 3 },
      { type: "roundStarted", number: 4, revote: true, subject: "Login" },
      { type: "roleChanged", who: "c", role: "observer" },
      { type: "ownerChanged", by: "claim", to: "c" },
      { type: "timerStarted" },
      { type: "finalSet", card: "8" },
      { type: "away", who: "c", name: "Cy", card: "8" },
      { type: "back", who: "c", awaySince: 1 },
    ] as unknown as Cause[];
    expect(projectCauses(sneaky, anonymousVoting)).toStrictEqual([
      { type: "voteCast", who: "c" },
      { type: "revealed", by: "timer" },
      { type: "revealed", by: "manual", who: "c" },
      { type: "roundStarted", number: 2, restarted: true },
      { type: "roundStarted", number: 3 },
      { type: "roundStarted", number: 4, revote: true },
      { type: "roleChanged", who: "c", role: "observer" },
      { type: "ownerChanged", by: "claim", to: "c" },
      { type: "timerStarted" },
      { type: "finalSet", card: "8" },
      { type: "away", who: "c" },
      { type: "back", who: "c" },
    ]);
  });
});

describe("ownerClaimableAt (#30)", () => {
  const away = (since: number): RoomState => {
    const { state } = run([join("po"), join("a")]);
    const po = state.participants.po;
    if (!po) throw new Error("no PO");
    return { ...state, participants: { ...state.participants, po: { ...po, awaySince: since } } };
  };

  it("is absent while the PO is here", () => {
    const { state } = run([join("po"), join("a")]);
    expect("ownerClaimableAt" in toSnapshot(state, "a", META).room).toBe(false);
  });

  it("is two minutes after the PO went away, the same for everyone", () => {
    const state = away(T + 5);
    for (const viewer of ["a", "po", "stranger"]) {
      expect(toSnapshot(state, viewer, META).room.ownerClaimableAt).toBe(
        T + 5 + OWNER_CLAIM_AFTER_MS,
      );
    }
  });

  it("is 0 when the PO is not in the room: the role can be claimed at once", () => {
    const { state } = run([join("po"), join("a"), ["po", { type: "leave" }]]);
    expect(toSnapshot(state, "a", META).room.ownerClaimableAt).toBe(0);
  });
});

describe("the PO in every snapshot (#30)", () => {
  it("at most one participant is the PO, the owner when present; a claim succeeds from ownerClaimableAt on, never before", () => {
    fc.assert(
      fc.property(scenarioArb, (steps) => {
        for (const frame of play(steps)) {
          const { state } = frame;
          const ownerHere = Object.hasOwn(state.participants, state.ownerId);
          for (const viewer of VIEWERS) {
            const { room } = snapshotSchema.parse(toSnapshot(state, viewer, meta(frame)));
            const owners = room.participants.filter((p) => p.isOwner).map((p) => p.id);
            expect(owners).toEqual(ownerHere ? [state.ownerId] : []);
            expect(room.ownerId).toBe(state.ownerId);
          }
          const at = toSnapshot(state, OWNER, meta(frame)).room.ownerClaimableAt;
          const claimant = PEOPLE.find(
            (id) => id !== state.ownerId && Object.hasOwn(state.participants, id),
          );
          if (claimant === undefined) continue;
          const claim = (now: number) =>
            apply(state, { type: "claimOwner" }, { actor: claimant, now }).ok;
          if (at === undefined) {
            expect(claim(frame.now + 10 * OWNER_CLAIM_AFTER_MS)).toBe(false);
          } else {
            expect(claim(Math.max(at, frame.now))).toBe(true);
            if (at > frame.now) expect(claim(at - 1)).toBe(false);
          }
        }
      }),
      { numRuns: 150 },
    );
  });
});
