import type { RoomView } from "@pp/protocol";
import { useId, useLayoutEffect, useRef } from "react";
import { useT } from "../i18n/hooks.ts";
import type { TFunction } from "../i18n/i18n.ts";
import { cardLabel, isSpecialCard, MiniCard } from "../table/cards.tsx";
import { cancelAll, dealIn, play, prefersReducedMotion } from "../table/reveal-motion.ts";

/** A named vote whose person has no seat; `name` is unknown for an old departed vote. */
type OffTableVote = { who: string; card: string; name: string | undefined };

/**
 * Under the table after a reveal (#19): the seam #20 builds the results around
 * (`[data-results]`).
 * - Anonymous: every card played, face up, in the deck's order (`round.cards`), dealt in
 *   when the reveal happens on screen (`live`), shown at rest after a reload. Nothing
 *   here belongs to a person: no name, id, order or attribute ties a card to anyone.
 * - Named: the seats show the cards of the voters at the table; this lists every other
 *   vote, "Not at the table": a voter who left after the reveal (with the name the server
 *   kept), one who switched to observer after it, or one who left and came back as an
 *   observer. The vote still counts, so it shows somewhere.
 */
export function RevealedCards({ room, live }: { room: RoomView; live: boolean }) {
  const round = room.round;
  if (round?.phase !== "revealed") return null;
  if (round.anonymous) {
    return round.cards.length > 0 ? <DealtCards cards={round.cards} live={live} /> : null;
  }
  const people = new Map(room.participants.map((p) => [p.id, p]));
  const offTable = round.votes.flatMap((vote): OffTableVote[] => {
    const person = people.get(vote.who);
    if (person?.role === "voter") return [];
    return [{ who: vote.who, card: vote.card, name: vote.name ?? person?.name }];
  });
  return offTable.length > 0 ? <OffTableVotes votes={offTable} /> : null;
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

function offTableLabel(t: TFunction, name: string, card: string): string {
  return isSpecialCard(card)
    ? t("table.seatCardWord", { name, card: cardLabel(t, card) })
    : t("table.seatCard", { name, card });
}

function OffTableVotes({ votes }: { votes: readonly OffTableVote[] }) {
  const t = useT();
  const caption = useId();
  return (
    <div
      data-results="off-table"
      className="mt-3 flex flex-wrap items-center justify-center gap-x-4 gap-y-2"
    >
      <p id={caption} className={CAPTION}>
        {t("results.offTable")}
      </p>
      <ul
        aria-labelledby={caption}
        className="m-0 flex list-none flex-wrap justify-center gap-x-4 gap-y-2 p-0"
      >
        {votes.map((vote) => {
          const name = vote.name ?? t("results.someone");
          return (
            <li key={vote.who} data-off-table className="flex items-center gap-1.5">
              <MiniCard value={vote.card} />
              {/* Up to two lines, the whole name on hover; the list item's one accessible
                  name is the sr-only sentence. */}
              <span
                aria-hidden="true"
                dir="auto"
                title={name}
                className="line-clamp-2 max-w-32 text-[12px] leading-tight break-words text-ink-2"
              >
                <bdi>{name}</bdi>
              </span>
              <span className="sr-only">{offTableLabel(t, name, vote.card)}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
