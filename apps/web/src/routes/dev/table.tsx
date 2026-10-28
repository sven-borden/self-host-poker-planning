import { cardValue } from "@pp/domain";
import { createFileRoute, useSearch } from "@tanstack/react-router";
import { useT } from "../../i18n/hooks.ts";
import { avatarLooks } from "../../table/avatar.tsx";
import { cardLabel, HandCard, MiniCard } from "../../table/cards.tsx";
import type { TablePerson } from "../../table/seat.tsx";
import { TableStage } from "../../table/table-stage.tsx";

// A test bench for the table (#13), not linked from the UI and not indexed. The route is
// split into its own chunk, so nothing here weighs on the room route's budget; the search
// is parsed in the component for that reason (a validateSearch would ship in the entry).
// /dev/table?n=1..16&state=lobby|voting|revealed&observers=0..4&away=0|1&changed=0|1
// The first person is the viewer and the second the PO (the first when alone). With
// away=1, every fourth person (index 3, 7, 11, 15) and the second observer are away. With
// changed=1 and state=revealed, every card on the table was changed after the reveal (#29).

const STATES = ["lobby", "voting", "revealed"] as const;
type DevState = (typeof STATES)[number];

function wholeNumber(value: unknown, min: number, max: number, fallback: number): number {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isInteger(number) ? Math.min(max, Math.max(min, number)) : fallback;
}

export const Route = createFileRoute("/dev/table")({
  component: DevTable,
});

function useBenchSearch() {
  const search: Record<string, unknown> = useSearch({ strict: false });
  return {
    n: wholeNumber(search.n, 1, 16, 8),
    state: STATES.find((state) => state === search.state) ?? ("voting" as DevState),
    observers: wholeNumber(search.observers, 0, 4, 0),
    away: wholeNumber(search.away, 0, 1, 0) === 1,
    changed: wholeNumber(search.changed, 0, 1, 0) === 1,
  };
}

// Names of every length, with accents, so truncation and initials get exercised.
const NAMES = [
  "Sven Borden",
  "Ana Lima",
  "Ben Okafor",
  "Chloé Dubois",
  "Dmitri Volkov",
  "Eva Müller",
  "Farah Haddad",
  "Gustav Lindqvist",
  "Hana Sato",
  "Ibrahim Diallo",
  "Jérôme Lefebvre-Martin",
  "Kasia Nowak",
  "Liam O’Brien",
  "Maximilian Oberhuber-Schwarz",
  "Noor",
  "Zoë Stewart",
];
const OBSERVERS = ["Olivia Chen", "Paul Meier", "Quentin Roy", "Rosa Bianchi"];
// Cards as played, by seat. Every third person (index 2, 5, 8, …) does not vote, so the
// specials and the long labels sit on voters' seats and show face up after reveal: the
// specials from 6 people on, the long labels from 11.
const PLAYED = [
  "5",
  "8",
  "3",
  "13",
  "?",
  "5",
  "☕",
  "100",
  "2",
  "∞",
  "WWWW",
  "8",
  "XXL",
  "👍🏽👍",
  "3",
  "21",
];
// Labels up to the domain's 4 graphemes, wide letters and emoji included.
const DECK = [
  "0",
  "1",
  "2",
  "3",
  "5",
  "8",
  "13",
  "21",
  "34",
  "100",
  "XXL",
  "WWWW",
  "👍🏽👍",
  "?",
  "☕",
  "∞",
];

function DevTable() {
  const t = useT();
  const { n, state, observers, away, changed } = useBenchSearch();
  // Every third person is still thinking (or did not vote, after reveal).
  const voted = (i: number) => i % 3 !== 2;
  const seated = NAMES.slice(0, n).map((name, i) => ({ id: `user-${i}`, name }));
  const watching = OBSERVERS.slice(0, observers).map((name, i) => ({ id: `observer-${i}`, name }));
  const looks = avatarLooks([...seated, ...watching]);
  const people: TablePerson[] = seated.map(({ id, name }, i) => ({
    id,
    name,
    you: i === 0,
    owner: i === Math.min(1, n - 1),
    away: away && i % 4 === 3,
    look: looks.get(id),
    status:
      state === "lobby"
        ? { kind: "present" }
        : state === "voting"
          ? { kind: voted(i) ? "voted" : "thinking" }
          : voted(i)
            ? { kind: "revealed", card: PLAYED[i] ?? "5", ...(changed && { changed: true }) }
            : { kind: "revealed", card: null },
  }));
  const votes = people.filter((_, i) => voted(i)).length;
  const played = people.flatMap((person) =>
    person.status.kind === "revealed" && person.status.card ? [person.status.card] : [],
  );
  // A sample of a computed number in the reader's language (5.5 reads 5,5 in French);
  // the real results panel arrives with #20.
  const numbers = played.flatMap((card) => {
    const value = cardValue(card);
    return value === null ? [] : [value];
  });
  const average =
    numbers.length > 0 ? numbers.reduce((sum, value) => sum + value, 0) / numbers.length : null;

  return (
    <section>
      <meta name="robots" content="noindex" />
      <h1 className="text-2xl font-[760] [font-stretch:110%]">{t("dev.tableTitle")}</h1>
      <p className="mt-2 max-w-prose text-sm text-ink-2">{t("dev.tableLede")}</p>
      <TableStage
        className="mt-6"
        people={people}
        observers={watching.map((observer, i) => ({
          ...observer,
          away: away && i === 1,
          look: looks.get(observer.id),
        }))}
      >
        {state === "voting" ? (
          <p className="m-0">{t("table.votedSoFar", { count: votes, total: n })}</p>
        ) : null}
      </TableStage>
      {average === null ? null : (
        <p data-average className="mt-4 text-sm text-ink-2">
          {t("dev.average", { value: average })}
        </p>
      )}
      <h2 className="mt-8 font-mono text-xs font-medium tracking-[0.08em] text-ink-2 uppercase">
        {t("dev.hand")}
      </h2>
      <fieldset
        aria-label={t("cards.yourCards")}
        className="mt-2 flex min-w-0 gap-2 overflow-x-auto border-t border-line bg-surface px-3 pt-5 pb-4 sm:justify-center"
      >
        {DECK.map((value) => (
          <HandCard
            key={value}
            value={value}
            label={cardLabel(t, value)}
            selected={state !== "lobby" && value === "5"}
            disabled={state === "revealed"}
          />
        ))}
      </fieldset>
      <h2 className="mt-8 font-mono text-xs font-medium tracking-[0.08em] text-ink-2 uppercase">
        {t("dev.miniCards")}
      </h2>
      <div className="mt-2 flex flex-wrap gap-[5px]">
        {(played.length > 0 ? played : PLAYED.slice(0, n)).map((value, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: a fixed sample that never reorders.
          <MiniCard key={i} value={value} />
        ))}
      </div>
    </section>
  );
}
