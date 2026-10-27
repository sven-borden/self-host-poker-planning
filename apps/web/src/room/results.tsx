import type { RoomView } from "@pp/protocol";
import { useId, useLayoutEffect, useRef } from "react";
import { useFormat, useT } from "../i18n/hooks.ts";
import { cn } from "../lib/utils.ts";
import { cardLabel, MiniCard } from "../table/cards.tsx";
import { cancelAll, play, prefersReducedMotion } from "../table/reveal-motion.ts";
import { ExtremeMark, extremeWord } from "../table/seat.tsx";
import { consensusPop, consensusPulse, riseBar, riseLabel, showAt } from "./results-motion.ts";
import {
  type ResultsModel,
  type RevealSummary,
  resultsModel,
  revealSummary,
  summarySentence,
} from "./results-view.ts";

// The results of a revealed round (#20): the table's centre (`CentreResult`) and the panel
// under the table (`ResultsPanel`). A chunk of its own, which `Seated` prefetches while a
// round is on (results-chunk.tsx), so the room route and the `seated` chunk carry none of it.
// The numbers are the server's `round.results` (the domain's `computeResults`), sorted by
// `resultsModel` and formatted in the reader's language and region.

/** How the results arrive: `live` when the page saw the round voting just before. */
export interface RevealMotion {
  live: boolean;
  /** When the cards are settled, in ms from the reveal (`revealSettleMs`). */
  settle: number;
}

const CAPTION = "m-0 font-mono text-[11px] tracking-[0.08em] text-ink-2 uppercase";
/** The tallest column, for the card played most. */
const BAR_MAX_PX = 56;
/** A column that counts never draws thinner than this. */
const BAR_MIN_PX = 4;

/**
 * Plays the results' motion once, when they mount on screen at a reveal (`live`); after a
 * reload they show at rest. Marks: `[data-show]` fades in, `[data-column]` rises (its
 * `[data-bar]` grows, its `[data-column-count]` drops in), `[data-pop]` pops and
 * `[data-pulse]` rings once.
 */
function useResultsMotion(root: { current: HTMLElement | null }, motion: RevealMotion) {
  const first = useRef(motion);
  useLayoutEffect(() => {
    const { live, settle } = first.current;
    const element = root.current;
    if (!live || !element) return;
    const reduced = prefersReducedMotion();
    const all = (selector: string) => [...element.querySelectorAll(selector)];
    const animations = [
      ...all("[data-show]").map((item) => play(item, showAt(settle, reduced))),
      ...all("[data-column]").flatMap((column, i) => [
        play(column.querySelector("[data-bar]"), riseBar(i, settle, reduced)),
        play(column.querySelector("[data-column-count]"), riseLabel(i, settle, reduced)),
      ]),
      ...all("[data-pop]").map((item) => play(item, consensusPop(settle, reduced))),
      ...all("[data-pulse]").map((item) => play(item, consensusPulse(settle, reduced))),
    ];
    return () => cancelAll(animations);
  }, [root]);
}

/** On a phone, the PO's centre also holds "Next round": the card shrinks to a chip. */
const CHIP =
  "in-data-[variant=phone]:h-[18px] in-data-[variant=phone]:w-auto in-data-[variant=phone]:min-w-[15px] in-data-[variant=phone]:rounded-[3px] in-data-[variant=phone]:px-[3px] in-data-[variant=phone]:text-[11px]";

/** The line under the card: the agreement, or "Tie". */
const CENTRE_CAPTION =
  "min-w-0 text-center text-[12px]/tight font-semibold tabular-nums in-data-[variant=phone]:text-[10px]/tight";

interface CentreResultProps {
  room: RoomView;
  /** The PO's centre, which also holds "Next round": side by side, wrapping on phones. */
  compact: boolean;
  motion: RevealMotion;
}

/**
 * The table's centre after a reveal (docs/03-design-brief.md, "The table"): the suggested
 * card with the team's agreement under it ("Agreement 67%", the panel's word: how much
 * the team agrees, not the suggestion's support), the tied cards with "Tie" on a deck
 * without numbers, the card and a "Consensus" pill when everyone agrees, or "Nothing to
 * count." when no card counts. A sentence says it to screen readers; the cards, the
 * caption and the pill are drawn for the eye.
 */
export function CentreResult({ room, compact, motion }: CentreResultProps) {
  const round = room.round;
  if (round?.phase !== "revealed") return null;
  return <Centre summary={revealSummary(round)} compact={compact} motion={motion} />;
}

