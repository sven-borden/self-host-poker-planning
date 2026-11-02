/**
 * The round state machine (architecture, section 4). `apply` is pure and synchronous:
 * it never mutates its input and returns the input object itself when nothing changed.
 *
 * Every call runs three steps:
 * 1. Resolve an elapsed deadline (lazy timer): reveal or announce `timeUp`, or start the
 *    next queue item, exactly once. This stands even when the command is then refused.
 *    Only `endCountdown` skips it: it says nobody is left for the round it would start.
 * 2. Run the command.
 * 3. On success, settle the round: drop the votes of people who are no longer voters
 *    (while Voting), then reveal when every eligible voter has voted. `moveGuest` only
 *    drops: a sign-in is nothing anyone at the table did, so it reveals nothing itself.
 */
import {
  canonicalDeck,
  canonicalSettings,
  cleanName,
  cleanRoomName,
  isRecord,
  isTimerSeconds,
  patchSettings,
  sameJson,
} from "./apply-input.ts";
import {
  addToQueue,
  clearQueue,
  importToQueue,
  itemSubject,
  moveInQueue,
  removeFromQueue,
} from "./apply-queue.ts";
import { cleanSubject } from "./apply-subject.ts";
import { isAvatarId } from "./avatars.ts";
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
  AUTO_ADVANCE_MS,
  keeperOf,
  MAX_MEMBERS,
  MAX_PARTICIPANTS,
  MIN_ANONYMOUS_REVEAL_CARDS,
  OWNER_CLAIM_AFTER_MS,
  type Participant,
  type Queue,
  type QueueItem,
  type QueueSource,
  ROLES,
  type Role,
  type RoomSettings,
  type RoomState,
  type Round,
  type Subject,
  type UserId,
  type Vote,
} from "./room.ts";

/** A success; `ended` is the round this command replaced or abandoned, if any. */
type Done = { state: RoomState; causes: Cause[]; ended?: Round };
type Step = Done | { error: ErrorCode };

const done = (state: RoomState, ...causes: Cause[]): Done => ({ state, causes });
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
  "password",
  "queueAdd",
  "queueImport",
  "queueMove",
  "queueRemove",
  "queueClear",
  "startNext",
  "holdAdvance",
  "renameRoom",
]);

/**
 * Commands a non-participant may send: entering, the timer ping, the server's own
 * presence updates (the actor is the server; `who` names the person), the PO's password
 * (#31) and the room's name (#49), which the PO may set from outside the room too, and the
 * server's `moveGuest`.
 */
const OPEN: ReadonlySet<CommandType> = new Set<CommandType>([
  "join",
  "timeUp",
  "presence",
  "password",
  "moveGuest",
  "endCountdown",
  "renameRoom",
]);

export function apply(state: RoomState, command: Command, ctx: ApplyContext): ApplyResult {
  const leftAlone = isRecord(command) && command.type === "endCountdown";
  const resolved = leftAlone ? done(state) : resolveDeadline(state);
  const step = run(resolved.state, command, ctx);
  if ("error" in step) return { ok: false, error: step.error, ...resolved };
  const settled = settle(step.state, ctx.now, command.type !== "moveGuest");
  const causes = [...resolved.causes, ...step.causes, ...settled.causes];
  // The round the deadline ended is the revealed one; the command can only abandon the next.
  const ended = resolved.ended ?? step.ended;
  return ended
    ? { ok: true, state: settled.state, causes, ended }
    : { ok: true, state: settled.state, causes };

  function resolveDeadline(s: RoomState): Done {
    const round = s.round;
    if (round?.phase === "revealed") return resolveAdvance(s, round, ctx.now);
    if (round?.phase !== "voting" || round.deadlineAt === undefined || round.deadlineAt > ctx.now) {
      return { state: s, causes: [] };
    }
    if (s.settings.timer.revealAtEnd) {
      return {
        state: withRound(s, reveal(round, round.deadlineAt)),
        causes: [{ type: "revealed", by: "timer" }],
      };
    }
    // Time is up stays on the round, so a page that loads now still says it (#27).
    return {
      state: withRound(s, { ...withoutTimer(round), timeUpAt: round.deadlineAt }),
      causes: [{ type: "timeUp" }],
    };
  }
}

