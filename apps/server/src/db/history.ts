/**
 * What a finished round leaves in `round_history`. Pure, so it is tested without a
 * database. A named round keeps who voted what, with the name they had; an anonymous
 * round keeps the cards alone, in display order, with no user id, no name and no order
 * that follows the people.
 */
import { computeResults, type Participant, type Round, type UserId } from "@pp/domain";
import type { HistoryVotes, NamedHistoryVote, roundHistory } from "./schema.ts";

/**
 * A round an `apply` ended (`ApplyResult.ended`). `participants` gives the voters' names:
 * the room before and after the command, so a name is found when it is anywhere.
 */
export interface EndedRound {
  round: Round;
  participants: Readonly<Record<UserId, Pick<Participant, "name" | "joinedAt">>>;
  /** When the round ended, epoch milliseconds. */
  finishedAt: number;
}

export type HistoryRow = typeof roundHistory.$inferInsert;

/** Only a revealed round is history; an abandoned or restarted voting round is not. */
export function isHistory(ended: EndedRound | undefined): ended is EndedRound {
  return ended?.round.phase === "revealed";
}

/** The `round_history` row of a revealed round. */
export function historyRow(roomId: string, ended: EndedRound): HistoryRow {
  const { round, finishedAt } = ended;
  const cards = Object.values(round.votes).map((vote) => vote.card);
  const stats = computeResults(cards, round.deck);
  return {
    roomId,
    number: round.number,
    subject: round.subject,
    deck: { spec: round.deck, specials: [...round.specials] },
    votes: historyVotes(ended, stats.distribution),
    stats,
    final: round.final ?? null,
    startedAt: new Date(round.startedAt),
    // The domain sets `revealedAt` on every reveal; the fallback is for typing only.
    revealedAt: new Date(round.revealedAt ?? round.startedAt),
    finishedAt: new Date(finishedAt),
  };
}

function historyVotes(
  { round, participants }: EndedRound,
  distribution: readonly { card: string; count: number }[],
): HistoryVotes {
  if (round.anonymous) {
    // Expanded from the distribution, so the order is the deck's, never the people's.
    return {
      kind: "anonymous",
      cards: distribution.flatMap(({ card, count }) => Array<string>(count).fill(card)),
    };
  }
  const present = (who: UserId) => Object.hasOwn(participants, who);
  const voters = Object.keys(round.votes);
  // People still known first, by when they joined, then id; then those who left, by id.
  const known = voters
    .filter(present)
    .sort(
      (a, b) => (participants[a]?.joinedAt ?? 0) - (participants[b]?.joinedAt ?? 0) || byUnit(a, b),
    );
  const departed = voters.filter((who) => !present(who)).sort(byUnit);
  return {
    kind: "named",
    votes: [...known, ...departed].map((who) => {
      const vote = round.votes[who];
      const entry: NamedHistoryVote = {
        who,
        // `hasOwn`: an id such as "constructor" must not find Object.prototype's.
        // Someone who left after the reveal: the name the domain kept with the vote (#19).
        name: present(who) ? (participants[who]?.name ?? null) : (vote?.name ?? null),
        card: vote?.card ?? "",
      };
      if (vote?.changedAfterReveal) entry.changedAfterReveal = true;
      return entry;
    }),
  };
}

function byUnit(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