function Centre({
  summary,
  compact,
  motion,
}: {
  summary: RevealSummary;
  compact: boolean;
  motion: RevealMotion;
}) {
  const t = useT();
  const root = useRef<HTMLParagraphElement>(null);
  useResultsMotion(root, motion);
  const sentence = summarySentence(t, summary);
  const cards =
    summary.kind === "tie" ? summary.cards : summary.kind === "none" ? [] : [summary.card];
  return (
    <p
      ref={root}
      data-centre-status="revealed"
      data-centre-result={summary.kind}
      className={cn(
        "m-0 flex items-center justify-center",
        // The PO's phone centre stays narrower than the space between the side cards and
        // as short as it can: the agreement beside the chip, on two lines ("Agreement" over
        // "25%"); the pill, or "Tie", under the chip or chips.
        compact
          ? cn(
              "flex-row gap-x-1.5 gap-y-0.5 whitespace-nowrap in-data-[variant=phone]:gap-x-1 in-data-[variant=phone]:whitespace-normal",
              summary.kind === "suggested"
                ? "in-data-[variant=phone]:max-w-[76px]"
                : "flex-wrap in-data-[variant=phone]:max-w-[68px]",
            )
          : "flex-col gap-1",
      )}
    >
      {summary.kind === "none" ? (
        <span data-show>{sentence}</span>
      ) : (
        <>
          <span className="sr-only">{sentence}</span>
          <span data-show className="flex flex-wrap justify-center gap-1">
            {cards.map((card) => (
              <MiniCard key={card} value={card} className={cn("shadow-md", compact && CHIP)} />
            ))}
          </span>
          {summary.kind === "consensus" ? (
            <span
              aria-hidden="true"
              data-pop
              className="relative rounded-full bg-brass-soft px-2 py-0.5 text-[11px]/tight font-semibold whitespace-nowrap text-brass-ink in-data-[variant=phone]:px-1.5 in-data-[variant=phone]:text-[10px]/tight"
            >
              <span
                data-pulse
                className="pointer-events-none absolute -inset-0.5 rounded-full border-2 border-brass opacity-0"
              />
              {t("results.consensus")}
            </span>
          ) : (
            <span aria-hidden="true" data-show data-centre-caption className={CENTRE_CAPTION}>
              {summary.kind === "tie"
                ? t("results.tie")
                : t("results.agreementShort", { agreement: summary.agreement })}
            </span>
          )}
        </>
      )}
    </p>
  );
}

/** A statistic as the panel shows it, and as a screen reader says it when that differs. */
type Stat = { key: string; caption: string; value: { shown: string; spoken?: string } | null };

/**
 * The results panel under the table (docs/03-design-brief.md, "Results"): a labelled
 * region with the statistics as large tabular numbers over mono captions (Average,
 * Median, Agreement, Spread; Most voted, Agreement, Spread for a deck without numbers),
 * the lowest and highest voters of a named round, the distribution (a column per card
 * played, in the deck's order, its height by count) and the special cards, listed but not
 * counted. Anonymous rounds show the same columns and nothing that points at a person:
 * they replace #19's "Cards played" row.
 */
export function ResultsPanel({ room, motion }: { room: RoomView; motion: RevealMotion }) {
  const model = resultsModel(room);
  return model === null ? null : <Panel model={model} motion={motion} />;
}

