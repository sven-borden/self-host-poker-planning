/**
 * The round state machine (architecture, section 4). `apply` is pure and synchronous:
 * it never mutates its input and returns the input object itself when nothing changed.
 *
 * Every call runs three steps:
 * 1. Resolve an elapsed deadline (lazy timer): reveal or announce `timeUp`, exactly once.
 *    This stands even when the command is then refused.
 * 2. Run the command.
 * 3. On success, settle the round: drop the votes of people who are no longer voters
 *    (while Voting), then reveal when every eligible voter has voted.
 */
import {
  canonicalDeck,
  canonicalSettings,
  cleanName,
  cleanSubject,
  isTimerSeconds,
  patchSettings,
  sameJson,
} from "./apply-input.ts";
import type {
  ApplyContext,
  ApplyResult,
  Cause,
  Command,
  CommandType,
  ErrorCode,
} from "./commands.ts";
import { baseCards, deckCards } from "./decks.ts";
import {
  MAX_MEMBERS,
  MAX_PARTICIPANTS,
  OWNER_CLAIM_AFTER_MS,
  type Participant,
  ROLES,
  type Role,
  type RoomSettings,
  type RoomState,
  type Round,
  type Subject,
  type UserId,
  type Vote,
} from "./room.ts";

type Step = { state: RoomState; causes: Cause[] } | { error: ErrorCode };

const done = (state: RoomState, ...causes: Cause[]): Step => ({ state, causes });
const refuse = (error: ErrorCode): Step => ({ error });

/** Commands only the PO may send. */
const OWNER_ONLY: ReadonlySet<CommandType> = new Set<CommandType>([
  "kick",
  "startRound",
  "setFinal",
  "revote",
  "startTimer",
  "stopTimer",
  "extendTimer",
  "updateSettings",
  "transferOwner",
]);

/** Commands a non-participant may send: entering, and the server's own timer ping. */
const OPEN: ReadonlySet<CommandType> = new Set<CommandType>(["join", "timeUp"]);

export function apply(state: RoomState, command: Command, ctx: ApplyContext): ApplyResult {
  const resolved = resolveDeadline(state);
  const step = run(resolved.state, command, ctx);
  if ("error" in step) {
    return { ok: false, error: step.error, state: resolved.state, causes: resolved.causes };
  }
  const settled = settle(step.state, ctx.now);
  return {
    ok: true,
    state: settled.state,
    causes: [...resolved.causes, ...step.causes, ...settled.causes],
  };

  function resolveDeadline(s: RoomState): { state: RoomState; causes: Cause[] } {
    const round = s.round;
    if (round?.phase !== "voting" || round.deadlineAt === undefined || round.deadlineAt > ctx.now) {
      return { state: s, causes: [] };
    }
    if (s.settings.timer.revealAtEnd) {
      return {
        state: withRound(s, reveal(round, round.deadlineAt)),
        causes: [{ type: "revealed", by: "timer" }],
      };
    }
    return { state: withRound(s, withoutDeadline(round)), causes: [{ type: "timeUp" }] };
  }
}

