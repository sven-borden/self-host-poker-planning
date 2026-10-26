/**
 * The per-viewer projection (architecture, section 5). This is where the secrecy promise
 * is kept: a card never leaves the server before reveal (except to the person who played
 * it), and in an anonymous round no message ever maps a person to a card.
 *
 * Every view is built field by field from an allow-list, never by copying a domain
 * object, so a field the domain adds later stays on the server until it is added here.
 */
import {
  type Cause,
  computeResults,
  type DeckSpec,
  type Participant,
  type RoomSettings,
  type RoomState,
  type Round,
  type Subject,
  type UserId,
  type Vote,
} from "@pp/domain";
import type {
  CauseView,
  ParticipantView,
  RoomSettingsView,
  RoundView,
  Snapshot,
  SubjectView,
} from "./schemas.ts";
import { PROTOCOL_VERSION } from "./version.ts";

export type SnapshotMeta = {
  /** The room code the viewer entered with. */
  code: string;
  /** The room's stored version after this change. */
  version: number;
  /** The server's clock, in epoch milliseconds. */
  now: number;
  /** The causes of the `apply` this snapshot follows; none on enter or reconnect. */
  causes?: readonly Cause[];
};

/** The room as `viewer` may see it. Pure: the server calls it once per socket. */
export function toSnapshot(state: RoomState, viewer: UserId, meta: SnapshotMeta): Snapshot {
  const people = participantOrder(state);
  const order = people.map(([id]) => id);
  return {
    protocol: PROTOCOL_VERSION,
    version: meta.version,
    serverNow: meta.now,
    room: {
      code: meta.code,
      ownerId: state.ownerId,
      settings: settingsView(state.settings),
      participants: people.map(([id, p]) => participantView(id, p, state.ownerId)),
      you: Object.hasOwn(state.participants, viewer) ? viewer : null,
      round: state.round ? roundView(state.round, order, viewer) : null,
    },
    causes: projectCauses(meta.causes ?? [], state.round),
  };
}

/**
 * The causes as every viewer may see them. In an anonymous round after reveal, vote
 * causes lose `who` (the domain already leaves it out; this is defence in depth). No
 * cause carries a card except `finalSet`. A cause type this code does not know is dropped.
 */
export function projectCauses(causes: readonly Cause[], round: Round | null): CauseView[] {
  const hideVoter = round?.anonymous === true && round.phase === "revealed";
  const views: CauseView[] = [];
  for (const cause of causes) {
    const view = causeView(cause, hideVoter);
    if (view) views.push(view);
  }
  return views;
}

function causeView(cause: Cause, hideVoter: boolean): CauseView | null {
  switch (cause.type) {
    case "joined":
    case "left":
    case "kicked":
    case "renamed":
      return { type: cause.type, who: cause.who };
    case "roleChanged":
      return { type: cause.type, who: cause.who, role: cause.role };
    case "roundStarted":
      return cause.restarted
        ? { type: cause.type, number: cause.number, restarted: true }
        : { type: cause.type, number: cause.number };
    case "voteCast":
    case "voteRetracted":
      return hideVoter || cause.who === undefined
        ? { type: cause.type }
        : { type: cause.type, who: cause.who };
    case "revealed":
      return { type: cause.type, by: cause.by };
    case "timerStarted":
    case "timerStopped":
    case "timerExtended":
    case "timeUp":
    case "settingsUpdated":
      return { type: cause.type };
    case "finalSet":
      return { type: cause.type, card: cause.card };
    case "ownerChanged":
      return { type: cause.type, by: cause.by, to: cause.to };
    default:
      return null;
  }
}

