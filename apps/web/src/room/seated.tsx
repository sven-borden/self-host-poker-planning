import type { ParticipantView, RoomView as RoomSnapshotView } from "@pp/protocol";
import { OctagonXIcon } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { useT } from "../i18n/hooks.ts";
import { cardLabel } from "../table/cards.tsx";
import { Hand } from "../table/hand.tsx";
import { TableStage } from "../table/table-stage.tsx";
import { type Box, CardFlight, type Flight } from "./card-flight.tsx";
import { failureMessage } from "./failure.ts";
import { confirmedOf, shownCard, withShownVote } from "./hand-state.ts";
import { LiveAnnouncer } from "./live-announcer.tsx";
import { RoundCentre } from "./round-centre.tsx";
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
 */
export function Seated({ room, me, focusOnMount, onFocused, onLeaving }: SeatedProps) {
  const t = useT();
  const ids = { hint: useId() };
  const vote = useVote();
  const shown = withShownVote(room, shownCard(vote.state, confirmedOf(room)));
  const { people, observers, looks } = tableData(shown);
  const hand = handView(shown, me);
  const [startFailure, setStartFailure] = useState<string | null>(null);
  const [flight, setFlight] = useState<Flight | null>(null);
  const flights = useRef(0);

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
    // Nothing laid out (a seat beyond the table's 16, or a test without layout): no trip.
    if (!slot || slot.width === 0 || from.width === 0) {
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
          ? t("hand.hintLobby")
          : t("hand.hintRevealed");
  const news = vote.news;

  return (
    <div className="flex flex-col gap-6">
      <section aria-label={t("room.tableHeading")} data-room-table>
        <TableStage
          people={people}
          observers={observers}
          hiddenSlot={flight?.kind === "play" ? me.id : null}
        >
          <RoundCentre room={shown} onFailure={setStartFailure} />
        </TableStage>
        <LiveAnnouncer />
        {startFailure !== null ? (
          <p role="alert" className="mt-3 flex items-start justify-center gap-2 text-sm">
            <OctagonXIcon aria-hidden className="mt-0.5 size-4 shrink-0 text-bad" />
            {failureMessage(t, startFailure)}
          </p>
        ) : null}
      </section>
      {hand.kind === "cards" ? (
        <div data-room-hand className="rounded-xl border border-line bg-surface pb-3">
          <Hand
            cards={hand.cards}
            selected={shown.round?.yourVote ?? null}
            disabled={!hand.playable}
            describedBy={ids.hint}
            onPick={pick}
          />
          <p id={ids.hint} className="m-0 px-4 text-center text-sm text-ink-2">
            {hint}
          </p>
          {vote.error !== null && vote.error.round === (room.round?.number ?? null) ? (
            <p role="alert" className="mx-4 mt-2 flex items-start justify-center gap-2 text-sm">
              <OctagonXIcon aria-hidden className="mt-0.5 size-4 shrink-0 text-bad" />
              {failureMessage(t, vote.error.code)}
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
        <CardFlight key={flight.id} flight={flight} onDone={() => setFlight(null)} />
      ) : null}
      <YouControls
        me={me}
        look={looks.get(me.id)}
        focusOnMount={focusOnMount}
        onFocused={onFocused}
        onLeaving={onLeaving}
      />
    </div>
  );
}
