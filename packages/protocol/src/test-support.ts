/**
 * Test support (not exported by the package): fast-check generators of realistic rooms,
 * built by running random command sequences through the domain's `apply`.
 *
 * Names, ids, subjects and the room code use lowercase letters only, and every card label
 * holds a digit, an uppercase letter or a symbol, so a card can never be mistaken for one
 * of them when a test scans a snapshot's strings.
 */
import {
  apply,
  type Cause,
  type ClientCommand,
  type Command,
  createRoom,
  DEFAULT_SETTINGS,
  type DeckSpec,
  deckCards,
  PRESET_DECK_IDS,
  PRESET_DECKS,
  ROLES,
  type RoomState,
  type SettingsPatch,
  SPECIAL_CARDS,
  type Subject,
  type UserId,
  WHO_CAN_REVEAL,
} from "@pp/domain";
import fc from "fast-check";

export const OWNER = "ua";
export const PEOPLE = ["ua", "ub", "uc", "ud", "ue"] as const;
/** Someone who opened the room but never joined. */
export const STRANGER = "uz";
export const VIEWERS: readonly UserId[] = [...PEOPLE, STRANGER];
export const CODE = "roomcode";
export const START = 1_700_000_000_000;

export const CUSTOM_DECK: DeckSpec = { kind: "custom", cards: ["Q1", "Q2", "Q3", "Q5"] };
/** Every card any generated round can hold, plus a few that no deck holds. */
export const CARD_POOL: readonly string[] = [
  ...new Set([...Object.values(PRESET_DECKS).flat(), ...CUSTOM_DECK.cards, ...SPECIAL_CARDS, "Z9"]),
];

export const nameArb = fc.string({
  unit: fc.constantFrom(..."abcdefghijklmnop"),
  minLength: 1,
  maxLength: 8,
});

export const subjectArb: fc.Arbitrary<Subject> = fc.oneof(
  fc.constant({ kind: "none" as const }),
  fc.record({ kind: fc.constant("title" as const), text: nameArb }),
  fc.record({
    kind: fc.constant("link" as const),
    url: fc.constantFrom("https://example.com/a", "https://example.com/b"),
  }),
);

export const deckArb: fc.Arbitrary<DeckSpec> = fc.oneof(
  fc.constantFrom(...PRESET_DECK_IDS).map((id): DeckSpec => ({ kind: "preset", id })),
  fc.constant(CUSTOM_DECK),
);

export const patchArb: fc.Arbitrary<SettingsPatch> = fc.record(
  {
    deck: deckArb,
    specials: fc.subarray([...SPECIAL_CARDS]),
    whoCanReveal: fc.constantFrom(...WHO_CAN_REVEAL),
    revealNames: fc.boolean(),
    revealWhenAllVoted: fc.boolean(),
    timer: fc.record(
      { seconds: fc.constantFrom(null, 5, 30), revealAtEnd: fc.boolean() },
      { requiredKeys: [] },
    ),
    allowChangeAfterReveal: fc.boolean(),
    poVotes: fc.boolean(),
    observersCount: fc.boolean(),
  },
  { requiredKeys: [] },
);

const personArb = fc.constantFrom<UserId>(...PEOPLE, STRANGER);
const roleArb = fc.constantFrom(...ROLES);
const secondsArb = fc.integer({ min: 5, max: 60 });