function run(state: RoomState, command: Command, { actor, now }: ApplyContext): Step {
  // Commands come off the network: anything but an object is refused, never thrown on.
  if (!isRecord(command)) return refuse("bad_command");
  if (!OPEN.has(command.type) && !participant(state, actor)) return refuse("not_participant");
  if (OWNER_ONLY.has(command.type) && actor !== state.ownerId) return refuse("not_owner");

  switch (command.type) {
    case "join":
      return join(state, actor, command, now);
    case "leave":
      return done(removeParticipant(state, actor), { type: "left", who: actor });
    case "rename":
      return rename(state, actor, command.name);
    case "setAvatar":
      return setAvatar(state, actor, command.avatar);
    case "setRole":
      return setRole(state, actor, command.role);
    case "kick":
      if (command.who === actor) return refuse("cannot_kick_self");
      if (!participant(state, command.who)) return refuse("unknown_participant");
      return done(removeParticipant(state, command.who), { type: "kicked", who: command.who });
    case "startRound": {
      // Pressed for a round that is gone: a countdown started the next item under the press.
      if (command.round !== undefined && command.round !== (state.round?.number ?? 0)) {
        return refuse("round_changed");
      }
      const subject = cleanSubject(command.subject);
      return subject ? startRound(state, subject, now) : refuse("bad_subject");
    }
    case "queueAdd":
      return changeQueue(state, addToQueue(state.queue, command.items));
    case "queueImport":
      return changeQueue(state, importToQueue(state.queue, command.items));
    case "queueMove":
      return changeQueue(state, moveInQueue(state.queue, command.id, command.to));
    case "queueRemove":
      return changeQueue(state, removeFromQueue(state.queue, command.id));
    case "queueClear":
      return changeQueue(state, clearQueue(state.queue));
    case "startNext": {
      if (state.round?.phase === "voting") return refuse("not_revealed");
      const item = state.queue?.items.find(({ id }) => id === command.id);
      return item ? startItem(state, item, now) : refuse("unknown_item");
    }
    case "holdAdvance": {
      const round = state.round;
      if (round?.advanceAt === undefined) return done(state);
      return done(withRound(state, { ...withoutAdvance(round), stayed: true }), {
        type: "advanceHeld",
      });
    }
    case "endCountdown": {
      const round = state.round;
      if (round?.advanceAt === undefined) return done(state);
      return done(withRound(state, withoutAdvance(round)), { type: "advanceHeld" });
    }
    case "castVote":
      return castVote(state, actor, command.card, command);
    case "retractVote":
      return retractVote(state, actor, command);
    case "reveal": {
      if (!mayReveal(state, actor)) return refuse("not_allowed");
      const round = state.round;
      if (round?.phase !== "voting") return refuse("not_voting");
      // Anonymity hides who played which card: a lone card would show it (#28, ADR-011).
      // The PO keeps the reveal at any count, so a room with one voter still moves on.
      if (
        actor !== state.ownerId &&
        round.anonymous &&
        Object.keys(round.votes).length < MIN_ANONYMOUS_REVEAL_CARDS
      ) {
        return refuse("too_few_cards");
      }
      return done(withRound(state, reveal(round, now)), {
        type: "revealed",
        by: "manual",
        who: actor,
      });
    }
    case "setFinal":
      return setFinal(state, command.card, now);
    case "revote":
      if (state.round?.phase !== "revealed") return refuse("not_revealed");
      return startRound(state, state.round.subject, now, {
        revote: true,
        source: state.round.source,
      });
    case "startTimer": {
      const round = state.round;
      if (round?.phase !== "voting") return refuse("not_voting");
      if (!isTimerSeconds(command.seconds)) return refuse("bad_seconds");
      const deadlineAt = now + command.seconds * 1000;
      if (round.deadlineAt === deadlineAt) return done(state);
      return done(withRound(state, { ...withoutTimer(round), deadlineAt, timerStartedAt: now }), {
        type: "timerStarted",
      });
    }
    case "stopTimer": {
      const round = state.round;
      if (round?.deadlineAt === undefined) return done(state);
      return done(withRound(state, withoutTimer(round)), { type: "timerStopped" });
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
      // A hand-over by the keeper is the keeper's own act, and the right to delete goes with it.
      // Anyone else can only pass on the role they hold.
      return done(
        {
          ...state,
          ownerId: command.to,
          keeperId: actor === keeperOf(state) ? command.to : keeperOf(state),
        },
        { type: "ownerChanged", by: "transfer", to: command.to },
      );
    case "claimOwner":
      return claimOwner(state, actor, now);
    case "presence":
      return presence(state, command.who, command.connected, now);
    case "password":
      return password(state, command.on);
    case "moveGuest":
      return moveGuest(state, command.guest, command.account);
    case "renameRoom":
      return renameRoom(state, command.name);
    default:
      return unknownCommand(command);
  }
}

/** Exhaustive switch: a new command type fails to compile at the call. At runtime, a bad type. */
function unknownCommand(_command: never): Step {
  return refuse("bad_command");
}

// ---------------------------------------------------------------------------- membership

function join(
  state: RoomState,
  actor: UserId,
  { name: rawName, role, avatar }: Extract<Command, { type: "join" }>,
  now: number,
): Step {
  if (participant(state, actor)) return refuse("already_joined");
  const name = cleanName(rawName);
  if (name === null) return refuse("bad_name");
  if (!ROLES.includes(role)) return refuse("bad_role");
  if (avatar !== undefined && !isAvatarId(avatar)) return refuse("bad_avatar");
  const members = Object.keys(state.participants).length;
  if (members >= MAX_MEMBERS) return refuse("room_full");
  if (counts(state.settings, role) && countedPeople(state) >= MAX_PARTICIPANTS) {
    return refuse("room_full");
  }
  const person: Participant = {
    name,
    role,
    ...(avatar === undefined ? {} : { avatar }),
    joinedAt: now,
    connected: true,
  };
  return done(
    { ...state, participants: { ...state.participants, [actor]: person } },
    { type: "joined", who: actor },
  );
}

/** The rules of a room's name are those of creating one (`cleanRoomName`), blank refused. */
function renameRoom(state: RoomState, rawName: unknown): Step {
  const name = cleanRoomName(rawName);
  if (name === null) return refuse("bad_room_name");
  if (state.name === name) return done(state);
  return done({ ...state, name }, { type: "roomRenamed" });
}

function rename(state: RoomState, actor: UserId, rawName: unknown): Step {
  const name = cleanName(rawName);
  if (name === null) return refuse("bad_name");
  const person = state.participants[actor] as Participant;
  if (person.name === name) return done(state);
  return done(withParticipant(state, actor, { ...person, name }), { type: "renamed", who: actor });
}

function setAvatar(state: RoomState, actor: UserId, avatar: unknown): Step {
  if (avatar !== null && !isAvatarId(avatar)) return refuse("bad_avatar");
  const { avatar: current, ...person } = state.participants[actor] as Participant;
  if ((current ?? null) === avatar) return done(state);
  const next: Participant = avatar === null ? person : { ...person, avatar };
  return done(withParticipant(state, actor, next), { type: "avatarChanged", who: actor });
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
  // The keeper stays, and is written down here: in a room stored before `keeperId`, the PO the
  // claim replaces is the keeper, and after this write no reading could take the claimer for one.
  return done(
    { ...state, ownerId: actor, keeperId: keeperOf(state) },
    { type: "ownerChanged", by: "claim", to: actor },
  );
}

/**
 * The server's presence update (#17, architecture sections 4 and 9). Going away (the last
 * socket left and the grace period passed) sets `awaySince` and clears `connected`;
 * coming back clears `awaySince` and sets `connected`. No change, no new state: a reload
 * inside the grace period never reaches here, and a repeated update is a no-op. Going
 * away leaves the eligible voters, so `settle` may then reveal the round.
 */
function presence(state: RoomState, who: UserId, connected: boolean, now: number): Step {
  const person = participant(state, who);
  if (!person) return refuse("unknown_participant");
  if (connected) {
    if (person.connected && person.awaySince === undefined) return done(state);
    const { awaySince: _, ...here } = person;
    return done(withParticipant(state, who, { ...here, connected: true }), { type: "back", who });
  }
  if (person.awaySince !== undefined) return done(state);
  return done(withParticipant(state, who, { ...person, connected: false, awaySince: now }), {
    type: "away",
    who,
  });
}

/**
 * The PO set, changed or removed the room's password (#31). Only the flag lives in the
 * state; the server writes the hash and the access grants in the same transaction. A new
 * password where there was one is still a change (a new state, so a new version): the
 * grants were just written again. Removing a password the room does not have changes
 * nothing.
 */
function password(state: RoomState, on: unknown): Step {
  if (typeof on !== "boolean") return refuse("bad_command");
  const had = state.hasPassword === true;
  if (on) {
    return done(
      { ...state, hasPassword: true },
      { type: "settingsUpdated", password: had ? "changed" : "set" },
    );
  }
  if (!had) return done(state);
  const { hasPassword: _, ...open } = state;
  return done(open, { type: "settingsUpdated", password: "removed" });
}

/**
 * A guest signed in (#48, ADR-025): what the guest holds in this room becomes the account's.
 * Nothing changes when the guest holds nothing here, so running it again is a no-op. No cause:
 * nobody came or went, the same person sits in the same place under another id, and a sign-in
 * is nothing the room is told about (the address, the provider and the tenant stay out of it).
 *
 * Alone in the room, the guest's seat, as it is, with its name, role, avatar, join time and
 * presence, and the guest's vote become the account's. When the account sits here too, its seat
 * stays with the name the room knows it by, and is as present as the more present of the two
 * seats. It takes the guest's PO role, and when the guest's
 * card is the one that stands while the round votes, it becomes a voter, or `settle` would drop
 * that card. The account's card stands over the guest's, with one exception: after an anonymous
 * reveal both stay. Taking a card off the table as a seat goes would tie that card to that seat,
 * so the guest's stays as a departed voter's card does (`removeParticipant`), under the guest's
 * id, which then names nobody.
 *
 * The right to delete the room (`keeperId`) moves apart from the PO role: a guest can hold either
 * alone, or the right with no seat at all, when someone claimed the role.
 */
function moveGuest(state: RoomState, guest: UserId, account: UserId): Step {
  if (guest === account) return done(state);
  const round = state.round;
  const guestVote = round ? ownVote(round, guest) : undefined;
  const seat = participant(state, guest);
  const movesOwner = state.ownerId === guest;
  const movesKeeper = state.keeperId === guest;
  const votes = round && guestVote ? movedVotes(round, guest, account, guestVote) : round?.votes;
  if (!seat && !movesOwner && !movesKeeper && votes === round?.votes) return done(state);
  const next: RoomState = {
    ...state,
    ...(movesOwner && { ownerId: account }),
    ...(movesKeeper && { keeperId: account }),
    participants: movedSeat(state, guest, account),
  };
  return done(
    round && votes && votes !== round.votes ? withRound(next, { ...round, votes }) : next,
  );
}

/** The round's votes after the move; the same object when they stay as they are. */
function movedVotes(
  round: Round,
  guest: UserId,
  account: UserId,
  vote: Vote,
): Record<UserId, Vote> {
  const rest = omit(round.votes, guest);
  if (!ownVote(round, account)) return { ...rest, [account]: vote };
  return round.anonymous && round.phase === "revealed" ? round.votes : rest;
}

function movedSeat(state: RoomState, guest: UserId, account: UserId): RoomState["participants"] {
  const seat = participant(state, guest);
  if (!seat) return state.participants;
  const rest = omit(state.participants, guest);
  const kept = participant(state, account);
  if (!kept) return { ...rest, [account]: seat };
  const round = state.round;
  const guestCardStands =
    round?.phase === "voting" && ownVote(round, guest) && !ownVote(round, account);
  const merged = morePresent(kept, seat);
  return { ...rest, [account]: guestCardStands ? { ...merged, role: "voter" } : merged };
}

/**
 * `kept`, as present as the more present of the two seats. The person has one presence: the
 * away a seat of theirs left behind a day ago says nothing about the seat they sit in now, and
 * would let anyone claim a PO role the person never left, and shrink the eligible voters.
 * Both away: the person was last here at the later of the two.
 */
function morePresent(kept: Participant, other: Participant): Participant {
  const { awaySince: _, ...here } = kept;
  const merged = { ...here, connected: kept.connected || other.connected };
  if (kept.awaySince === undefined || other.awaySince === undefined) return merged;
  return { ...merged, awaySince: Math.max(kept.awaySince, other.awaySince) };
}

// ---------------------------------------------------------------------------------- rounds

/**
 * A new round: the next number, the current deck, specials and anonymity, no votes. The
 * round it replaces (as the deadline left it) is reported as `ended`. A re-vote (#32)
 * says so in its cause, so the room hears "a new vote on the same subject". `source`: the
 * tracker's item, for a round that came from one (#54).
 */
function startRound(
  state: RoomState,
  subject: Subject,
  now: number,
  { revote = false, source }: { revote?: boolean; source?: QueueSource | undefined } = {},
): Done {
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
    ...(source === undefined ? {} : { source }),
  };
  if (settings.timer.seconds !== null) {
    round.deadlineAt = now + settings.timer.seconds * 1000;
    round.timerStartedAt = now;
  }
  const step = done(
    withRound(state, round),
    revote ? { type: "roundStarted", number, revote: true } : { type: "roundStarted", number },
  );
  if (state.round) step.ended = state.round;
  return step;
}

