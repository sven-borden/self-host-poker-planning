import { describe, expect, it } from "vitest";
import { apply } from "./apply.ts";
import type { ApplyResult, Cause, Command, ErrorCode } from "./commands.ts";
import {
  createRoom,
  DEFAULT_SETTINGS,
  MAX_MEMBERS,
  MAX_PARTICIPANTS,
  OWNER_CLAIM_AFTER_MS,
  type Participant,
  type RoomSettings,
  type RoomState,
  type Round,
} from "./room.ts";

const T0 = 1_700_000_000_000;
const PO = "po";
const A = "alice";
const B = "bob";
const OBS = "olga";
const OUT = "stranger";

/** Freezes the input deeply: any mutation inside `apply` throws (modules are strict). */
function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const inner of Object.values(value)) deepFreeze(inner);
  }
  return value;
}

const person = (name: string, extra: Partial<Participant> = {}): Participant => ({
  name,
  role: "voter",
  joinedAt: T0 - 60_000,
  connected: true,
  ...extra,
});

function voting(extra: Partial<Round> = {}): Round {
  return {
    number: 1,
    subject: { kind: "title", text: "Login page" },
    phase: "voting",
    deck: { kind: "preset", id: "fib" },
    specials: ["?", "☕"],
    anonymous: false,
    votes: {},
    startedAt: T0 - 30_000,
    ...extra,
  };
}

function revealed(extra: Partial<Round> = {}): Round {
  return voting({ phase: "revealed", revealedAt: T0 - 1_000, ...extra });
}

/** PO, Alice and Bob vote; Olga observes. A round is voting unless said otherwise. */
function room(
  opts: {
    settings?: Partial<RoomSettings>;
    participants?: Record<string, Participant>;
    round?: Round | null;
    ownerId?: string;
  } = {},
): RoomState {
  return {
    ownerId: opts.ownerId ?? PO,
    settings: { ...createRoom({ ownerId: PO }).settings, ...opts.settings },
    participants: opts.participants ?? {
      [PO]: person("Pia"),
      [A]: person("Alice"),
      [B]: person("Bob"),
      [OBS]: person("Olga", { role: "observer" }),
    },
    round: opts.round === undefined ? voting() : opts.round,
  };
}

/** The PO plus `voters - 1` voters, plus `observers` observers. */
function crowd(voters: number, observers = 0): Record<string, Participant> {
  const out: Record<string, Participant> = { [PO]: person("Pia") };
  for (let i = 1; i < voters; i++) out[`v${i}`] = person(`V${i}`);
  for (let i = 0; i < observers; i++) out[`o${i}`] = person(`O${i}`, { role: "observer" });
  return out;
}

function send(state: RoomState, command: unknown, actor = PO, now = T0): ApplyResult {
  return apply(deepFreeze(state), command as Command, { actor, now });
}

/** A successful result's state, or the test fails. */
function ok(result: ApplyResult): RoomState {
  expect(result).toMatchObject({ ok: true });
  return result.state;
}

const reveals = (causes: Cause[]) => causes.filter((c) => c.type === "revealed");

describe("createRoom", () => {
  it("starts with the ADR-011 defaults, nobody inside and no round", () => {
    expect(createRoom({ ownerId: PO })).toEqual({
      ownerId: PO,
      settings: {
        deck: { kind: "preset", id: "fib" },
        specials: ["?", "☕"],
        whoCanReveal: "po",
        revealNames: true,
        revealWhenAllVoted: true,
        timer: { seconds: null, revealAtEnd: true },
        allowChangeAfterReveal: false,
        poVotes: true,
        observersCount: true,
      },
      participants: {},
      round: null,
    });
  });

  it("copies the frozen defaults", () => {
    const { settings } = createRoom({ ownerId: PO });
    expect(Object.isFrozen(DEFAULT_SETTINGS.timer)).toBe(true);
    expect(settings.timer).not.toBe(DEFAULT_SETTINGS.timer);
    expect(settings.specials).not.toBe(DEFAULT_SETTINGS.specials);
    expect(settings.deck).not.toBe(DEFAULT_SETTINGS.deck);
  });
});