/** Every command a client may send, weighted towards the ones that move a round. */
export const clientCommandArb: fc.Arbitrary<ClientCommand> = fc.oneof(
  {
    weight: 2,
    arbitrary: fc.record({ type: fc.constant("join" as const), name: nameArb, role: roleArb }),
  },
  { weight: 1, arbitrary: fc.constant({ type: "leave" as const }) },
  { weight: 1, arbitrary: fc.record({ type: fc.constant("rename" as const), name: nameArb }) },
  { weight: 1, arbitrary: fc.record({ type: fc.constant("setRole" as const), role: roleArb }) },
  { weight: 1, arbitrary: fc.record({ type: fc.constant("kick" as const), who: personArb }) },
  {
    weight: 2,
    arbitrary: fc.record({ type: fc.constant("startRound" as const), subject: subjectArb }),
  },
  {
    weight: 10,
    arbitrary: fc.record({
      type: fc.constant("castVote" as const),
      card: fc.constantFrom(...CARD_POOL),
    }),
  },
  { weight: 2, arbitrary: fc.constant({ type: "retractVote" as const }) },
  { weight: 3, arbitrary: fc.constant({ type: "reveal" as const }) },
  {
    weight: 1,
    arbitrary: fc.record({
      type: fc.constant("setFinal" as const),
      card: fc.constantFrom(...CARD_POOL),
    }),
  },
  { weight: 1, arbitrary: fc.constant({ type: "revote" as const }) },
  {
    weight: 1,
    arbitrary: fc.record({ type: fc.constant("startTimer" as const), seconds: secondsArb }),
  },
  { weight: 1, arbitrary: fc.constant({ type: "stopTimer" as const }) },
  {
    weight: 1,
    arbitrary: fc.record({ type: fc.constant("extendTimer" as const), seconds: secondsArb }),
  },
  { weight: 1, arbitrary: fc.constant({ type: "timeUp" as const }) },
  {
    weight: 2,
    arbitrary: fc.record({ type: fc.constant("updateSettings" as const), patch: patchArb }),
  },
  {
    weight: 1,
    arbitrary: fc.record({ type: fc.constant("transferOwner" as const), to: personArb }),
  },
  { weight: 1, arbitrary: fc.constant({ type: "claimOwner" as const }) },
);

/**
 * Every domain command: a client's, or the server's own presence update (#17), which never
 * comes from a client but changes who may vote, so the secrecy properties run over it too.
 */
export const commandArb: fc.Arbitrary<Command> = fc.oneof(
  { weight: 15, arbitrary: clientCommandArb },
  {
    weight: 1,
    arbitrary: fc.record({
      type: fc.constant("presence" as const),
      who: personArb,
      connected: fc.boolean(),
    }),
  },
);

export type Step = { actor: UserId; dt: number; command: Command };

const stepArb: fc.Arbitrary<Step> = fc.record({
  // The owner sends more often: most commands that move a round are the PO's.
  actor: fc.constantFrom<UserId>(...PEOPLE, OWNER, OWNER, STRANGER),
  dt: fc.integer({ min: 0, max: 20_000 }),
  command: commandArb,
});

/** A room where the owner and some others joined and a round started, then random steps. */
export const scenarioArb: fc.Arbitrary<Step[]> = fc
  .record({
    others: fc.subarray(PEOPLE.slice(1)),
    patch: patchArb,
    subject: subjectArb,
    picks: fc.array(fc.nat(), { minLength: PEOPLE.length, maxLength: PEOPLE.length }),
    steps: fc.array(stepArb, { maxLength: 40 }),
  })
  .map(({ others, patch, subject, picks, steps }) => [
    { actor: OWNER, dt: 0, command: { type: "join", name: "owner", role: "voter" } },
    ...others.map(
      (who): Step => ({
        actor: who,
        dt: 1,
        command: { type: "join", name: "voter", role: "voter" },
      }),
    ),
    { actor: OWNER, dt: 1, command: { type: "updateSettings", patch } },
    { actor: OWNER, dt: 1, command: { type: "startRound", subject } },
    // Most people vote at once, with cards of the round, so reveals hold several cards.
    ...[OWNER, ...others].map((who, i): Step => {
      const cards = deckCards(
        patch.deck ?? DEFAULT_SETTINGS.deck,
        patch.specials ?? DEFAULT_SETTINGS.specials,
      );
      const card = cards[(picks[i] ?? 0) % cards.length] ?? "1";
      return { actor: who, dt: 1, command: { type: "castVote", card } };
    }),
    ...steps,
  ]);

/** One `apply` and what the server would hold and broadcast after it. */
export type Frame = { state: RoomState; causes: Cause[]; now: number; version: number };

/** Runs the steps through `apply`, keeping a frame per step (a refusal keeps its state too). */
export function play(steps: readonly Step[], state = createRoom({ ownerId: OWNER })): Frame[] {
  const frames: Frame[] = [];
  let now = START;
  let current = state;
  for (const [i, step] of steps.entries()) {
    now += step.dt;
    const result = apply(current, step.command, { actor: step.actor, now });
    current = result.state;
    frames.push({ state: current, causes: result.causes, now, version: i + 1 });
  }
  return frames;
}

export function meta(frame: Frame) {
  return { code: CODE, version: frame.version, now: frame.now, causes: frame.causes };
}