/** A round on a queue item, which leaves the queue. */
function startItem(state: RoomState, item: QueueItem, now: number): Done {
  const queue = removeFromQueue(state.queue, item.id) as Queue;
  return startRound({ ...state, queue }, itemSubject(item), now, { source: item.source });
}

/** What a queue command came to: refused, nothing to do, or a new queue. */
function changeQueue(state: RoomState, queue: Queue | ErrorCode | undefined): Step {
  if (typeof queue === "string") return refuse(queue);
  if (queue === undefined || queue.rev === (state.queue?.rev ?? 0)) return done(state);
  const added = queue.items.length - (state.queue?.items.length ?? 0);
  return done(
    { ...state, queue },
    added > 0 ? { type: "queueChanged", added } : { type: "queueChanged" },
  );
}

/**
 * Whether the room may move on to the next item by itself (#52): the setting is on, an item
 * waits, and the PO is here to stop it.
 */
function canAdvance(state: RoomState): boolean {
  return (
    state.settings.autoAdvance === true &&
    (state.queue?.items.length ?? 0) > 0 &&
    isPresent(participant(state, state.ownerId))
  );
}

/**
 * The countdown after a recorded final has run out: the next item starts. Its start is
 * `now`, not the deadline: the team's time on it runs from when it shows. `settle` keeps
 * the countdown from outliving what allows it, as long as the state came from `apply`.
 */