function Panel({ model, motion }: { model: ResultsModel; motion: RevealMotion }) {
  const t = useT();
  const format = useFormat();
  const ids = { title: useId(), columns: useId(), uncounted: useId(), note: useId() };
  const root = useRef<HTMLElement>(null);
  useResultsMotion(root, motion);

  const decimal = (value: number | null) =>
    value === null ? null : { shown: format.number(value, { maximumFractionDigits: 1 }) };
  const [low, high] = model.spread ?? [null, null];
  const stats: Stat[] = [
    ...(model.numeric
      ? [
          { key: "average", caption: t("results.average"), value: decimal(model.average) },
          { key: "median", caption: t("results.median"), value: decimal(model.median) },
        ]
      : [
          {
            key: "mostVoted",
            caption: t("results.mostVoted"),
            value:
              model.mostVoted.length === 0
                ? null
                : model.mostVoted.length === 1
                  ? { shown: model.mostVoted.join("") }
                  : { shown: model.mostVoted.join(" · "), spoken: format.list(model.mostVoted) },
          },
        ]),
    {
      key: "agreement",
      caption: t("results.agreement"),
      value:
        model.agreement === null
          ? null
          : {
              shown: format.number(model.agreement, {
                style: "percent",
                maximumFractionDigits: 0,
              }),
            },
    },
    {
      key: "spread",
      caption: t("results.spread"),
      value:
        low === null || high === null
          ? null
          : low === high
            ? { shown: low }
            : { shown: `${low}–${high}`, spoken: t("results.spreadRange", { low, high }) },
    },
  ];
  const top = Math.max(1, ...model.columns.map((column) => column.count));

  return (
    <section
      ref={root}
      aria-labelledby={ids.title}
      data-results-panel={model.anonymous ? "anonymous" : "named"}
      className="mt-4 flex flex-col items-center gap-5 rounded-xl border border-line bg-surface px-4 py-5"
    >
      <h2 id={ids.title} className="sr-only">
        {t("results.title")}
      </h2>
      {/* The numbers show at once; only the columns move. A deck without numbers has three
          statistics: on a phone the spread takes the second row whole, so "XS–XXL" stays
          on one line. */}
      <dl
        data-stats
        className={cn(
          "m-0 grid w-full max-w-xl gap-x-4 gap-y-4",
          stats.length === 4 ? "grid-cols-2 sm:grid-cols-4" : "grid-cols-2 sm:grid-cols-3",
        )}
      >
        {stats.map((stat) => (
          <div
            key={stat.key}
            data-stat={stat.key}
            className={cn(
              "flex flex-col-reverse items-center gap-1 text-center",
              stats.length === 3 && stat.key === "spread" && "col-span-2 sm:col-span-1",
            )}
          >
            <dt className={CAPTION}>{stat.caption}</dt>
            <dd className="m-0 font-display text-[28px]/none font-extrabold whitespace-nowrap tabular-nums [font-stretch:110%] phone:text-[24px]/none">
              {stat.value === null ? (
                <>
                  <span aria-hidden="true">—</span>
                  <span className="sr-only">{t("results.noValue")}</span>
                </>
              ) : stat.value.spoken === undefined ? (
                stat.value.shown
              ) : (
                <>
                  <span aria-hidden="true">{stat.value.shown}</span>
                  <span className="sr-only">{stat.value.spoken}</span>
                </>
              )}
            </dd>
          </div>
        ))}
      </dl>
      {model.extremes.length > 0 ? (
        <ul
          data-extremes
          aria-label={t("results.extremes")}
          className="m-0 flex w-full list-none flex-col items-center gap-2 p-0 sm:flex-row sm:flex-wrap sm:justify-center sm:gap-x-8"
        >
          {model.extremes.map(({ extreme, card, names }) => {
            const named = names.map((name) => name ?? t("results.someone"));
            return (
              <li
                key={extreme}
                data-extreme={extreme}
                className="flex max-w-full items-center gap-2 text-sm"
              >
                <ExtremeMark extreme={extreme} size={18} />
                <span aria-hidden="true" className={CAPTION}>
                  {t(extreme === "low" ? "results.lowest" : "results.highest")}
                </span>
                <MiniCard value={card} />
                <span aria-hidden="true" dir="auto" className="min-w-0 break-words">
                  <bdi>{format.list(named)}</bdi>
                </span>
                <span className="sr-only">
                  {t(extreme === "low" ? "results.lowestNames" : "results.highestNames", {
                    card: cardLabel(t, card),
                    names: format.list(named),
                  })}
                </span>
              </li>
            );
          })}
        </ul>
      ) : null}
      {model.columns.length + model.uncounted.length > 0 ? (
        <div className="flex flex-wrap items-end justify-center gap-x-8 gap-y-4">
          {model.columns.length > 0 ? (
            <div className="flex flex-col items-center gap-2">
              {/* The list's name; hidden itself, so it is read once. */}
              <p id={ids.columns} aria-hidden="true" className={CAPTION}>
                {t("results.distribution")}
              </p>
              {/* Narrower on a phone, so the 11 cards of a deck fit one row at 360 px. */}
              <ul
                aria-labelledby={ids.columns}
                data-distribution
                className="m-0 flex list-none flex-wrap items-end justify-center gap-x-2 gap-y-3 p-0 phone:gap-x-0.5"
              >
                {model.columns.map((column) => (
                  <li
                    key={column.card}
                    data-column
                    data-extreme={column.extreme}
                    className="flex w-9 flex-col items-center gap-1 phone:w-6"
                  >
                    <span
                      aria-hidden="true"
                      data-column-count
                      className="flex items-center gap-0.5 text-[12px]/none font-semibold tabular-nums"
                    >
                      {column.extreme ? <ExtremeMark extreme={column.extreme} size={13} /> : null}
                      {format.number(column.count)}
                    </span>
                    <span
                      aria-hidden="true"
                      data-bar
                      className="pp-bar block w-6 origin-bottom rounded-t-[3px] phone:w-5"
                      style={{
                        height: Math.max(BAR_MIN_PX, Math.round((column.count / top) * BAR_MAX_PX)),
                      }}
                    />
                    <MiniCard
                      value={column.card}
                      className="phone:h-[34px] phone:w-6 phone:text-[12px]"
                    />
                    <span className="sr-only">
                      {[
                        t("results.cardVotes", {
                          card: cardLabel(t, column.card),
                          count: column.count,
                        }),
                        ...(column.extreme ? [extremeWord(t, column.extreme)] : []),
                      ].join(", ")}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {model.uncounted.length > 0 ? (
            <div data-uncounted className="flex max-w-56 flex-col items-center gap-2">
              <p id={ids.uncounted} aria-hidden="true" className={CAPTION}>
                {t("results.notCounted")}
              </p>
              <ul
                aria-labelledby={ids.uncounted}
                aria-describedby={ids.note}
                className="m-0 flex list-none flex-wrap justify-center gap-3 p-0"
              >
                {model.uncounted.map(({ card, count }) => (
                  <li key={card} className="flex items-center gap-1">
                    <MiniCard value={card} />
                    <span aria-hidden="true" className="text-[12px] font-semibold tabular-nums">
                      ×{format.number(count)}
                    </span>
                    <span className="sr-only">
                      {t("results.cardVotes", { card: cardLabel(t, card), count })}
                    </span>
                  </li>
                ))}
              </ul>
              <p id={ids.note} className="m-0 text-center text-[12px] text-ink-2">
                {t("results.notCountedNote")}
              </p>
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