describe("refusals", () => {
  const lobby = () => room({ round: null });
  const afterReveal = () => room({ round: revealed({ votes: { [A]: { card: "3" } } }) });
  const join = (name: unknown, role: unknown = "voter") => ({ type: "join", name, role });
  const ownerOnly: unknown[] = [
    { type: "kick", who: B },
    { type: "startRound", subject: { kind: "none" } },
    { type: "setFinal", card: "3" },
    { type: "revote" },
    { type: "startTimer", seconds: 30 },
    { type: "stopTimer" },
    { type: "extendTimer", seconds: 30 },
    { type: "updateSettings", patch: {} },
    { type: "transferOwner", to: B },
  ];
  const badNames: unknown[] = [
    "",
    "   ",
    "x".repeat(33),
    "Al\u0007ice",
    "\n\t\r",
    "‮ecila",
    "​​",
    "Al\uD800ice",
    "\uDC00",
    42,
    undefined,
  ];
  const badSubjects: unknown[] = [
    null,
    [],
    { kind: "epic" },
    { kind: "title", text: "" },
    { kind: "title", text: "x".repeat(201) },
    { kind: "title", text: 5 },
    { kind: "title", text: "a\u0000b" },
    { kind: "title", text: "Login \uD83D page" },
    { kind: "link", url: "https://example.com/\uD800" },
    { kind: "link", url: "ftp://example.com" },
    { kind: "link", url: "javascript:alert(1)" },
    { kind: "link", url: "https://" },
    { kind: "link", url: "https://good.example@evil.example/x" },
    { kind: "link", url: "https://exa mple.com" },
    { kind: "link", url: "https://example.com/a​b" },
    { kind: "link", url: `https://example.com/${"a".repeat(1981)}` },
    { kind: "link", url: 7 },
    { kind: "link" },
  ];
  const badPatches: unknown[] = [
    null,
    [],
    "fib",
    { colour: "red" },
    { deck: "fib" },
    { deck: { kind: "preset", id: "huge" } },
    { deck: { kind: "custom" } },
    { deck: { kind: "custom", cards: [1] } },
    { deck: { kind: "other" } },
    { specials: "?" },
    { specials: ["!"] },
    { specials: [1] },
    { specials: ["?", "?"] },
    { whoCanReveal: "everyone" },
    { revealNames: "yes" },
    { poVotes: null },
    { timer: null },
    { timer: [] },
    { timer: { speed: 1 } },
    { timer: { seconds: 4 } },
    { timer: { seconds: "60" } },
    { timer: { revealAtEnd: 1 } },
  ];

  const rows: Array<[string, () => RoomState, unknown, string, ErrorCode]> = [
    ["an unknown command", room, { type: "dance" }, PO, "bad_command"],
    ["a null command", room, null, PO, "bad_command"],
    ["a null command from outside", room, null, OUT, "bad_command"],
    ["an undefined command", room, undefined, PO, "bad_command"],
    ["a string command", room, "castVote", A, "bad_command"],
    ["a number command", room, 42, A, "bad_command"],
    ["an array command", room, [{ type: "leave" }], A, "bad_command"],
    ["a vote from outside", room, { type: "castVote", card: "3" }, OUT, "not_participant"],
    ["a leave from outside", room, { type: "leave" }, OUT, "not_participant"],
    ["a prototype key as actor", room, { type: "leave" }, "__proto__", "not_participant"],
    ...ownerOnly.map(
      (c) =>
        [`${(c as Command).type} by a voter`, room, c, A, "not_owner"] as [
          string,
          () => RoomState,
          unknown,
          string,
          ErrorCode,
        ],
    ),
    ["joining twice", room, join("Alice again"), A, "already_joined"],
    ...badNames.map(
      (n) =>
        [`the name ${JSON.stringify(n)}`, room, join(n), OUT, "bad_name"] as [
          string,
          () => RoomState,
          unknown,
          string,
          ErrorCode,
        ],
    ),
    ["an empty rename", room, { type: "rename", name: " " }, A, "bad_name"],
    [
      "a 2-character name of 100 002 code units",
      room,
      join(`a${"\u0301".repeat(50_000)}`.repeat(2)),
      OUT,
      "bad_name",
    ],
    [
      "a 1-character name of 513 code units",
      room,
      { type: "rename", name: `a${"\u0301".repeat(513)}` },
      A,
      "bad_name",
    ],
    [
      "a 1-character title of 200 001 code units",
      room,
      { type: "startRound", subject: { kind: "title", text: `a${"\u0301".repeat(200_000)}` } },
      PO,
      "bad_subject",
    ],
    ["joining as PO", room, join("Xavier", "po"), OUT, "bad_role"],
    ["an unknown role", room, { type: "setRole", role: "admin" }, A, "bad_role"],
    [
      "a 17th voter",
      () => room({ participants: crowd(MAX_PARTICIPANTS) }),
      join("Xavier"),
      OUT,
      "room_full",
    ],
    [
      "a 17th person who observes, observers counting",
      () => room({ participants: crowd(15, 1) }),
      join("Xavier", "observer"),
      OUT,
      "room_full",
    ],
    [
      "a 33rd member, observers not counting",
      () => room({ settings: { observersCount: false }, participants: crowd(16, 16) }),
      join("Xavier", "observer"),
      OUT,
      "room_full",
    ],
    [
      "an observer taking a 17th seat",
      () => room({ settings: { observersCount: false }, participants: crowd(16, 1) }),
      { type: "setRole", role: "voter" },
      "o0",
      "room_full",
    ],
    [
      "counting observers when that makes 17",
      () => room({ settings: { observersCount: false }, participants: crowd(16, 1) }),
      { type: "updateSettings", patch: { observersCount: true } },
      PO,
      "room_full",
    ],
    ["kicking oneself", room, { type: "kick", who: PO }, PO, "cannot_kick_self"],
    ["kicking a stranger", room, { type: "kick", who: OUT }, PO, "unknown_participant"],
    [
      "kicking a prototype key",
      room,
      { type: "kick", who: "constructor" },
      PO,
      "unknown_participant",
    ],
    ...badSubjects.map(
      (subject) =>
        [
          `the subject ${JSON.stringify(subject)}`,
          room,
          { type: "startRound", subject },
          PO,
          "bad_subject",
        ] as [string, () => RoomState, unknown, string, ErrorCode],
    ),
    ["a vote in the lobby", lobby, { type: "castVote", card: "3" }, A, "no_round"],
    [
      "a vote made for the last round",
      () => room({ round: voting({ number: 2 }) }),
      { type: "castVote", card: "3", round: 1 },
      A,
      "round_changed",
    ],
    [
      "a vote made for the last round, now revealed too",
      () => room({ round: revealed({ number: 2 }) }),
      { type: "castVote", card: "3", round: 1 },
      A,
      "round_changed",
    ],
    [
      "a retract made for the last round",
      () => room({ round: voting({ number: 2, votes: { [A]: { card: "3" } } }) }),
      { type: "retractVote", round: 1 },
      A,
      "round_changed",
    ],
    [
      "a retract made for the last round, now revealed too",
      () => room({ round: revealed({ number: 2 }) }),
      { type: "retractVote", round: 1 },
      A,
      "round_changed",
    ],
    [
      "a retract made for a round in the lobby",
      lobby,
      { type: "retractVote", round: 1 },
      A,
      "not_voting",
    ],
    ["a vote from an observer", room, { type: "castVote", card: "3" }, OBS, "not_voter"],
    [
      "a vote from a PO who does not vote",
      () => room({ settings: { poVotes: false } }),
      { type: "castVote", card: "3" },
      PO,
      "not_voter",
    ],
    ["a card outside the deck", room, { type: "castVote", card: "4" }, A, "bad_card"],
    ["a special that is off", room, { type: "castVote", card: "∞" }, A, "bad_card"],
    ["a number as card", room, { type: "castVote", card: 3 }, A, "bad_card"],
    [
      "a card outside the round's custom deck",
      () => room({ round: voting({ deck: { kind: "custom", cards: ["S", "M"] } }) }),
      { type: "castVote", card: "3" },
      A,
      "bad_card",
    ],
    ["a vote after reveal", afterReveal, { type: "castVote", card: "5" }, A, "round_revealed"],
    [
      "a change after an anonymous reveal, even with changes allowed",
      () =>
        room({
          settings: { allowChangeAfterReveal: true },
          round: revealed({ anonymous: true, votes: { [A]: { card: "3" } } }),
        }),
      { type: "castVote", card: "5" },
      A,
      "round_revealed",
    ],
    ["a reveal in the lobby", lobby, { type: "reveal" }, PO, "not_voting"],
    ["a second reveal", afterReveal, { type: "reveal" }, PO, "not_voting"],
    ["a retract in the lobby", lobby, { type: "retractVote" }, A, "not_voting"],
    ["a retract after reveal", afterReveal, { type: "retractVote" }, A, "not_voting"],
    ["a timer in the lobby", lobby, { type: "startTimer", seconds: 30 }, PO, "not_voting"],
    ["a timer after reveal", afterReveal, { type: "startTimer", seconds: 30 }, PO, "not_voting"],
    ["a reveal by a voter", room, { type: "reveal" }, A, "not_allowed"],
    ["a final while voting", room, { type: "setFinal", card: "3" }, PO, "not_revealed"],
    ["a final in the lobby", lobby, { type: "setFinal", card: "3" }, PO, "not_revealed"],
    ["a revote while voting", room, { type: "revote" }, PO, "not_revealed"],
    ["a revote in the lobby", lobby, { type: "revote" }, PO, "not_revealed"],
    ["a special as final", afterReveal, { type: "setFinal", card: "?" }, PO, "bad_card"],
    ["an off-deck final", afterReveal, { type: "setFinal", card: "4" }, PO, "bad_card"],
    ["a number as final", afterReveal, { type: "setFinal", card: 3 }, PO, "bad_card"],
    ["a 4 s timer", room, { type: "startTimer", seconds: 4 }, PO, "bad_seconds"],
    ["a 3601 s timer", room, { type: "startTimer", seconds: 3601 }, PO, "bad_seconds"],
    ["a 2.5 s timer", room, { type: "startTimer", seconds: 2.5 }, PO, "bad_seconds"],
    ["a string timer", room, { type: "startTimer", seconds: "60" }, PO, "bad_seconds"],
    [
      "a zero extension",
      () => room({ round: voting({ deadlineAt: T0 + 10_000 }) }),
      { type: "extendTimer", seconds: 0 },
      PO,
      "bad_seconds",
    ],
    ["extending no timer", room, { type: "extendTimer", seconds: 30 }, PO, "no_timer"],
    ["extending in the lobby", lobby, { type: "extendTimer", seconds: 30 }, PO, "no_timer"],
    ["handing over to oneself", room, { type: "transferOwner", to: PO }, PO, "target_not_present"],
    [
      "handing over to a stranger",
      room,
      { type: "transferOwner", to: OUT },
      PO,
      "target_not_present",
    ],
    [
      "handing over to a prototype key",
      room,
      { type: "transferOwner", to: "toString" },
      PO,
      "target_not_present",
    ],
    [
      "handing over to someone away",
      () =>
        room({
          participants: { [PO]: person("Pia"), [A]: person("Alice", { awaySince: T0 - 1 }) },
        }),
      { type: "transferOwner", to: A },
      PO,
      "target_not_present",
    ],
    ["the PO claiming", room, { type: "claimOwner" }, PO, "already_owner"],
    ["claiming from a present PO", room, { type: "claimOwner" }, A, "owner_present"],
    [
      "claiming from a disconnected PO in the grace period",
      () =>
        room({
          participants: { [PO]: person("Pia", { connected: false }), [A]: person("Alice") },
        }),
      { type: "claimOwner" },
      A,
      "owner_present",
    ],
    ...badPatches.map(
      (patch) =>
        [
          `the patch ${JSON.stringify(patch)}`,
          room,
          { type: "updateSettings", patch },
          PO,
          "bad_settings",
        ] as [string, () => RoomState, unknown, string, ErrorCode],
    ),
    [
      "an empty custom deck",
      room,
      { type: "updateSettings", patch: { deck: { kind: "custom", cards: [] } } },
      PO,
      "deck_empty",
    ],
    ...(
      [
        ["21 custom cards", Array.from({ length: 21 }, (_, i) => String(i)), "deck_too_many_cards"],
        ["a blank custom card", ["1", "  "], "card_empty"],
        ["a custom card with a zero-width space", ["1​"], "card_invalid"],
        ["a 5-character custom card", ["12345"], "card_too_long"],
        ["a special as custom card", ["1", "?"], "card_special"],
      ] as const
    ).map(
      ([label, cards, code]) =>
        [
          label,
          room,
          { type: "updateSettings", patch: { deck: { kind: "custom", cards } } },
          PO,
          code,
        ] as [string, () => RoomState, unknown, string, ErrorCode],
    ),
    [
      "a custom card with a lone surrogate",
      room,
      { type: "updateSettings", patch: { deck: { kind: "custom", cards: ["1", "\uD800"] } } },
      PO,
      "card_invalid",
    ],
    [
      "a custom deck with 1 and 1.0",
      room,
      { type: "updateSettings", patch: { deck: { kind: "custom", cards: ["1", "1.0"] } } },
      PO,
      "card_duplicate",
    ],
  ];

  it.each(rows)("refuses %s", (_, make, command, actor, error) => {
    const state = make();
    const result = send(state, command, actor);
    expect(result).toEqual({ ok: false, error, state, causes: [] });
    expect(result.state).toBe(state);
  });
});

