import type { RoomView } from "@pp/protocol";
import { useId } from "react";
import { useT } from "../i18n/hooks.ts";
import type { TFunction } from "../i18n/i18n.ts";
import { cardLabel, isSpecialCard, MiniCard } from "../table/cards.tsx";
import { type Extreme, ExtremeMark, extremeWord, shownName } from "../table/seat.tsx";
import { namesakes } from "./namesakes.ts";
import { extremeOf } from "./results-view.ts";

/** A named vote whose person has no seat; `name` is unknown for an old departed vote. */
type OffTableVote = {
  who: string;
  card: string;
  name: string | undefined;
  /** The round's lowest or highest card, marked as on a seat (#20). */
  extreme: Extreme | undefined;
  /** Changed after the reveal (#29), before its person left the table. */
  changed: boolean;
};

/**
 * Under the table after a named reveal (#19): the seats show the cards of the voters at
 * the table; this lists every other vote, "Not at the table": a voter who left after the
 * reveal (with the name the server kept), one who switched to observer after it, or one
 * who left and came back as an observer. The vote still counts, so it shows somewhere,
 * with the seats' arrow when it is the lowest or the highest card (#20). An anonymous
 * round has no such row: its cards show only in the results' columns (#20), which tie
 * none to anyone, or in `PlayedCards` when the results cannot load.
 */
export function RevealedCards({ room }: { room: RoomView }) {
  const t = useT();
  const round = room.round;
  if (round?.phase !== "revealed" || round.anonymous) return null;
  const people = new Map(room.participants.map((p) => [p.id, p]));
  const numbers = namesakes(room.participants);
  const offTable = round.votes.flatMap((vote): OffTableVote[] => {
    const person = people.get(vote.who);
    if (person?.role === "voter") return [];
    return [
      {
        who: vote.who,
        card: vote.card,
        // Someone still in the room goes by the name the seats show (numbered); someone
        // who left, by the name the server kept.
        name: person
          ? shownName(t, { name: person.name, namesake: numbers.get(person.id) })
          : vote.name,
        extreme: extremeOf(round, vote.card),
        changed: vote.changedAfterReveal,
      },
    ];
  });
  return offTable.length > 0 ? <OffTableVotes votes={offTable} /> : null;
}

const CAPTION = "m-0 font-mono text-[11px] tracking-[0.08em] text-ink-2 uppercase";

/** As a seat says it: "Hana, card 2, lowest card, changed after the reveal". */
function offTableLabel(t: TFunction, vote: OffTableVote, name: string): string {
  const { card, extreme } = vote;
  const label = isSpecialCard(card)
    ? t("table.seatCardWord", { name, card: cardLabel(t, card) })
    : t("table.seatCard", { name, card });
  return [
    label,
    ...(extreme ? [extremeWord(t, extreme)] : []),
    ...(vote.changed ? [t("table.changed")] : []),
  ].join(", ");
}

/**
 * An anonymous round's cards, face up in the deck's order (`round.cards`), when the
 * results' chunk cannot load: the round's cards still show somewhere, tied to nobody.
 */
export function PlayedCards({ cards }: { cards: readonly string[] }) {
  const t = useT();
  const caption = useId();
  return (
    <div data-results="anonymous" className="mt-3 flex flex-col items-center gap-2">
      <p id={caption} aria-hidden="true" className={CAPTION}>
        {t("results.cards")}
      </p>
      <ul
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

function OffTableVotes({ votes }: { votes: readonly OffTableVote[] }) {
  const t = useT();
  const caption = useId();
  return (
    <div
      data-results="off-table"
      className="mt-3 flex flex-wrap items-center justify-center gap-x-4 gap-y-2"
    >
      <p id={caption} aria-hidden="true" className={CAPTION}>
        {t("results.offTable")}
      </p>
      <ul
        aria-labelledby={caption}
        className="m-0 flex list-none flex-wrap justify-center gap-x-4 gap-y-2 p-0"
      >
        {votes.map((vote) => {
          const name = vote.name ?? t("results.someone");
          return (
            <li
              key={vote.who}
              data-off-table
              data-extreme={vote.extreme}
              className="flex items-center gap-1.5"
            >
              {vote.extreme ? <ExtremeMark extreme={vote.extreme} size={16} /> : null}
              <span className="relative flex">
                <MiniCard value={vote.card} />
                {vote.changed ? (
                  <span
                    aria-hidden="true"
                    data-changed-chip
                    className="absolute top-full left-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-brass-soft px-1 text-[9px]/[12px] font-semibold whitespace-nowrap text-brass-ink ring-1 ring-surface forced-colors:translate-y-px forced-colors:border forced-colors:border-[CanvasText]"
                  >
                    {t("table.changedChip")}
                  </span>
                ) : null}
              </span>
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
              <span className="sr-only">{offTableLabel(t, vote, name)}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