function resolveAdvance(state: RoomState, round: Round, now: number): Done {
  if (round.advanceAt === undefined || round.advanceAt > now) return { state, causes: [] };
  const item = state.queue?.items[0];
  if (item && canAdvance(state)) return startItem(state, item, now);
  return { state: withRound(state, withoutAdvance(round)), causes: [{ type: "advanceHeld" }] };
}

/**
 * A vote, or a change of vote. Vote causes (here, in `retractVote` and in `settle`)
 * always name the voter: a vote changes only while Voting, when others learn who voted
 * but never what, or after a named reveal. The protocol still strips `who` from vote
 * causes after an anonymous reveal, as defence in depth.
 */
function castVote(state: RoomState, actor: UserId, card: unknown, made: MadeFor): Step {
  const round = state.round;
  if (!round) return refuse("no_round");
  if (otherRound(round, made)) return refuse("round_changed");
  if (!isVoter(state, actor)) return refuse("not_voter");
  const previous = ownVote(round, actor);
  // `allowChangeAfterReveal` applies to named rounds only: an anonymous round locks its
  // votes at reveal. Who may still change shrinks as people leave, become observers or
  // the PO stops voting, so any change to the public card list would point at someone.
  // The round's own `anonymous` flag decides, not the current setting. The setting changes
  // a vote, it never adds one: a first card played after seeing everyone's is anchored on
  // them, so someone with no vote in the round is refused after the reveal.
  if (
    round.phase === "revealed" &&
    (!state.settings.allowChangeAfterReveal || round.anonymous || !previous)
  ) {
    return refuse("round_revealed");
  }
  if (typeof card !== "string" || !deckCards(round.deck, round.specials).includes(card)) {
    return refuse("bad_card");
  }
  if (previous?.card === card) return done(state);
  const vote: Vote = round.phase === "revealed" ? { card, changedAfterReveal: true } : { card };
  return done(withRound(state, { ...round, votes: { ...round.votes, [actor]: vote } }), {
    type: "voteCast",
    who: actor,
  });
}