function run(state: RoomState, command: Command, { actor, now }: ApplyContext): Step {
  if (!OPEN.has(command.type) && !participant(state, actor)) return refuse("not_participant");
  if (OWNER_ONLY.has(command.type) && actor !== state.ownerId) return refuse("not_owner");

  switch (command.type) {
    case "join":
      return join(state, actor, command.name, command.role, now);
    case "leave":
      return done(removeParticipant(state, actor), { type: "left", who: actor });
    case "rename":
      return rename(state, actor, command.name);
    case "setRole":
      return setRole(state, actor, command.role);
    case "kick":
      if (command.who === actor) return refuse("cannot_kick_self");
      if (!participant(state, command.who)) return refuse("unknown_participant");
      return done(removeParticipant(state, command.who), { type: "kicked", who: command.who });
    case "startRound": {
      const subject = cleanSubject(command.subject);
      return subject ? startRound(state, subject, now) : refuse("bad_subject");
    }
    case "castVote":
      return castVote(state, actor, command.card);
    case "retractVote":
      return retractVote(state, actor);
    case "reveal": {
      if (actor !== state.ownerId && state.settings.whoCanReveal !== "anyone") {
        return refuse("not_allowed");
      }
      const round = state.round;
      if (round?.phase !== "voting") return refuse("not_voting");
      return done(withRound(state, reveal(round, now)), { type: "revealed", by: "manual" });
    }
    case "setFinal":
      return setFinal(state, command.card);
    case "revote":
      if (state.round?.phase !== "revealed") return refuse("not_revealed");
      return startRound(state, state.round.subject, now);
    case "startTimer": {
      const round = state.round;
      if (round?.phase !== "voting") return refuse("not_voting");
      if (!isTimerSeconds(command.seconds)) return refuse("bad_seconds");
      const deadlineAt = now + command.seconds * 1000;
      return done(withRound(state, { ...round, deadlineAt }), { type: "timerStarted" });
    }
    case "stopTimer": {
      const round = state.round;
      if (round?.deadlineAt === undefined) return done(state);
      return done(withRound(state, withoutDeadline(round)), { type: "timerStopped" });
    }
    case "extendTimer": {
      const round = state.round;
      if (round?.deadlineAt === undefined) return refuse("no_timer");
      if (!isTimerSeconds(command.seconds)) return refuse("bad_seconds");
      const deadlineAt = round.deadlineAt + command.seconds * 1000;
      return done(withRound(state, { ...round, deadlineAt }), { type: "timerExtended" });
    }
    case "timeUp":
      // The deadline was resolved before the command; nothing else to do.
      return done(state);
    case "updateSettings":
      return updateSettings(state, command.patch, now);
    case "transferOwner":
      if (command.to === actor || !isPresent(participant(state, command.to))) {
        return refuse("target_not_present");
      }
      return done(
        { ...state, ownerId: command.to },
        { type: "ownerChanged", by: "transfer", to: command.to },
      );
    case "claimOwner":
      return claimOwner(state, actor, now);
    default:
      return unknownCommand(command);
  }
}

/** Exhaustive switch: a new command type fails to compile at the call. At runtime, a bad type. */
function unknownCommand(_command: never): Step {
  return refuse("bad_command");
}

// ---------------------------------------------------------------------------- membership

function join(state: RoomState, actor: UserId, rawName: unknown, role: Role, now: number): Step {
  if (participant(state, actor)) return refuse("already_joined");
  const name = cleanName(rawName);
  if (name === null) return refuse("bad_name");
  if (!ROLES.includes(role)) return refuse("bad_role");
  const members = Object.keys(state.participants).length;
  if (members >= MAX_MEMBERS) return refuse("room_full");
  if (counts(state.settings, role) && countedPeople(state) >= MAX_PARTICIPANTS) {
    return refuse("room_full");
  }
  const person: Participant = { name, role, joinedAt: now, connected: true };
  return done(
    { ...state, participants: { ...state.participants, [actor]: person } },
    { type: "joined", who: actor },
  );
}

function rename(state: RoomState, actor: UserId, rawName: unknown): Step {
  const name = cleanName(rawName);
  if (name === null) return refuse("bad_name");
  const person = state.participants[actor] as Participant;
  if (person.name === name) return done(state);
  return done(withParticipant(state, actor, { ...person, name }), { type: "renamed", who: actor });
}

function setRole(state: RoomState, actor: UserId, role: Role): Step {
  if (!ROLES.includes(role)) return refuse("bad_role");
  const person = state.participants[actor] as Participant;
  if (person.role === role) return done(state);
  // An observer becoming a voter takes a seat only when observers do not count already.
  if (!counts(state.settings, person.role) && countedPeople(state) >= MAX_PARTICIPANTS) {
    return refuse("room_full");
  }
  return done(withParticipant(state, actor, { ...person, role }), {
    type: "roleChanged",
    who: actor,
    role,
  });
}

