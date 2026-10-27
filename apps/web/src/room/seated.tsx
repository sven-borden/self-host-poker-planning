import type { ParticipantView, RoomView as RoomSnapshotView } from "@pp/protocol";
import { OctagonXIcon } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { useT } from "../i18n/hooks.ts";
import { cn } from "../lib/utils.ts";
import { cardLabel } from "../table/cards.tsx";
import { Hand } from "../table/hand.tsx";
import { revealSettleMs } from "../table/reveal-motion.ts";
import { TableStage } from "../table/table-stage.tsx";
import { type Box, CardFlight, type Flight, type InAir } from "./card-flight.tsx";
import { failureMessage } from "./failure.ts";
import { inSight, useHandDock } from "./hand-dock.ts";
import { confirmedOf, shownCard, withShownVote } from "./hand-state.ts";
import { LiveAnnouncer } from "./live-announcer.tsx";
import { NextSubject, useNextRound } from "./next-round.tsx";
import { prefetchResults, ResultsPanel } from "./results-chunk.tsx";
import { RevealedCards } from "./revealed-cards.tsx";
import { RoundCentre } from "./round-centre.tsx";
import { RoundSubject } from "./round-subject.tsx";
import { handView, tableData } from "./table-data.ts";
import { useVote } from "./use-vote.ts";
import { YouControls } from "./you-controls.tsx";

/** A flight that never reports its end (a background tab) stops hiding the slot. */
const FLIGHT_TIMEOUT_MS = 1500;

interface SeatedProps {
  room: RoomSnapshotView;
  /** The viewer as the snapshot lists them. */
  me: ParticipantView;
  focusOnMount: boolean;
  onFocused: () => void;
  onLeaving: (leaving: boolean) => void;
}

/** One round in one phase: a new round, or the reveal, changes it. */
const keyOf = (
  round: RoomSnapshotView["round"] | { number: number; startedAt: number; phase: string },
) => (round === null ? "lobby" : `${round.number}:${round.startedAt}:${round.phase}`);

const boxOf = (rect: DOMRect): Box => ({
  left: rect.left,
  top: rect.top,
  width: rect.width,
  height: rect.height,
});

/**
 * The room once the viewer is in it: the table from #13, filled from the snapshot (who is
 * here, away or voted, the PO and the viewer, #17), the round's status in its centre and
 * the live region that announces it, the viewer's hand (#18), and their own panel. A
 * chunk of its own (`RoomView` loads it lazily and prefetches it when the page mounts):
 * the table only shows once a snapshot has arrived, so the chunk loads beside the socket
 * and stays out of the room route's initial budget.
 *
 * The viewer's unconfirmed pick (`useVote`) is folded into the room they see
 * (`withShownVote`): their seat, the count in the centre and the hand agree at once, and
 * settle on the server's snapshot when the ack comes back.
 *
 * The reveal (#19): the table turns the cards over by itself (a seat's card seen face
 * down that turns up flips), and `RevealedCards` lists a named round's votes without a
 * seat under the table. The results (#20) fill the centre and a panel under the table,
 * from a chunk prefetched while a round is on; they rise once the cards are settled when
 * this page saw the round voting just before (`liveReveal`). After a reload everything
 * shows at rest.
 *
 * The next round (#21): the round and its subject show above the table for everyone
 * (`RoundSubject`); the PO's subject field sits above that (`NextSubject`), and the
 * centre's button starts the round with it.
 */