describe("membership", () => {
  it("lets a stranger join with a trimmed name", () => {
    const before = room();
    const result = send(before, { type: "join", name: "  Xavier ", role: "observer" }, OUT);
    expect(result.causes).toEqual([{ type: "joined", who: OUT }]);
    expect(ok(result).participants[OUT]).toEqual({
      name: "Xavier",
      role: "observer",
      joinedAt: T0,
      connected: true,
    });
  });

  it("collapses whitespace runs in names and titles, line breaks included", () => {
    expect(
      ok(send(room(), { type: "rename", name: "\tAlice \n  Smith " }, A)).participants[A]?.name,
    ).toBe("Alice Smith");
    const subject = { kind: "title", text: "PROJ-12\r\nFix the\tlogin   page\n" };
    expect(ok(send(room(), { type: "startRound", subject })).round?.subject).toEqual({
      kind: "title",
      text: "PROJ-12 Fix the login page",
    });
  });

  it("counts names in user-perceived characters", () => {
    const name = "👍🏽".repeat(32);
    expect(
      ok(send(room(), { type: "join", name, role: "voter" }, OUT)).participants[OUT]?.name,
    ).toBe(name);
  });

  it("accepts a name of up to 16 code units per character, and refuses a pile of marks", () => {
    // 32 family emoji: 11 code units each, under the 16 per character the cap allows.
    const family = "👨‍👩‍👧‍👦";
    const name = ok(send(room(), { type: "rename", name: family.repeat(32) }, A)).participants[A]
      ?.name;
    expect(name).toHaveLength(32 * family.length);
    // "a" plus 512 combining acute accents is one character, but not a name.
    expect(send(room(), { type: "rename", name: `a${"́".repeat(512)}` }, A)).toMatchObject({
      ok: false,
      error: "bad_name",
    });
  });

  it("seats the 16th person and, with observers not counting, the 32nd member", () => {
    ok(send(room({ participants: crowd(15) }), { type: "join", name: "X", role: "voter" }, OUT));
    ok(
      send(
        room({ participants: crowd(14, 1) }),
        { type: "join", name: "X", role: "observer" },
        OUT,
      ),
    );
    const notCounting = room({ settings: { observersCount: false }, participants: crowd(16, 15) });
    expect(Object.keys(notCounting.participants)).toHaveLength(MAX_MEMBERS - 1);
    ok(send(notCounting, { type: "join", name: "X", role: "observer" }, OUT));
    ok(
      send(
        room({ settings: { observersCount: false }, participants: crowd(15, 16) }),
        { type: "join", name: "X", role: "voter" },
        OUT,
      ),
    );
  });

  it("removes a leaving person and their vote while Voting; the PO stays owner", () => {
    const before = room({ round: voting({ votes: { [A]: { card: "3" } } }) });
    const alice = send(before, { type: "leave" }, A);
    expect(alice.causes).toEqual([
      { type: "left", who: A },
      { type: "voteRetracted", who: A },
    ]);
    expect(ok(alice).participants[A]).toBeUndefined();
    expect(alice.state.round?.votes).toEqual({});
    const po = ok(send(before, { type: "leave" }, PO));
    expect(po.ownerId).toBe(PO);
    expect(po.participants[PO]).toBeUndefined();
  });

  it("keeps the vote of someone who leaves after reveal", () => {
    const before = room({ round: revealed({ votes: { [A]: { card: "3" } } }) });
    expect(ok(send(before, { type: "leave" }, A)).round?.votes).toEqual({ [A]: { card: "3" } });
  });

  it("kicks a participant and their vote", () => {
    const before = room({ round: voting({ votes: { [A]: { card: "3" } } }) });
    const result = send(before, { type: "kick", who: A });
    expect(result.causes).toEqual([
      { type: "kicked", who: A },
      { type: "voteRetracted", who: A },
    ]);
    expect(ok(result).participants[A]).toBeUndefined();
    expect(result.state.round?.votes).toEqual({});
  });

  it("renames, and treats the same name as no change", () => {
    const before = room();
    const result = send(before, { type: "rename", name: " Alicia " }, A);
    expect(result.causes).toEqual([{ type: "renamed", who: A }]);
    expect(ok(result).participants[A]?.name).toBe("Alicia");
    const same = send(before, { type: "rename", name: "Alice" }, A);
    expect(same).toEqual({ ok: true, state: before, causes: [] });
    expect(same.state).toBe(before);
  });

  it("changes roles, dropping the vote of a voter who starts observing", () => {
    const before = room({ round: voting({ votes: { [A]: { card: "3" } } }) });
    const result = send(before, { type: "setRole", role: "observer" }, A);
    expect(result.causes).toEqual([
      { type: "roleChanged", who: A, role: "observer" },
      { type: "voteRetracted", who: A },
    ]);
    expect(ok(result).participants[A]?.role).toBe("observer");
    expect(result.state.round?.votes).toEqual({});
    expect(send(before, { type: "setRole", role: "voter" }, A).state).toBe(before);
  });

  it("lets an observer vote again without a capacity check when observers count", () => {
    const full = room({ participants: crowd(15, 1) });
    expect(ok(send(full, { type: "setRole", role: "voter" }, "o0")).participants.o0?.role).toBe(
      "voter",
    );
    const notCounting = room({ settings: { observersCount: false }, participants: crowd(15, 1) });
    ok(send(notCounting, { type: "setRole", role: "voter" }, "o0"));
  });

  it("looks up votes as own properties only", () => {
    const before = room({
      participants: { [PO]: person("Pia"), constructor: person("Con") },
    });
    expect(send(before, { type: "retractVote" }, "constructor").state).toBe(before);
  });
});