function retractVote(state: RoomState, actor: UserId, made: MadeFor): Step {
  const round = state.round;
  if (round && otherRound(round, made)) return refuse("round_changed");
  if (round?.phase !== "voting") return refuse("not_voting");
  if (!ownVote(round, actor)) return done(state);
  return done(withRound(state, { ...round, votes: omit(round.votes, actor) }), {
    type: "voteRetracted",
    who: actor,
  });
}

/** The round a vote or retract was made for, as the command says it. */
type MadeFor = { round?: unknown; restart?: unknown };

/**
 * A vote made for another round than the current one: a command still in flight when the
 * PO started the next round, or restarted this one with a new deck (#26). Without
 * `round` or `restart` (a command the server built) any round goes.
 */
function otherRound(round: Round, { round: number, restart }: MadeFor): boolean {
  return (
    (number !== undefined && number !== round.number) ||
    (restart !== undefined && restart !== (round.restarts ?? 0))
  );
}

function setFinal(state: RoomState, card: unknown, now: number): Step {
  const round = state.round;
  if (round?.phase !== "revealed") return refuse("not_revealed");
  if (typeof card !== "string" || !baseCards(round.deck).includes(card)) return refuse("bad_card");
  if (round.final === card) return done(state);
  const recorded = { ...withoutAdvance(round), final: card };
  // Another final restarts the countdown: the PO is still deciding, and the team reading.
  // After "Stay on this round" none starts: that holds for the whole round.
  return canAdvance(state) && round.stayed !== true
    ? done(
        withRound(state, { ...recorded, advanceAt: now + AUTO_ADVANCE_MS }),
        { type: "finalSet", card },
        { type: "advanceArmed" },
      )
    : done(withRound(state, recorded), { type: "finalSet", card });
}