function claimOwner(state: RoomState, actor: UserId, now: number): Step {
  if (actor === state.ownerId) return refuse("already_owner");
  const owner = participant(state, state.ownerId);
  if (owner && (owner.awaySince === undefined || now - owner.awaySince < OWNER_CLAIM_AFTER_MS)) {
    return refuse("owner_present");
  }
  return done({ ...state, ownerId: actor }, { type: "ownerChanged", by: "claim", to: actor });
}

// ---------------------------------------------------------------------------------- rounds

/** A new round: the next number, the current deck, specials and anonymity, no votes. */
function startRound(state: RoomState, subject: Subject, now: number): Step {
  const { settings } = state;
  const number = (state.round?.number ?? 0) + 1;
  const round: Round = {
    number,
    subject,
    phase: "voting",
    deck: canonicalDeck(settings.deck),
    specials: [...settings.specials],
    anonymous: !settings.revealNames,
    votes: {},
    startedAt: now,
  };
  if (settings.timer.seconds !== null) round.deadlineAt = now + settings.timer.seconds * 1000;
  return done(withRound(state, round), { type: "roundStarted", number });
}

function castVote(state: RoomState, actor: UserId, card: unknown): Step {
  const round = state.round;
  if (!round) return refuse("no_round");
  if (!isVoter(state, actor)) return refuse("not_voter");
  const previous = ownVote(round, actor);
  if (round.phase === "revealed") {
    if (!state.settings.allowChangeAfterReveal) return refuse("round_revealed");
    // A first vote after an anonymous reveal would tie this person to the new card.
    if (round.anonymous && !previous) return refuse("round_revealed");
  }
  if (typeof card !== "string" || !deckCards(round.deck, round.specials).includes(card)) {
    return refuse("bad_card");
  }
  if (previous?.card === card) return done(state);
  const vote: Vote = round.phase === "revealed" ? { card, changedAfterReveal: true } : { card };
  return done(
    withRound(state, { ...round, votes: { ...round.votes, [actor]: vote } }),
    voteCause("voteCast", round, actor),
  );
}

/**
 * A vote cause. In an anonymous round after reveal it leaves `who` out: the public card
 * list changes at the same moment, so naming the person would tie them to both cards.
 */
function voteCause(type: "voteCast" | "voteRetracted", round: Round, who: UserId): Cause {
  return round.anonymous && round.phase === "revealed" ? { type } : { type, who };
}

function retractVote(state: RoomState, actor: UserId): Step {
  const round = state.round;
  if (round?.phase !== "voting") return refuse("not_voting");
  if (!ownVote(round, actor)) return done(state);
  return done(
    withRound(state, { ...round, votes: omit(round.votes, actor) }),
    voteCause("voteRetracted", round, actor),
  );
}

function setFinal(state: RoomState, card: unknown): Step {
  const round = state.round;
  if (round?.phase !== "revealed") return refuse("not_revealed");
  if (typeof card !== "string" || !baseCards(round.deck).includes(card)) return refuse("bad_card");
  if (round.final === card) return done(state);
  return done(withRound(state, { ...round, final: card }), { type: "finalSet", card });
}