describe("rounds", () => {
  it("starts the first round from the lobby with the room's deck, specials and anonymity", () => {
    const before = room({
      round: null,
      settings: {
        deck: { kind: "custom", cards: ["S", "M", "L"] },
        specials: ["∞"],
        revealNames: false,
      },
    });
    const subject = { kind: "link", url: " https://example.com/browse/ABC-1 ", key: "XYZ-9" };
    const result = send(before, { type: "startRound", subject });
    expect(result.causes).toEqual([{ type: "roundStarted", number: 1 }]);
    expect(ok(result).round).toEqual({
      number: 1,
      subject: { kind: "link", url: "https://example.com/browse/ABC-1" },
      phase: "voting",
      deck: { kind: "custom", cards: ["S", "M", "L"] },
      specials: ["∞"],
      anonymous: true,
      votes: {},
      startedAt: T0,
    });
  });

  it("accepts the subject kinds at their limits", () => {
    const title = "é".repeat(200);
    expect(
      ok(send(room(), { type: "startRound", subject: { kind: "title", text: ` ${title} ` } })).round
        ?.subject,
    ).toEqual({ kind: "title", text: title });
    const url = `http://example.com/${"a".repeat(1981)}`;
    expect(url).toHaveLength(2000);
    expect(
      ok(send(room(), { type: "startRound", subject: { kind: "link", url } })).round?.subject,
    ).toEqual({ kind: "link", url });
    expect(
      ok(
        send(room(), { type: "startRound", subject: { kind: "link", url: "HTTPS://example.com" } }),
      ).round?.subject,
    ).toEqual({ kind: "link", url: "HTTPS://example.com" });
    expect(
      ok(send(room(), { type: "startRound", subject: { kind: "none" } })).round?.subject,
    ).toEqual({
      kind: "none",
    });
  });

  it("abandons a voting round: next number, new subject, no votes", () => {
    const before = room({
      round: voting({ number: 3, votes: { [A]: { card: "8" } }, deadlineAt: T0 + 9 }),
    });
    const result = send(before, { type: "startRound", subject: { kind: "title", text: "Fixed" } });
    expect(result.causes).toEqual([{ type: "roundStarted", number: 4 }]);
    expect(ok(result).round).toMatchObject({
      number: 4,
      subject: { kind: "title", text: "Fixed" },
      phase: "voting",
      votes: {},
    });
    expect(result.state.round?.deadlineAt).toBeUndefined();
  });

  it("starts the room's timer with every round", () => {
    const before = room({ settings: { timer: { seconds: 60, revealAtEnd: true } } });
    expect(
      ok(send(before, { type: "startRound", subject: { kind: "none" } })).round?.deadlineAt,
    ).toBe(T0 + 60_000);
  });

  it("casts, changes and retracts a vote without revealing it in the cause", () => {
    const cast = send(room(), { type: "castVote", card: "☕" }, A);
    expect(cast.causes).toEqual([{ type: "voteCast", who: A }]);
    expect(ok(cast).round?.votes).toEqual({ [A]: { card: "☕" } });
    const same = send(cast.state, { type: "castVote", card: "☕" }, A);
    expect(same.state).toBe(cast.state);
    expect(same.causes).toEqual([]);
    const changed = send(cast.state, { type: "castVote", card: "5" }, A);
    expect(ok(changed).round?.votes).toEqual({ [A]: { card: "5" } });
    const retracted = send(changed.state, { type: "retractVote" }, A);
    expect(retracted.causes).toEqual([{ type: "voteRetracted", who: A }]);
    expect(ok(retracted).round?.votes).toEqual({});
    expect(send(retracted.state, { type: "retractVote" }, A).state).toBe(retracted.state);
    expect(JSON.stringify([cast.causes, changed.causes, retracted.causes])).not.toMatch(/"5"|☕/);
  });

  it("takes a vote and a retract made for the current round", () => {
    const current = room({ round: voting({ number: 2 }) });
    const cast = send(current, { type: "castVote", card: "5", round: 2 }, A);
    expect(ok(cast).round?.votes).toEqual({ [A]: { card: "5" } });
    const retracted = send(cast.state, { type: "retractVote", round: 2 }, A);
    expect(ok(retracted).round?.votes).toEqual({});
  });

  it("validates votes against the round's cards, not the settings", () => {
    const before = room({
      settings: { deck: { kind: "preset", id: "tshirt" } },
      round: voting({ deck: { kind: "custom", cards: ["S", "M"] }, specials: [] }),
    });
    ok(send(before, { type: "castVote", card: "M" }, A));
    expect(send(before, { type: "castVote", card: "XL" }, A)).toMatchObject({ error: "bad_card" });
    expect(send(before, { type: "castVote", card: "?" }, A)).toMatchObject({ error: "bad_card" });
  });

  it("allows a change after reveal when the room allows it, marked as changed", () => {
    const before = room({
      settings: { allowChangeAfterReveal: true },
      round: revealed({ votes: { [A]: { card: "3" } } }),
    });
    const changed = send(before, { type: "castVote", card: "5" }, A);
    expect(changed.causes).toEqual([{ type: "voteCast", who: A }]);
    expect(ok(changed).round?.votes[A]).toEqual({ card: "5", changedAfterReveal: true });
    expect(send(before, { type: "castVote", card: "3" }, A).state).toBe(before);
    // Named round: a first vote after reveal is fine.
    expect(ok(send(before, { type: "castVote", card: "8" }, B)).round?.votes[B]).toEqual({
      card: "8",
      changedAfterReveal: true,
    });
  });

  it("locks the votes of an anonymous round at reveal, even when changes are allowed", () => {
    // Who may still change shrinks as people leave, so a change would point at someone.
    const anonymous = room({
      settings: { allowChangeAfterReveal: true, revealNames: false },
      round: revealed({ anonymous: true, votes: { [A]: { card: "3" }, [B]: { card: "8" } } }),
    });
    const change = send(anonymous, { type: "castVote", card: "5" }, A);
    expect(change).toMatchObject({ ok: false, error: "round_revealed", causes: [] });
    expect(change.state).toBe(anonymous);
    const first = send(anonymous, { type: "castVote", card: "5" }, PO);
    expect(first).toMatchObject({ ok: false, error: "round_revealed", causes: [] });
    expect(first.state).toBe(anonymous);
    // The round's own flag decides: turning names back on does not unlock it.
    const namesOn = room({
      settings: { allowChangeAfterReveal: true, revealNames: true },
      round: revealed({ anonymous: true, votes: { [A]: { card: "3" } } }),
    });
    const late = send(namesOn, { type: "castVote", card: "5" }, A);
    expect(late).toMatchObject({ ok: false, error: "round_revealed" });
    expect(late.state).toBe(namesOn);
  });

  it("names the voter in every vote cause; while Voting, an anonymous round says who voted, never what", () => {
    const votingRound = room({ round: voting({ anonymous: true }) });
    expect(send(votingRound, { type: "castVote", card: "5" }, A).causes).toStrictEqual([
      { type: "voteCast", who: A },
    ]);
  });

  it("reveals on the PO's command, with zero votes, stopping the timer", () => {
    const before = room({ round: voting({ deadlineAt: T0 + 30_000 }) });
    const result = send(before, { type: "reveal" });
    expect(result.causes).toEqual([{ type: "revealed", by: "manual" }]);
    const round = ok(result).round;
    expect(round).toMatchObject({ phase: "revealed", revealedAt: T0, votes: {} });
    expect(round && "deadlineAt" in round).toBe(false);
  });

  it("lets anyone reveal when the room says so", () => {
    const before = room({ settings: { whoCanReveal: "anyone" } });
    expect(send(before, { type: "reveal" }, A).causes).toEqual([
      { type: "revealed", by: "manual" },
    ]);
  });

  it("sets the final estimate once", () => {
    const before = room({ round: revealed({ votes: { [A]: { card: "3" } } }) });
    const result = send(before, { type: "setFinal", card: "5" });
    expect(result.causes).toEqual([{ type: "finalSet", card: "5" }]);
    expect(ok(result).round?.final).toBe("5");
    expect(send(result.state, { type: "setFinal", card: "5" }).state).toBe(result.state);
  });

  it("revotes: a new round with the same subject", () => {
    const before = room({ round: revealed({ number: 2, votes: { [A]: { card: "3" } } }) });
    const result = send(before, { type: "revote" });
    expect(result.causes).toEqual([{ type: "roundStarted", number: 3 }]);
    expect(ok(result).round).toMatchObject({
      number: 3,
      subject: { kind: "title", text: "Login page" },
      phase: "voting",
      votes: {},
    });
  });
});

