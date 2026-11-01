import type { CauseView, RoomView, RoundView } from "@pp/protocol";
import { type LiveEvent, liveEvents } from "../room/announcements.ts";
import type { RevealSummary } from "../room/results-view.ts";
import {
  FADE_AWAY_MS,
  FLIP_MS,
  FLIP_STAGGER_MS,
  revealSettleMs,
  TRAVEL_MS,
} from "../table/reveal-motion.ts";
import type { SoundName } from "./sound-recipes.ts";

// What a change of the room sounds like (#44; docs/03-design-brief.md, "Sound"). Pure, so
// the timing is tested without audio; `sound-effects.ts` plays it. The news is the live
// region's (`liveEvents`), so a sound follows the rules a sentence does: a changed card
// before the reveal is not news, and nobody hears a card's value in it. Each cue lands on
// what the eye sees, or would see, in a hidden tab too, which is what sound is for.

export interface Cue {
  sound: SoundName;
  afterMs: number;
  /** Cents off the sound's pitch. */
  detune: number;
}

/** Someone else's card is down this far into its drop: `EASE` spends most of it early. */
const LANDED_MS = 150;
/** A flip turns edge-on this far into its 650 ms, for the same reason: the card's flick. */
const EDGE_ON_MS = 85;
/** After an anonymous reveal the mini cards are dealt this far apart (design brief). */
const DEAL_STAGGER_MS = 70;
/** Cents, in turn, so that sixteen cards riffle and do not rattle like a machine. */
const RIFFLE = [0, 70, -40, 110, -80];
/** The timer ticks through this many last seconds: as many ticks, each a semitone higher. */
export const LAST_SECONDS = 5;

const cue = (sound: SoundName, afterMs = 0, detune = 0): Cue => ({ sound, afterMs, detune });
const riffled = (i: number) => RIFFLE[i % RIFFLE.length] ?? 0;
const isConsensus = (summary: RevealSummary | undefined) => summary?.kind === "consensus";

/** The two rounds are one: same number, same start (a deck's restart starts it again). */
const sameRound = (a: RoundView | null | undefined, b: RoundView | null | undefined) =>
  a != null && b != null && a.number === b.number && a.startedAt === b.startedAt;

/**
 * The reveal: its two notes at once, a flick per card as it turns or is dealt, and a
 * consensus when the cards have settled, as the pill pops. Under reduced motion nothing
 * turns and nothing waits, so no flicks, and the consensus follows the two notes.
 */
function revealCues(round: RoundView | null, summary: RevealSummary | undefined, reduced: boolean) {
  const cues = [cue("reveal")];
  if (round?.phase !== "revealed") return cues;
  // A vote with a name left the room: it has no seat to turn over on.
  const count = round.anonymous
    ? round.cards.length
    : round.votes.filter((vote) => vote.name === undefined).length;
  if (!reduced) {
    for (let i = 0; i < count; i += 1) {
      const afterMs = round.anonymous
        ? FADE_AWAY_MS + i * DEAL_STAGGER_MS
        : EDGE_ON_MS + i * FLIP_STAGGER_MS;
      cues.push(cue("flip", afterMs, riffled(i)));
    }
  }
  if (isConsensus(summary)) {
    const settled = reduced ? FLIP_MS : revealSettleMs(count, round.anonymous);
    cues.push(cue("consensus", settled));
  }
  return cues;
}

/**
 * The sounds of the change from `previous` to `next`. A first snapshot says nothing: a
 * page that opens on a revealed round has seen nothing happen. Of a vote that came with
 * the reveal only the reveal is heard, as it is seen. The viewer's own card has no event
 * (`liveEvents` leaves their actions out), so it is read from `yourVote`: it lands at the
 * end of its flight, and a take-back places nothing. A card changed after the reveal turns
 * over, for whoever changed it too, with a consensus if that is what the change made.
 */
export function soundCues(
  next: RoomView,
  causes: readonly CauseView[],
  previous: RoomView | null,
  reduced: boolean,
): Cue[] {
  if (previous === null) return [];
  const events: LiveEvent[] = liveEvents(next, causes, previous);
  const revealed = events.find((event) => event.kind === "revealed");
  if (revealed) return revealCues(next.round, revealed.summary, reduced);

  const cues: Cue[] = [];
  const round = next.round;
  const own = round?.yourVote;
  const ownBefore = sameRound(round, previous.round) ? previous.round?.yourVote : undefined;
  const ownMoved = own !== undefined && own !== ownBefore;
  if (ownMoved && round?.phase === "voting") {
    cues.push(cue("card", reduced ? 0 : TRAVEL_MS + LANDED_MS));
  }
  if (events.some((event) => event.kind === "voted")) {
    cues.push(cue("card", reduced ? 0 : LANDED_MS));
  }
  const changes = events.filter((event) => event.kind === "changed");
  const turned = changes.some((event) => event.change !== undefined);
  if (!reduced && (turned || (ownMoved && round?.phase === "revealed"))) {
    cues.push(cue("flip", EDGE_ON_MS));
  }
  if (changes.some((event) => isConsensus(event.summary))) {
    cues.push(cue("consensus", reduced ? 0 : FLIP_MS));
  }
  return cues;
}

/**
 * The timer's last seconds: a tick as each of "0:05" to "0:01" shows, each a semitone above
 * the last. Laid out in advance from the deadline, so a page that sees it late (a reload
 * at 0:03) starts at the second it is in.
 */
export function timerCues(deadlineAt: number, serverNow: number): Cue[] {
  const left = deadlineAt - serverNow;
  const cues: Cue[] = [];
  for (let second = LAST_SECONDS; second >= 1; second -= 1) {
    const afterMs = left - second * 1000;
    if (afterMs >= 0) cues.push(cue("tick", afterMs, (LAST_SECONDS - second) * 100));
  }
  return cues;
}