function updateSettings(state: RoomState, patch: unknown, now: number): Step {
  const patched = patchSettings(state.settings, patch);
  if (!patched.ok) return refuse(patched.error);
  const settings = patched.settings;
  const before = canonicalSettings(state.settings);
  if (sameJson(settings, before)) return done(state);
  if (
    settings.observersCount &&
    !state.settings.observersCount &&
    countedPeople({ ...state, settings }) > MAX_PARTICIPANTS
  ) {
    return refuse("room_full");
  }
  const next: RoomState = { ...state, settings };
  const updated: Cause = sameJson(settings.restriction, before.restriction)
    ? { type: "settingsUpdated" }
    : { type: "settingsUpdated", restriction: true };
  const round = state.round;
  if (
    round?.phase !== "voting" ||
    (sameJson(canonicalDeck(round.deck), settings.deck) &&
      sameJson(round.specials, settings.specials))
  ) {
    return done(next, updated);
  }
  // A new deck or new specials during Voting restart the round: same subject and number.
  // It starts over as any round does, timer included: a new deadline and start when the
  // room has a timer, none otherwise (a timer the PO started by hand stops), and a time
  // that was up is no longer up.
  const restarted: Round = {
    ...withoutTimer(round),
    deck: canonicalDeck(settings.deck),
    specials: [...settings.specials],
    votes: {},
    startedAt: now,
    restarts: (round.restarts ?? 0) + 1,
  };
  if (settings.timer.seconds !== null) {
    restarted.deadlineAt = now + settings.timer.seconds * 1000;
    restarted.timerStartedAt = now;
  }
  return {
    ...done(withRound(next, restarted), updated, {
      type: "roundStarted",
      number: round.number,
      restarted: true,
    }),
    ended: round,
  };
}