describe("automatic reveal", () => {
  it("reveals exactly once when the two last votes arrive in a row", () => {
    const start = room({ round: voting({ votes: { [PO]: { card: "3" } } }) });
    const first = send(start, { type: "castVote", card: "5" }, A);
    expect(ok(first).round?.phase).toBe("voting");
    const second = send(first.state, { type: "castVote", card: "8" }, B, T0 + 1);
    expect(second.causes).toEqual([
      { type: "voteCast", who: B },
      { type: "revealed", by: "everyoneVoted" },
    ]);
    expect(ok(second).round).toMatchObject({ phase: "revealed", revealedAt: T0 + 1 });
    // Alice clicks again a moment later: refused, and no second reveal.
    const third = send(second.state, { type: "castVote", card: "8" }, A, T0 + 2);
    expect(third).toMatchObject({ ok: false, error: "round_revealed", causes: [] });
    expect(reveals([...first.causes, ...second.causes, ...third.causes])).toHaveLength(1);
  });

  it("ignores observers, away voters and a PO who does not vote", () => {
    const before = room({
      settings: { poVotes: false },
      participants: {
        [PO]: person("Pia"),
        [A]: person("Alice"),
        [B]: person("Bob", { awaySince: T0 - 5 }),
        [OBS]: person("Olga", { role: "observer" }),
      },
    });
    expect(reveals(send(before, { type: "castVote", card: "5" }, A).causes)).toHaveLength(1);
  });

  it("does not reveal when the setting is off or nobody can vote", () => {
    const off = room({
      settings: { revealWhenAllVoted: false },
      round: voting({ votes: { [PO]: { card: "3" }, [A]: { card: "3" } } }),
    });
    expect(ok(send(off, { type: "castVote", card: "5" }, B)).round?.phase).toBe("voting");
    const nobody = room({ participants: { [PO]: person("Pia", { role: "observer" }) } });
    expect(send(nobody, { type: "timeUp" }, OUT).state).toBe(nobody);
  });

  const twoOfThree = { [PO]: { card: "3" }, [A]: { card: "5" } };
  const completions: Array<[string, RoomState, unknown, string]> = [
    ["Bob leaving", room({ round: voting({ votes: twoOfThree }) }), { type: "leave" }, B],
    [
      "Bob being kicked",
      room({ round: voting({ votes: twoOfThree }) }),
      { type: "kick", who: B },
      PO,
    ],
    [
      "Bob starting to observe",
      room({ round: voting({ votes: twoOfThree }) }),
      { type: "setRole", role: "observer" },
      B,
    ],
    [
      "the setting being turned on",
      room({
        settings: { revealWhenAllVoted: false },
        round: voting({ votes: { ...twoOfThree, [B]: { card: "8" } } }),
      }),
      { type: "updateSettings", patch: { revealWhenAllVoted: true } },
      PO,
    ],
    [
      "the PO no longer voting",
      room({ round: voting({ votes: { [A]: { card: "5" }, [B]: { card: "8" } } }) }),
      { type: "updateSettings", patch: { poVotes: false } },
      PO,
    ],
    [
      "the owner handing over when the PO does not vote",
      room({
        settings: { poVotes: false },
        participants: { [PO]: person("Pia"), [A]: person("Alice") },
        round: voting({ votes: { [PO]: { card: "3" } } }),
      }),
      { type: "transferOwner", to: A },
      PO,
    ],
  ];

  it.each(completions)("can be completed by %s", (_, before, command, actor) => {
    const result = send(before, command, actor);
    expect(ok(result).round?.phase).toBe("revealed");
    expect(reveals(result.causes)).toEqual([{ type: "revealed", by: "everyoneVoted" }]);
  });

  it("drops the PO's vote while Voting when the PO stops voting", () => {
    const before = room({ round: voting({ votes: { [PO]: { card: "3" } } }) });
    const result = send(before, { type: "updateSettings", patch: { poVotes: false } });
    expect(result.causes).toEqual([
      { type: "settingsUpdated" },
      { type: "voteRetracted", who: PO },
    ]);
    expect(ok(result).round?.votes).toEqual({});
    expect(result.state.round?.phase).toBe("voting");
  });

  it("announces a dropped vote before the reveal it completes", () => {
    const before = room({
      settings: { revealWhenAllVoted: false },
      round: voting({ votes: { [PO]: { card: "3" }, [A]: { card: "5" }, [B]: { card: "8" } } }),
    });
    const result = send(before, {
      type: "updateSettings",
      patch: { revealWhenAllVoted: true, poVotes: false },
    });
    expect(result.causes).toEqual([
      { type: "settingsUpdated" },
      { type: "voteRetracted", who: PO },
      { type: "revealed", by: "everyoneVoted" },
    ]);
    expect(ok(result).round).toMatchObject({
      phase: "revealed",
      votes: { [A]: { card: "5" }, [B]: { card: "8" } },
    });
    expect(result.state.round?.votes[PO]).toBeUndefined();
  });
});