function updateSettings(state: RoomState, patch: unknown, now: number): Step {
  const patched = patchSettings(state.settings, patch);
  if (!patched.ok) return refuse(patched.error);
  const settings = patched.settings;
  if (sameJson(settings, canonicalSettings(state.settings))) return done(state);
  if (
    settings.observersCount &&
    !state.settings.observersCount &&
    countedPeople({ ...state, settings }) > MAX_PARTICIPANTS
  ) {
    return refuse("room_full");
  }
  const next: RoomState = { ...state, settings };
  const round = state.round;
  if (
    round?.phase !== "voting" ||
    (sameJson(canonicalDeck(round.deck), settings.deck) &&
      sameJson(round.specials, settings.specials))
  ) {
    return done(next, { type: "settingsUpdated" });
  }
  // A new deck or new specials during Voting restart the round: same subject and number.
  const restarted: Round = {
    ...round,
    deck: canonicalDeck(settings.deck),
    specials: [...settings.specials],
    votes: {},
    startedAt: now,
  };
  return done(
    withRound(next, restarted),
    { type: "settingsUpdated" },
    { type: "roundStarted", number: round.number, restarted: true },
  );
}

/**
 * After a successful command, while Voting: drop the votes of people who are no longer
 * voters (they left, were kicked, became observers, or are a PO who no longer votes), then
 * reveal when `revealWhenAllVoted` is on and every eligible voter (a voter who is not
 * away) has voted. A leave, kick, role or settings change can complete a round too.
 */
function settle(state: RoomState, now: number): { state: RoomState; causes: Cause[] } {
  const round = state.round;
  if (round?.phase !== "voting") return { state, causes: [] };
  const votes = Object.entries(round.votes);
  const kept = votes.filter(([id]) => isVoter(state, id));
  const current =
    kept.length === votes.length ? round : { ...round, votes: Object.fromEntries(kept) };
  const eligible = Object.keys(state.participants).filter(
    (id) => isVoter(state, id) && isPresent(state.participants[id]),
  );
  const everyoneVoted =
    state.settings.revealWhenAllVoted &&
    eligible.length > 0 &&
    eligible.every((id) => ownVote(current, id));
  if (everyoneVoted) {
    return {
      state: withRound(state, reveal(current, now)),
      causes: [{ type: "revealed", by: "everyoneVoted" }],
    };
  }
  return { state: current === round ? state : withRound(state, current), causes: [] };
}

// --------------------------------------------------------------------------------- helpers

/** Own-property lookups only: an id such as `constructor` must never hit the prototype. */
function participant(state: RoomState, id: UserId): Participant | undefined {
  return Object.hasOwn(state.participants, id) ? state.participants[id] : undefined;
}

function ownVote(round: Round, id: UserId): Vote | undefined {
  return Object.hasOwn(round.votes, id) ? round.votes[id] : undefined;
}

/** In the room and not away. */
function isPresent(person: Participant | undefined): boolean {
  return person !== undefined && person.awaySince === undefined;
}

/** A voter: role `voter`, and not the PO when the PO does not vote. */
function isVoter(state: RoomState, id: UserId): boolean {
  return (
    participant(state, id)?.role === "voter" && (id !== state.ownerId || state.settings.poVotes)
  );
}

/** Whether a person with this role takes one of the 16 seats. */
function counts(settings: RoomSettings, role: Role): boolean {
  return role === "voter" || settings.observersCount;
}

function countedPeople(state: RoomState): number {
  return Object.values(state.participants).filter((p) => counts(state.settings, p.role)).length;
}

function withRound(state: RoomState, round: Round): RoomState {
  return { ...state, round };
}

function withParticipant(state: RoomState, id: UserId, person: Participant): RoomState {
  return { ...state, participants: { ...state.participants, [id]: person } };
}

function removeParticipant(state: RoomState, id: UserId): RoomState {
  return { ...state, participants: omit(state.participants, id) };
}

function omit<T>(record: Record<string, T>, key: string): Record<string, T> {
  return Object.fromEntries(Object.entries(record).filter(([k]) => k !== key));
}

function withoutDeadline(round: Round): Round {
  const next = { ...round };
  delete next.deadlineAt;
  return next;
}

/** The round revealed at `at`; a running timer stops. */
function reveal(round: Round, at: number): Round {
  return { ...withoutDeadline(round), phase: "revealed", revealedAt: at };
}