/**
 * After a successful command, while Voting: drop the votes of people who are no longer
 * voters (they left, were kicked, became observers, or are a PO who no longer votes),
 * each with a `voteRetracted` cause, then
 * reveal when `revealWhenAllVoted` is on and every eligible voter (a voter who is not
 * away) has voted. A leave, kick, role or settings change can complete a round too;
 * `reveals` false only drops. Revealed: a countdown to the next item stops once the queue is
 * empty, the setting off or the PO gone or away.
 */
function settle(
  state: RoomState,
  now: number,
  reveals = true,
): { state: RoomState; causes: Cause[] } {
  const round = state.round;
  if (round?.advanceAt !== undefined && !canAdvance(state)) {
    return { state: withRound(state, withoutAdvance(round)), causes: [{ type: "advanceHeld" }] };
  }
  if (round?.phase !== "voting") return { state, causes: [] };
  const pruned = Object.keys(round.votes).filter((id) => !isVoter(state, id));
  const current =
    pruned.length === 0
      ? round
      : {
          ...round,
          votes: Object.fromEntries(
            Object.entries(round.votes).filter(([id]) => !pruned.includes(id)),
          ),
        };
  // Each dropped vote is announced, so its owner sees why their card left the table.
  const causes = pruned.map((who): Cause => ({ type: "voteRetracted", who }));
  const eligible = Object.keys(state.participants).filter(
    (id) => isVoter(state, id) && isPresent(state.participants[id]),
  );
  const everyoneVoted =
    reveals &&
    state.settings.revealWhenAllVoted &&
    eligible.length > 0 &&
    eligible.every((id) => ownVote(current, id));
  if (everyoneVoted) {
    return {
      state: withRound(state, reveal(current, now)),
      causes: [...causes, { type: "revealed", by: "everyoneVoted" }],
    };
  }
  return { state: current === round ? state : withRound(state, current), causes };
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

/**
 * Who may reveal by hand (#28, ADR-011): the PO always, whether or not they vote; under
 * `whoCanReveal: "anyone"`, every voter too (`isVoter`). An observer never.
 */
function mayReveal(state: RoomState, id: UserId): boolean {
  return id === state.ownerId || (state.settings.whoCanReveal === "anyone" && isVoter(state, id));
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

/**
 * Removes a person (a leave or a kick). While Voting, `settle` then drops their vote.
 * After a named reveal their card stays on the table with the name they had (#19), since
 * no seat names them any more; an anonymous round keeps the card alone.
 */
function removeParticipant(state: RoomState, id: UserId): RoomState {
  const next: RoomState = { ...state, participants: omit(state.participants, id) };
  const round = state.round;
  const vote = round?.phase === "revealed" && !round.anonymous ? ownVote(round, id) : undefined;
  if (!round || !vote) return next;
  const { name } = state.participants[id] as Participant;
  return withRound(next, { ...round, votes: { ...round.votes, [id]: { ...vote, name } } });
}

function omit<T>(record: Record<string, T>, key: string): Record<string, T> {
  return Object.fromEntries(Object.entries(record).filter(([k]) => k !== key));
}

/** The round without a timer: no deadline, no start, no "time is up". */
function withoutTimer(round: Round): Round {
  const next = { ...round };
  delete next.deadlineAt;
  delete next.timerStartedAt;
  delete next.timeUpAt;
  return next;
}

/** The round without a countdown to the next item. */
function withoutAdvance(round: Round): Round {
  const next = { ...round };
  delete next.advanceAt;
  return next;
}

/** The round revealed at `at`; a running timer stops. */
function reveal(round: Round, at: number): Round {
  return { ...withoutTimer(round), phase: "revealed", revealedAt: at };
}