describe("timer", () => {
  const timed = (extra: Partial<RoomSettings> = {}) =>
    room({ settings: extra, round: voting({ deadlineAt: T0, votes: { [A]: { card: "3" } } }) });

  const firsts: Array<[string, unknown, string]> = [
    ["a vote", { type: "castVote", card: "5" }, B],
    ["a reveal", { type: "reveal" }, PO],
    ["a timeUp ping", { type: "timeUp" }, OUT],
    ["a new round", { type: "startRound", subject: { kind: "none" } }, PO],
    ["a refused command", { type: "kick", who: B }, A],
  ];

  it.each(firsts)(
    "reveals an elapsed deadline exactly once when %s arrives first",
    (_, command, actor) => {
      const first = send(timed(), command, actor, T0 + 5);
      expect(reveals(first.causes)).toEqual([{ type: "revealed", by: "timer" }]);
      if (first.state.round?.number === 1) {
        expect(first.state.round).toMatchObject({ phase: "revealed", revealedAt: T0 });
        expect(first.state.round.votes).toEqual({ [A]: { card: "3" } });
      }
      const second = send(first.state, { type: "timeUp" }, OUT, T0 + 10);
      expect(second.state).toBe(first.state);
      expect(second.causes).toEqual([]);
    },
  );

  it("keeps the timer reveal when the command itself is refused", () => {
    const result = send(timed(), { type: "castVote", card: "5" }, B, T0 + 5);
    expect(result).toMatchObject({ ok: false, error: "round_revealed" });
    expect(result.causes).toEqual([{ type: "revealed", by: "timer" }]);
    expect(result.state.round?.phase).toBe("revealed");
  });

  it("resolves at the deadline itself, not a millisecond before", () => {
    const before = timed();
    expect(send(before, { type: "timeUp" }, OUT, T0 - 1).state).toBe(before);
    expect(send(timed(), { type: "timeUp" }, OUT, T0).state.round?.phase).toBe("revealed");
  });

  it("only announces time up when the room does not reveal at the end", () => {
    const first = send(
      timed({ timer: { seconds: null, revealAtEnd: false } }),
      { type: "timeUp" },
      OUT,
      T0,
    );
    expect(first).toMatchObject({ ok: true, causes: [{ type: "timeUp" }] });
    expect(first.state.round?.phase).toBe("voting");
    expect(first.state.round?.deadlineAt).toBeUndefined();
    expect(send(first.state, { type: "timeUp" }, OUT, T0 + 1).state).toBe(first.state);
  });

  it("does nothing without a running deadline", () => {
    const lobby = room({ round: null });
    expect(send(lobby, { type: "timeUp" }, OUT).state).toBe(lobby);
    const plain = room();
    expect(send(plain, { type: "timeUp" }, OUT).state).toBe(plain);
    // A revealed round never holds a deadline; a stray one is ignored, not revealed again.
    const stray = room({ round: revealed({ deadlineAt: T0 - 1 }) });
    expect(send(stray, { type: "timeUp" }, OUT).state).toBe(stray);
  });

  it("starts, restarts, extends and stops the timer", () => {
    const started = send(room(), { type: "startTimer", seconds: 5 });
    expect(started.causes).toEqual([{ type: "timerStarted" }]);
    expect(ok(started).round?.deadlineAt).toBe(T0 + 5_000);
    const restarted = send(started.state, { type: "startTimer", seconds: 3600 }, PO, T0 + 1_000);
    expect(ok(restarted).round?.deadlineAt).toBe(T0 + 1_000 + 3_600_000);
    const extended = send(restarted.state, { type: "extendTimer", seconds: 30 }, PO, T0 + 2_000);
    expect(extended.causes).toEqual([{ type: "timerExtended" }]);
    expect(ok(extended).round?.deadlineAt).toBe(T0 + 1_000 + 3_600_000 + 30_000);
    const stopped = send(extended.state, { type: "stopTimer" }, PO, T0 + 3_000);
    expect(stopped.causes).toEqual([{ type: "timerStopped" }]);
    expect(ok(stopped).round?.deadlineAt).toBeUndefined();
    expect(send(stopped.state, { type: "stopTimer" }).state).toBe(stopped.state);
    const lobby = room({ round: null });
    expect(send(lobby, { type: "stopTimer" }).state).toBe(lobby);
  });

  it("treats a timer start that keeps the same deadline as no change", () => {
    const started = ok(
      send(room({ settings: { timer: { seconds: 30, revealAtEnd: true } } }), {
        type: "startRound",
        subject: { kind: "none" },
      }),
    );
    const again = send(started, { type: "startTimer", seconds: 30 });
    expect(again).toEqual({ ok: true, state: started, causes: [] });
    expect(again.state).toBe(started);
  });

  it("leaves a running timer alone when the timer setting changes", () => {
    const before = room({ round: voting({ deadlineAt: T0 + 10_000 }) });
    const result = send(before, { type: "updateSettings", patch: { timer: { seconds: 90 } } });
    expect(ok(result).settings.timer).toEqual({ seconds: 90, revealAtEnd: true });
    expect(result.state.round?.deadlineAt).toBe(T0 + 10_000);
  });
});