/** Code-unit order: the same on every engine and locale. */
function byId(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** The participants by `joinedAt`, then by id. Never by voting order. */
function participantOrder(state: RoomState): Array<[UserId, Participant]> {
  return Object.entries(state.participants).sort(
    ([a, p], [b, q]) => p.joinedAt - q.joinedAt || byId(a, b),
  );
}

function participantView(id: UserId, p: Participant, ownerId: UserId): ParticipantView {
  return {
    id,
    name: p.name,
    role: p.role,
    ...(p.avatar !== undefined ? { avatar: p.avatar } : {}),
    connected: p.connected,
    away: p.awaySince !== undefined,
    isOwner: id === ownerId,
  };
}

function deckView(deck: DeckSpec): DeckSpec {
  return deck.kind === "preset"
    ? { kind: "preset", id: deck.id }
    : { kind: "custom", cards: [...deck.cards] };
}

function settingsView(s: RoomSettings): RoomSettingsView {
  return {
    deck: deckView(s.deck),
    specials: [...s.specials],
    whoCanReveal: s.whoCanReveal,
    revealNames: s.revealNames,
    revealWhenAllVoted: s.revealWhenAllVoted,
    timer: { seconds: s.timer.seconds, revealAtEnd: s.timer.revealAtEnd },
    allowChangeAfterReveal: s.allowChangeAfterReveal,
    poVotes: s.poVotes,
    observersCount: s.observersCount,
  };
}

function subjectView(subject: Subject): SubjectView {
  switch (subject.kind) {
    case "title":
      return { kind: "title", text: subject.text };
    case "link":
      return subject.key !== undefined
        ? { kind: "link", url: subject.url, key: subject.key }
        : { kind: "link", url: subject.url };
    default:
      return { kind: "none" };
  }
}

function voteOf(round: Round, id: UserId): Vote | undefined {
  return Object.hasOwn(round.votes, id) ? round.votes[id] : undefined;
}

/**
 * Everyone holding a vote: participants in participant order, then the votes of people
 * who left after the reveal (the domain keeps those) by id. Never in voting order.
 * Keeping the departed votes matters in anonymous rounds: dropping a card when its
 * owner leaves would tie that card to that person.
 */
function voterOrder(round: Round, order: readonly UserId[]): Array<[UserId, Vote]> {
  const present = new Set(order);
  const departed = Object.keys(round.votes)
    .filter((id) => !present.has(id))
    .sort(byId);
  const voters: Array<[UserId, Vote]> = [];
  for (const id of [...order, ...departed]) {
    const vote = voteOf(round, id);
    if (vote) voters.push([id, vote]);
  }
  return voters;
}

function roundView(round: Round, order: readonly UserId[], viewer: UserId): RoundView {
  const voters = voterOrder(round, order);
  const own = voteOf(round, viewer);
  const base = {
    number: round.number,
    subject: subjectView(round.subject),
    startedAt: round.startedAt,
    ...(round.deadlineAt !== undefined ? { deadlineAt: round.deadlineAt } : {}),
    deck: deckView(round.deck),
    specials: [...round.specials],
    voted: voters.map(([id]) => id),
    ...(own !== undefined ? { yourVote: own.card } : {}),
  };
  if (round.phase === "voting") return { ...base, phase: "voting", anonymous: round.anonymous };

  const results = computeResults(
    voters.map(([, vote]) => vote.card),
    round.deck,
  );
  const revealed = {
    ...base,
    phase: "revealed" as const,
    // A revealed round always has `revealedAt`; the fallback only satisfies the type.
    revealedAt: round.revealedAt ?? round.startedAt,
    ...(round.final !== undefined ? { final: round.final } : {}),
    results,
  };
  if (round.anonymous) {
    // Deck order (the distribution's order), so nothing follows the voters or the votes.
    const sorted = results.distribution.flatMap(({ card, count }) =>
      Array.from({ length: count }, () => card),
    );
    return { ...revealed, anonymous: true, cards: sorted };
  }
  return {
    ...revealed,
    anonymous: false,
    votes: voters.map(([who, vote]) => ({
      who,
      card: vote.card,
      changedAfterReveal: vote.changedAfterReveal === true,
    })),
  };
}
