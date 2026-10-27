import type { RoomView } from "@pp/protocol";
import { useId, useLayoutEffect, useRef } from "react";
import { useT } from "../i18n/hooks.ts";
import type { TFunction } from "../i18n/i18n.ts";
import { cardLabel, isSpecialCard, MiniCard } from "../table/cards.tsx";
import { cancelAll, dealIn, play, prefersReducedMotion } from "../table/reveal-motion.ts";

type NamedVote = { who: string; card: string; name?: string | undefined };

/**
 * Under the table after a reveal (#19): the seam #20 builds the results around
 * (`[data-results]`).
 * - Anonymous: every card played, face up, in the deck's order (`round.cards`), dealt in
 *   when the reveal happens on screen (`live`), shown at rest after a reload. Nothing
 *   here belongs to a person: no name, id, order or attribute ties a card to anyone.
 * - Named: the seats show the cards; this lists only the cards of voters who left after
 *   the reveal, with the name they had, since they no longer have a seat.
 */
export function RevealedCards({ room, live }: { room: RoomView; live: boolean }) {
  const round = room.round;
  if (round?.phase !== "revealed") return null;
  if (round.anonymous) {
    return round.cards.length > 0 ? <DealtCards cards={round.cards} live={live} /> : null;
  }
  const present = new Set(room.participants.map((p) => p.id));
  const departed = round.votes.filter((vote) => !present.has(vote.who));
  return departed.length > 0 ? <DepartedVotes votes={departed} /> : null;
}

const CAPTION = "m-0 font-mono text-[11px] tracking-[0.08em] text-ink-2 uppercase";

function DealtCards({ cards, live }: { cards: readonly string[]; live: boolean }) {
  const t = useT();
  const caption = useId();
  const list = useRef<HTMLUListElement>(null);
  // Only a reveal seen on screen deals; a reload or a late joiner sees the row at rest.
  const deal = useRef(live);

  useLayoutEffect(() => {
    if (!deal.current || !list.current) return;
    const reduced = prefersReducedMotion();
    const animations = [...list.current.children].map((item, i) => play(item, dealIn(i, reduced)));
    return () => cancelAll(animations);
  }, []);

  return (
    <div data-results="anonymous" className="mt-3 flex flex-col items-center gap-2">
      <p id={caption} className={CAPTION}>
        {t("results.cards")}
      </p>
      <ul
        ref={list}
        aria-labelledby={caption}
        data-results-row
        className="m-0 flex list-none flex-wrap justify-center gap-2 p-0"
      >
        {cards.map((card, i) => (
          // The index is the card's place in the deck's order, nothing about a person.
          // biome-ignore lint/suspicious/noArrayIndexKey: equal cards repeat; the list is fixed.
          <li key={i} className="flex">
            <MiniCard value={card} className="shadow-sm" />
            <span className="sr-only">{cardLabel(t, card)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function departedLabel(t: TFunction, name: string, card: string): string {
  return isSpecialCard(card)
    ? t("table.seatCardWord", { name, card: cardLabel(t, card) })
    : t("table.seatCard", { name, card });
}

function DepartedVotes({ votes }: { votes: readonly NamedVote[] }) {
  const t = useT();
  const caption = useId();
  return (
    <div
      data-results="departed"
      className="mt-3 flex flex-wrap items-center justify-center gap-x-4 gap-y-2"
    >
      <p id={caption} className={CAPTION}>
        {t("results.left")}
      </p>
      <ul
        aria-labelledby={caption}
        className="m-0 flex list-none flex-wrap justify-center gap-x-4 gap-y-2 p-0"
      >
        {votes.map((vote) => {
          const name = vote.name ?? t("results.someone");
          return (
            <li key={vote.who} data-departed className="flex items-center gap-1.5">
              <MiniCard value={vote.card} />
              <span
                aria-hidden="true"
                dir="auto"
                className="max-w-32 truncate text-[12px] text-ink-2"
              >
                <bdi>{name}</bdi>
              </span>
              <span className="sr-only">{departedLabel(t, name, vote.card)}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