describe("ended", () => {
  it("reports the round a timer revealed when the next round replaces it in the same apply", () => {
    const voted = ok(send(room(), { type: "castVote", card: "3" }, A));
    const timed = ok(send(voted, { type: "startTimer", seconds: 30 }));
    const next = send(timed, { type: "startRound", subject: { kind: "none" } }, PO, T0 + 60_000);
    expect(next.causes).toEqual([
      { type: "revealed", by: "timer" },
      { type: "roundStarted", number: 2 },
    ]);
    expect(ok(next).round?.number).toBe(2);
    expect(next).toMatchObject({
      ended: {
        number: 1,
        phase: "revealed",
        revealedAt: T0 + 30_000,
        votes: { [A]: { card: "3" } },
      },
    });
  });

  it("reports a revoted round and an abandoned voting round as they were", () => {
    const shown = room({ round: revealed({ votes: { [A]: { card: "3" } } }) });
    expect(send(shown, { type: "revote" })).toMatchObject({ ok: true, ended: shown.round });
    const abandoned = room({ round: voting({ votes: { [A]: { card: "3" } } }) });
    const result = send(abandoned, { type: "startRound", subject: { kind: "none" } });
    expect(result).toMatchObject({ ok: true, ended: abandoned.round });
    expect(result.ok && result.ended?.phase).toBe("voting");
  });

  it("reports the voting round a deck change restarts", () => {
    const before = room({ round: voting({ votes: { [A]: { card: "3" } } }) });
    const result = send(before, {
      type: "updateSettings",
      patch: { deck: { kind: "preset", id: "seq" } },
    });
    expect(result).toMatchObject({ ok: true, ended: before.round });
  });

  it("is absent when no round ended", () => {
    const fromLobby = send(room({ round: null }), {
      type: "startRound",
      subject: { kind: "none" },
    });
    expect(ok(fromLobby).round?.number).toBe(1);
    expect("ended" in fromLobby).toBe(false);
    expect("ended" in send(room(), { type: "castVote", card: "3" }, A)).toBe(false);
    expect("ended" in send(room(), { type: "revote" })).toBe(false);
  });
});

describe("owner", () => {
  it("hands the PO role to a present participant", () => {
    const result = send(room(), { type: "transferOwner", to: A });
    expect(result.causes).toEqual([{ type: "ownerChanged", by: "transfer", to: A }]);
    expect(ok(result).ownerId).toBe(A);
  });

  const away = (since: number) =>
    room({ participants: { [PO]: person("Pia", { awaySince: since }), [A]: person("Alice") } });

  it("refuses a claim 1 ms before 120 s away and accepts it at 120 s", () => {
    expect(send(away(T0 - OWNER_CLAIM_AFTER_MS + 1), { type: "claimOwner" }, A)).toMatchObject({
      ok: false,
      error: "owner_present",
    });
    const result = send(away(T0 - OWNER_CLAIM_AFTER_MS), { type: "claimOwner" }, A);
    expect(result.causes).toEqual([{ type: "ownerChanged", by: "claim", to: A }]);
    expect(ok(result).ownerId).toBe(A);
  });

  it("lets anyone claim when the owner is not in the room", () => {
    const before = room({ ownerId: "gone" });
    expect(ok(send(before, { type: "claimOwner" }, B)).ownerId).toBe(B);
  });
});

describe("updateSettings", () => {
  it("merges a patch, the timer one level deep, and stores it canonically", () => {
    const result = send(room({ round: null }), {
      type: "updateSettings",
      patch: {
        specials: ["∞", "?"],
        whoCanReveal: "anyone",
        revealNames: false,
        allowChangeAfterReveal: true,
        timer: { revealAtEnd: false },
        deck: { kind: "custom", cards: [" S ", "M"] },
      },
    });
    expect(result.causes).toEqual([{ type: "settingsUpdated" }]);
    expect(ok(result).settings).toEqual({
      deck: { kind: "custom", cards: ["S", "M"] },
      specials: ["?", "∞"],
      whoCanReveal: "anyone",
      revealNames: false,
      revealWhenAllVoted: true,
      timer: { seconds: null, revealAtEnd: false },
      allowChangeAfterReveal: true,
      poVotes: true,
      observersCount: true,
    });
  });

  it("returns the input when nothing changes, whatever the stored key order", () => {
    const before = room();
    const shuffled: RoomState = {
      ...before,
      // As jsonb hands it back: keys in another order than canonicalSettings writes them.
      settings: {
        observersCount: true,
        poVotes: true,
        allowChangeAfterReveal: false,
        timer: { revealAtEnd: true, seconds: null },
        revealWhenAllVoted: true,
        revealNames: true,
        whoCanReveal: "po",
        specials: ["?", "☕"],
        deck: { id: "fib", kind: "preset" } as RoomSettings["deck"],
      },
    };
    const result = send(shuffled, {
      type: "updateSettings",
      patch: { deck: { kind: "preset", id: "fib" }, timer: { seconds: null }, poVotes: true },
    });
    expect(result).toEqual({ ok: true, state: shuffled, causes: [] });
    expect(result.state).toBe(shuffled);
  });

  it("restarts a voting round on a new deck: same number and subject, new cards, no votes", () => {
    const before = room({
      round: voting({ number: 4, votes: { [A]: { card: "3" } }, deadlineAt: T0 + 9_000 }),
    });
    const result = send(before, {
      type: "updateSettings",
      patch: { deck: { kind: "preset", id: "tshirt" } },
    });
    expect(result.causes).toEqual([
      { type: "settingsUpdated" },
      { type: "roundStarted", number: 4, restarted: true },
    ]);
    expect(ok(result).round).toEqual({
      ...voting({ number: 4, deadlineAt: T0 + 9_000 }),
      deck: { kind: "preset", id: "tshirt" },
      startedAt: T0,
    });
  });

  it("restarts a voting round on new specials", () => {
    const before = room({ round: voting({ votes: { [A]: { card: "3" } } }) });
    const result = send(before, { type: "updateSettings", patch: { specials: ["?"] } });
    expect(ok(result).round).toMatchObject({ specials: ["?"], votes: {}, number: 1 });
  });

  it("leaves the round alone for other changes, and a revealed round always", () => {
    const votingRoom = room({ round: voting({ votes: { [A]: { card: "3" } } }) });
    const named = send(votingRoom, { type: "updateSettings", patch: { revealNames: false } });
    expect(ok(named).round).toBe(votingRoom.round);
    const afterReveal = room({ round: revealed({ votes: { [A]: { card: "3" } } }) });
    const deck = send(afterReveal, {
      type: "updateSettings",
      patch: { deck: { kind: "preset", id: "seq" } },
    });
    expect(ok(deck).round).toBe(afterReveal.round);
  });

  it("applies anonymity from the next round", () => {
    const anonymous = ok(send(room(), { type: "updateSettings", patch: { revealNames: false } }));
    expect(anonymous.round?.anonymous).toBe(false);
    expect(
      ok(send(anonymous, { type: "startRound", subject: { kind: "none" } })).round?.anonymous,
    ).toBe(true);
  });

  it("counts observers again when the room still has 16 seats", () => {
    const before = room({ settings: { observersCount: false }, participants: crowd(15, 1) });
    ok(send(before, { type: "updateSettings", patch: { observersCount: true } }));
  });
});

