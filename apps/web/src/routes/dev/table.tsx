import { createFileRoute, useSearch } from "@tanstack/react-router";
import { useT } from "../../i18n/i18n-context.tsx";
import { cardLabel, HandCard, MiniCard } from "../../table/cards.tsx";
import type { TablePerson } from "../../table/seat.tsx";
import { TableStage } from "../../table/table-stage.tsx";

// A test bench for the table (#13), not linked from the UI and not indexed. The route is
// split into its own chunk, so nothing here weighs on the room route's budget; the search
// is parsed in the component for that reason (a validateSearch would ship in the entry).
// /dev/table?n=1..16&state=lobby|voting|revealed&observers=0..4

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
  const { n, state, observers } = useBenchSearch();
  // Every third person is still thinking (or did not vote, after reveal).
  const voted = (i: number) => i % 3 !== 2;
  const people: TablePerson[] = NAMES.slice(0, n).map((name, i) => ({
    id: `user-${i}`,
    name,
    status:
      state === "lobby"
        ? { kind: "present" }
        : state === "voting"
          ? { kind: voted(i) ? "voted" : "thinking" }
          : { kind: "revealed", card: voted(i) ? (PLAYED[i] ?? "5") : null },
  }));
  const votes = people.filter((_, i) => voted(i)).length;
  const played = people.flatMap((person) =>
    person.status.kind === "revealed" && person.status.card ? [person.status.card] : [],
  );

  return (
    <section>
      <meta name="robots" content="noindex" />
      <h1 className="text-2xl font-[760] [font-stretch:110%]">{t("dev.tableTitle")}</h1>
      <p className="mt-2 max-w-prose text-sm text-ink-2">{t("dev.tableLede")}</p>
      <TableStage
        className="mt-6"
        people={people}
        observers={OBSERVERS.slice(0, observers).map((name, i) => ({ id: `observer-${i}`, name }))}
      >
        {state === "voting" ? (
          <p className="m-0">{t("table.votedSoFar", { count: votes, total: n })}</p>
        ) : null}
      </TableStage>
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