export function Seated({ room, me, focusOnMount, onFocused, onLeaving }: SeatedProps) {
  const t = useT();
  const ids = { hint: useId() };
  const vote = useVote();
  const shown = withShownVote(room, shownCard(vote.state, confirmedOf(room)));
  const { people, observers, looks } = tableData(shown);
  const hand = handView(shown, me);
  /** A refused start or reveal; a new round or phase clears it. */
  const [centreFailure, setCentreFailure] = useState<string | null>(null);
  const next = useNextRound(setCentreFailure);
  const roundKey = keyOf(room.round);
  const [seen, setSeen] = useState({ key: roundKey, liveReveal: false });
  if (seen.key !== roundKey) {
    // The round moved on: from voting to revealed while on screen is a live reveal.
    const round = room.round;
    const liveReveal =
      round?.phase === "revealed" && seen.key === keyOf({ ...round, phase: "voting" });
    setSeen({ key: roundKey, liveReveal });
    setCentreFailure(null);
  }
  const inRound = room.round !== null;
  useEffect(() => {
    // A reveal is in sight: load the results' module now, so the reveal draws it at once.
    if (inRound) prefetchResults();
  }, [inRound]);
  const faceUp = people.filter((p) => p.status.kind === "revealed" && p.status.card !== null);
  const reveal = {
    live: seen.liveReveal,
    settle: revealSettleMs(faceUp.length, room.round?.anonymous === true),
  };
  const [flight, setFlight] = useState<Flight | null>(null);
  const flights = useRef(0);
  const handPanel = useRef<HTMLDivElement>(null);
  // While the team votes, an upright phone docks the hand at the bottom of the screen,
  // within thumb reach whatever part of the table is in view (#22), when the screen leaves
  // the table, "Reveal cards" and the viewer's seat clear above it (`useHandDock`). Only
  // while voting: the results, which come with the reveal, sit above the hand and must
  // never be covered.
  const docked = useHandDock(hand.kind === "cards" && hand.playable, handPanel);
  /** An interrupted flight's card, for the next one to start from. */
  const inAir = useRef<InAir | null>(null);

  useEffect(() => {
    if (flight === null) return;
    const timer = setTimeout(() => setFlight(null), FLIGHT_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [flight]);

  function pick(card: string, element: HTMLButtonElement) {
    const wish = vote.pick(card);
    if (wish === undefined) return;
    const slot = document
      .querySelector("[data-room-table] [data-slot-card][data-you]")
      ?.getBoundingClientRect();
    const from = element.getBoundingClientRect();
    const dock = docked ? (handPanel.current?.getBoundingClientRect() ?? null) : null;
    // Nothing laid out (a seat beyond the table's 16, or a test without layout), or a slot
    // out of sight (scrolled away, or under the docked hand): no trip, the card only lifts.
    if (
      !slot ||
      slot.width === 0 ||
      from.width === 0 ||
      !inSight(slot, document.documentElement.clientHeight, dock)
    ) {
      setFlight(null);
      return;
    }
    flights.current += 1;
    setFlight({
      id: flights.current,
      value: card,
      kind: wish === null ? "return" : "play",
      hand: boxOf(from),
      slot: boxOf(slot),
    });
  }

  const hint =
    hand.kind !== "cards"
      ? ""
      : hand.reason === "voting"
        ? t("hand.hintVoting")
        : hand.reason === "lobby"
          ? t(me.isOwner ? "hand.hintLobbyOwner" : "hand.hintLobby")
          : t("hand.hintRevealed");
  const news = vote.news;

  return (
    <div className="flex flex-col gap-6 phone:gap-3">
      {me.isOwner ? (
        <NextSubject
          next={next}
          nextNumber={(room.round?.number ?? 0) + 1}
          canStart={room.round?.phase !== "voting"}
        />
      ) : null}
      <section aria-label={t("room.tableHeading")} data-room-table>
        {room.round !== null ? <RoundSubject round={room.round} /> : null}
        <TableStage
          people={people}
          observers={observers}
          hiddenSlot={flight?.kind === "play" ? me.id : null}
        >
          <RoundCentre room={shown} onFailure={setCentreFailure} next={next} reveal={reveal} />
        </TableStage>
        <RevealedCards room={room} />
        {room.round?.phase === "revealed" ? <ResultsPanel room={room} motion={reveal} /> : null}
        <LiveAnnouncer />
        {centreFailure !== null ? (
          <p role="alert" className="mt-3 flex items-start justify-center gap-2 text-sm">
            <OctagonXIcon aria-hidden className="mt-0.5 size-4 shrink-0 text-bad" />
            {failureMessage(t, centreFailure)}
          </p>
        ) : null}
      </section>
      {hand.kind === "cards" ? (
        <div
          ref={handPanel}
          data-room-hand
          data-hand-dock={docked || undefined}
          className={cn(
            // On a phone the padding clears the home indicator, docked or not, so the
            // panel measures the same in both states (`useHandDock`).
            "rounded-xl border border-line bg-surface pb-3 phone:pb-[max(0.5rem,env(safe-area-inset-bottom))]",
            // Docked, it is a sheet on the bottom edge.
            "thumb:data-hand-dock:sticky thumb:data-hand-dock:bottom-0 thumb:data-hand-dock:z-20 thumb:data-hand-dock:rounded-b-none thumb:data-hand-dock:border-b-0 thumb:data-hand-dock:shadow-panel",
          )}
        >
          <Hand
            cards={hand.cards}
            selected={shown.round?.yourVote ?? null}
            disabled={!hand.playable}
            describedBy={ids.hint}
            onPick={pick}
          />
          {/* Docked, the hint is for screen readers only: the dock stays one card high in every language. */}
          <p
            id={ids.hint}
            data-hand-hint
            className={cn(
              "m-0 px-4 text-center text-sm text-ink-2 phone:text-xs",
              docked && "sr-only",
            )}
          >
            {hint}
          </p>
          {vote.error !== null && vote.error.round === (room.round?.number ?? null) ? (
            <p role="alert" className="mx-4 mt-2 flex items-start justify-center gap-2 text-sm">
              <OctagonXIcon aria-hidden className="mt-0.5 size-4 shrink-0 text-bad" />
              {/* A take-back refused after the reveal says what a refused vote says. */}
              {failureMessage(
                t,
                vote.error.code === "not_voting" ? "round_revealed" : vote.error.code,
              )}
            </p>
          ) : null}
          {/* The viewer's own vote, said to them once it is confirmed; never to anyone else. */}
          <div role="status" data-hand-live className="sr-only">
            {news === null ? null : (
              <span key={news.id}>
                {news.what.kind === "voted"
                  ? t("hand.youVoted", { card: cardLabel(t, news.what.card) })
                  : t("hand.retracted")}
              </span>
            )}
          </div>
        </div>
      ) : hand.kind === "owner" ? (
        <p data-room-hand="owner" className="m-0 text-center text-sm text-ink-2">
          {t("hand.ownerDoesNotVote")}
        </p>
      ) : null}
      {flight !== null ? (
        <CardFlight key={flight.id} flight={flight} carry={inAir} onDone={() => setFlight(null)} />
      ) : null}
      <YouControls
        me={me}
        look={looks.get(me.id)}
        focusOnMount={focusOnMount}
        onFocused={onFocused}
        onLeaving={onLeaving}
        votes={hand.kind !== "owner"}
        namesake={[...people, ...observers].find((person) => person.id === me.id)?.namesake}
      />
    </div>
  );
}