describe("immutability", () => {
  it("never changes its input, refused or not", () => {
    const states = [room(), room({ round: null }), room({ round: revealed() })];
    const commands: unknown[] = [
      { type: "castVote", card: "3" },
      { type: "reveal" },
      { type: "leave" },
      { type: "updateSettings", patch: { deck: { kind: "preset", id: "seq" } } },
      { type: "startTimer", seconds: 10 },
    ];
    for (const state of states) {
      const json = JSON.stringify(state);
      for (const command of commands) send(state, command);
      expect(JSON.stringify(state)).toBe(json);
      expect(Object.isFrozen(state.participants)).toBe(true);
    }
  });
});

describe("presence (#17)", () => {
  const SERVER = ":server";
  const away = (who: string, connected = true) => ({ type: "presence", who, connected });

  it("marks a person away after the grace period, from the server, at `now`", () => {
    const result = send(room(), away(A, false), SERVER, T0 + 5);
    expect(result).toMatchObject({ ok: true, causes: [{ type: "away", who: A }] });
    expect(result.state.participants[A]).toEqual({
      ...person("Alice"),
      connected: false,
      awaySince: T0 + 5,
    });
  });

  it("brings an away person back: connected again, no `awaySince`", () => {
    const before = room({
      participants: {
        [PO]: person("Pia"),
        [A]: person("Alice", { connected: false, awaySince: T0 - 9 }),
      },
    });
    const result = send(before, away(A), SERVER);
    expect(result).toMatchObject({ ok: true, causes: [{ type: "back", who: A }] });
    expect(result.state.participants[A]).toEqual(person("Alice"));
    expect("awaySince" in (result.state.participants[A] ?? {})).toBe(false);
  });

  it("connects someone stored as not connected who was never marked away", () => {
    const before = room({
      participants: { [PO]: person("Pia"), [A]: person("Alice", { connected: false }) },
    });
    const result = send(before, away(A), SERVER);
    expect(result).toMatchObject({ ok: true, causes: [{ type: "back", who: A }] });
    expect(result.state.participants[A]?.connected).toBe(true);
  });

  it("changes nothing when the state already says so: no new state, no cause", () => {
    const here = room();
    expect(send(here, away(A), SERVER)).toEqual({ ok: true, state: here, causes: [] });
    const gone = room({
      participants: {
        [PO]: person("Pia"),
        [A]: person("Alice", { connected: false, awaySince: T0 - 9 }),
      },
    });
    const again = send(gone, away(A, false), SERVER, T0 + 60_000);
    expect(again).toEqual({ ok: true, state: gone, causes: [] });
  });

  it("refuses an unknown person, prototype names included", () => {
    for (const who of [OUT, "constructor", "__proto__", "toString"]) {
      const before = room();
      expect(send(before, away(who, false), SERVER)).toEqual({
        ok: false,
        error: "unknown_participant",
        state: before,
        causes: [],
      });
    }
  });

  it("is open to a non-participant actor: the server sends it", () => {
    expect(send(room(), away(B, false), SERVER).ok).toBe(true);
  });

  it("settles the round: the last one thinking goes away after everyone else voted", () => {
    const before = room({
      round: voting({ votes: { [PO]: { card: "3" }, [A]: { card: "5" } } }),
    });
    const result = send(before, away(B, false), SERVER, T0 + 1);
    expect(result).toMatchObject({
      ok: true,
      causes: [
        { type: "away", who: B },
        { type: "revealed", by: "everyoneVoted" },
      ],
    });
    expect(result.state.round).toMatchObject({ phase: "revealed", revealedAt: T0 + 1 });
  });

  it("keeps the vote of a voter who goes away, and does not reveal while someone still thinks", () => {
    const before = room({ round: voting({ votes: { [A]: { card: "5" } } }) });
    const result = send(before, away(A, false), SERVER);
    expect(result).toMatchObject({ ok: true, causes: [{ type: "away", who: A }] });
    expect(result.state.round).toMatchObject({ phase: "voting", votes: { [A]: { card: "5" } } });
  });

  it("does not reveal when everyone eligible is away", () => {
    const before = room({
      participants: {
        [PO]: person("Pia", { connected: false, awaySince: T0 - 1 }),
        [A]: person("Alice"),
      },
    });
    const result = send(before, away(A, false), SERVER);
    expect(reveals(result.causes)).toEqual([]);
    expect(result.state.round?.phase).toBe("voting");
  });

  it("does not reveal when someone comes back without a vote", () => {
    const before = room({
      participants: {
        [PO]: person("Pia"),
        [A]: person("Alice", { connected: false, awaySince: T0 - 1 }),
      },
      round: voting({ votes: { [PO]: { card: "3" } } }),
    });
    const result = send(before, away(A), SERVER);
    expect(result.causes).toEqual([{ type: "back", who: A }]);
    expect(result.state.round?.phase).toBe("voting");
  });

  it("resolves an elapsed deadline first, like any command", () => {
    const before = room({ round: voting({ deadlineAt: T0 - 1 }) });
    const result = send(before, away(A, false), SERVER);
    expect(result.causes).toEqual([
      { type: "revealed", by: "timer" },
      { type: "away", who: A },
    ]);
  });

  it("opens the PO claim once the PO has been away for two minutes", () => {
    const gone = ok(send(room(), away(PO, false), SERVER, T0));
    expect(send(gone, { type: "claimOwner" }, A, T0 + OWNER_CLAIM_AFTER_MS - 1)).toMatchObject({
      ok: false,
      error: "owner_present",
    });
    expect(send(gone, { type: "claimOwner" }, A, T0 + OWNER_CLAIM_AFTER_MS).ok).toBe(true);
  });
});
