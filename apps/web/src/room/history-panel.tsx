import type { HistoryRoundView } from "@pp/protocol";
import { ChevronDownIcon, EyeOffIcon, TimerIcon, XIcon } from "lucide-react";
import {
  type RefObject,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { Button } from "../components/ui/button.tsx";
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "../components/ui/sheet.tsx";
import { useFormat, useT } from "../i18n/hooks.ts";
import { cn } from "../lib/utils.ts";
import { type HistoryResult, requestHistory } from "../realtime/room-connection.ts";
import { useRoomStore } from "../stores/room-store.ts";
import { cardLabel, MiniCard } from "../table/cards.tsx";
import { HistorySummary } from "./history-summary.tsx";
import {
  CAPTION,
  durationSpoken,
  type HistoryList,
  historyKey,
  NO_ROUNDS,
  sameDay,
  shortDuration,
  votingTime,
  withEarlierPage,
  withFirstPage,
} from "./history-view.ts";
import { keyLabel, safeHref, shortUrl } from "./subject.ts";

/** A phone: the `phone:` variant in styles.css. The panel is a bottom sheet there. */
const PHONE_QUERY = "(max-width: 640px)";

function subscribePhone(onChange: () => void) {
  const query = window.matchMedia(PHONE_QUERY);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

const isPhone = () => window.matchMedia(PHONE_QUERY).matches;

/** The highest bar of a row's distribution. */
const BAR_MAX_PX = 20;
const BAR_MIN_PX = 3;

interface HistoryPanelProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Where the focus returns when the panel closes: the button that opened it. */
  returnFocus: RefObject<HTMLElement | null>;
  /** The room's name for the export files; null for a room without one (never its code). */
  roomName: string | null;
}

type Loading = "loading" | "ready" | "failed";

/**
 * The room's history (#33): the finished rounds, newest first, in a modal sheet like the
 * settings (#25), from the right on a wide screen and from the bottom on a phone. Each
 * round shows its number, subject, final estimate, a small distribution, how long the
 * voting took and when it ended; its votes open under it (a disclosure), names and cards
 * in a named round, the cards alone in an anonymous one. The first page is fetched on
 * every open, and again while open when a round starts or the table's round gets its
 * final, so a new row arrives without a reload; "Show earlier rounds" adds the next page
 * and moves the focus to its first round.
 */
export function HistoryPanel({ open, onOpenChange, returnFocus, roomName }: HistoryPanelProps) {
  const phone = useSyncExternalStore(subscribePhone, isPhone);
  const content = useRef<HTMLDivElement>(null);
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        ref={content}
        side={phone ? "bottom" : "right"}
        showCloseButton={false}
        className={cn(
          "gap-0 overflow-y-auto overscroll-contain border-line bg-surface",
          "scroll-pt-[var(--panel-head,0px)] scroll-pb-[env(safe-area-inset-bottom)]",
          "pb-[env(safe-area-inset-bottom)]",
          phone
            ? "max-h-[88dvh] rounded-t-2xl pr-[env(safe-area-inset-right)] pl-[env(safe-area-inset-left)]"
            : "w-full pr-[env(safe-area-inset-right)] sm:max-w-md",
        )}
        onOpenAutoFocus={(event) => {
          // The title takes the focus: the rounds load after the sheet opens.
          event.preventDefault();
          if (content.current) content.current.scrollTop = 0;
          content.current?.querySelector<HTMLElement>("[data-panel-title]")?.focus();
        }}
        onCloseAutoFocus={(event) => {
          // The button lives outside this chunk, so the dialog has no trigger of its own.
          event.preventDefault();
          returnFocus.current?.focus();
        }}
      >
        <HistoryBody side={!phone} roomName={roomName} />
      </SheetContent>
    </Sheet>
  );
}

function HistoryBody({ side, roomName }: { side: boolean; roomName: string | null }) {
  const t = useT();
  const head = useRef<HTMLDivElement>(null);
  const key = useRoomStore((state) => historyKey(state.snapshot?.room));
  const [list, setList] = useState<HistoryList>(NO_ROUNDS);
  const [loading, setLoading] = useState<Loading>("loading");
  const [earlier, setEarlier] = useState<"idle" | "loading" | "failed">("idle");
  const [expanded, setExpanded] = useState<ReadonlySet<number>>(new Set());
  /** The round whose disclosure takes the focus once its page is shown. */
  const [focusRound, setFocusRound] = useState<number | null>(null);
  /** Counts the first-page fetches: an answer that a newer one overtook is dropped. */
  const asked = useRef(0);

  const fetchFirst = useCallback(async () => {
    const ask = ++asked.current;
    const answer = await requestHistory();
    if (ask !== asked.current) return;
    if (!answer.ok) {
      // A refetch that fails keeps the rounds shown; only an empty panel says so.
      setLoading((now) => (now === "ready" ? now : "failed"));
      return;
    }
    setList((now) => withFirstPage(now, answer));
    setLoading("ready");
  }, []);

  // The first page on open (this body mounts with the sheet), and again when a round starts
  // or the table's round gets its final.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `key` is what asks again.
  useEffect(() => {
    void fetchFirst();
  }, [key, fetchFirst]);

  // The content's scroll padding follows the sticky head's height.
  useEffect(() => {
    const element = head.current;
    const box = element?.closest<HTMLElement>("[data-slot=sheet-content]");
    if (!element || !box || typeof ResizeObserver === "undefined") return;
    const follow = () => box.style.setProperty("--panel-head", `${element.offsetHeight}px`);
    follow();
    const observer = new ResizeObserver(follow);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (focusRound === null) return;
    document
      .querySelector<HTMLElement>(`[data-history-round='${focusRound}'] [data-history-toggle]`)
      ?.focus();
    setFocusRound(null);
  }, [focusRound]);

  async function showEarlier() {
    const before = list.next;
    if (before === undefined || earlier === "loading") return;
    setEarlier("loading");
    const answer: HistoryResult = await requestHistory({ before });
    if (!answer.ok) {
      setEarlier("failed");
      return;
    }
    setEarlier("idle");
    setList((now) => withEarlierPage(now, answer));
    const first = answer.rounds[0];
    if (first) setFocusRound(first.number);
  }

  const toggle = (number: number) =>
    setExpanded((now) => {
      const next = new Set(now);
      if (!next.delete(number)) next.add(number);
      return next;
    });

  return (
    <div data-history-panel>
      {/* The title and "Close" stay in sight while the rounds scroll under them. */}
      <div
        ref={head}
        data-panel-head
        className={cn(
          "sticky top-0 z-10 flex items-start gap-2 border-b border-line bg-surface py-2 pr-2 pl-4",
          side && "pt-[calc(0.5rem+env(safe-area-inset-top))]",
        )}
      >
        <SheetHeader className="flex-1 gap-1 px-0 py-2">
          <SheetTitle
            data-panel-title
            tabIndex={-1}
            className="text-xl font-[760] [font-stretch:110%] focus:outline-none"
          >
            {t("history.open")}
          </SheetTitle>
          <SheetDescription className="text-ink-2">{t("history.lede")}</SheetDescription>
        </SheetHeader>
        <SheetClose asChild>
          <Button variant="ghost" size="icon" className="shrink-0">
            <XIcon aria-hidden />
            <span className="sr-only">{t("common.close")}</span>
          </Button>
        </SheetClose>
      </div>
      <PanelLive />
      <HistorySummary roomName={roomName} />
      {loading === "loading" && list.rounds.length === 0 ? (
        <p role="status" data-history-loading className="m-0 px-4 py-6 text-ink-2">
          {t("history.loading")}
        </p>
      ) : loading === "failed" ? (
        <div data-history-failed className="flex flex-col items-start gap-3 px-4 py-6">
          <p role="alert" className="m-0 text-ink-2">
            {t("history.failed")}
          </p>
          <Button
            variant="outline"
            onClick={() => {
              setLoading("loading");
              void fetchFirst();
            }}
          >
            {t("history.retry")}
          </Button>
        </div>
      ) : list.rounds.length === 0 ? (
        <p data-history-empty className="m-0 px-4 py-6 text-ink-2">
          {t("history.empty")}
        </p>
      ) : (
        <>
          <ol
            aria-label={t("history.rounds")}
            data-history-list
            className="m-0 list-none divide-y divide-line p-0"
          >
            {list.rounds.map((round) => (
              <HistoryRow
                key={round.number}
                round={round}
                expanded={expanded.has(round.number)}
                onToggle={() => toggle(round.number)}
              />
            ))}
          </ol>
          {list.next !== undefined ? (
            <div className="flex flex-col items-start gap-2 border-t border-line px-4 py-4">
              <Button
                variant="outline"
                data-history-more
                aria-disabled={earlier === "loading"}
                onClick={showEarlier}
              >
                {t(earlier === "loading" ? "history.loadingMore" : "history.more")}
              </Button>
              {earlier === "failed" ? (
                <p role="alert" className="m-0 text-sm text-ink-2">
                  {t("history.failed")}
                </p>
              ) : null}
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}

/**
 * The table's live region, said again inside the panel: a modal dialog hides the page
 * from screen readers, so while it is open the table's announcements are heard from here
 * instead, each once (as in the settings panel).
 */
function PanelLive() {
  const said = useRoomStore((state) => state.said);
  const [since] = useState(() => useRoomStore.getState().said.id);
  return (
    <div role="status" data-panel-live className="sr-only">
      <span key={said.id}>{said.id > since ? said.text : ""}</span>
    </div>
  );
}

function HistoryRow({
  round,
  expanded,
  onToggle,
}: {
  round: HistoryRoundView;
  expanded: boolean;
  onToggle: () => void;
}) {
  const t = useT();
  const votesId = useId();
  const heading = useId();
  return (
    <li
      data-history-round={round.number}
      data-history-kind={round.votes.kind}
      aria-labelledby={heading}
      className="flex flex-col gap-2 px-4 py-3"
    >
      <div className="flex items-baseline justify-between gap-3">
        <h3 id={heading} className={CAPTION}>
          {t("round.number", { round: round.number })}
        </h3>
        <Ended at={round.finishedAt} />
      </div>
      <Subject round={round} />
      <div className="flex flex-wrap items-end gap-x-5 gap-y-2">
        <Final card={round.final} />
        <Distribution round={round} />
        <Duration round={round} />
      </div>
      {hasVotes(round) ? (
        <>
          <button
            type="button"
            data-history-toggle
            aria-expanded={expanded}
            aria-controls={votesId}
            aria-label={t("history.votesOf", { round: round.number })}
            onClick={onToggle}
            className="-mx-2 inline-flex min-h-11 items-center gap-1.5 self-start rounded-md px-2 text-sm font-semibold text-ink hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-brass"
          >
            <ChevronDownIcon
              aria-hidden
              className={cn(
                "size-4 text-ink-2 transition-transform motion-reduce:transition-none",
                expanded && "rotate-180",
              )}
            />
            {t("history.votes")}
          </button>
          <div id={votesId} hidden={!expanded} data-history-votes>
            {expanded ? <Votes round={round} /> : null}
          </div>
        </>
      ) : (
        // Nobody voted: nothing to open.
        <p data-history-no-votes className="m-0 text-sm text-ink-2">
          {t("history.noVotes")}
        </p>
      )}
    </li>
  );
}

/** Whether anyone voted in the round. */
const hasVotes = ({ votes }: HistoryRoundView) =>
  (votes.kind === "anonymous" ? votes.cards.length : votes.votes.length) > 0;

/** When the round ended: the time, or the date and time on another day. */
function Ended({ at }: { at: number }) {
  const t = useT();
  const format = useFormat();
  const today = sameDay(at, Date.now());
  const shown = today
    ? format.time(at)
    : format.date(at, { dateStyle: "medium", timeStyle: "short" });
  return (
    <p className="m-0 text-xs text-ink-2 tabular-nums">
      <time dateTime={new Date(at).toISOString()} aria-hidden="true">
        {shown}
      </time>
      <span className="sr-only">
        {today ? t("history.ended", { time: shown }) : t("history.endedOn", { date: shown })}
      </span>
    </p>
  );
}

/** The subject: a title (two lines at most), a link with its key, or nothing. */
function Subject({ round }: { round: HistoryRoundView }) {
  const t = useT();
  const { subject } = round;
  if (subject.kind === "none") return null;
  if (subject.kind === "title") {
    return (
      <p className="m-0 min-w-0">
        <bdi
          data-history-subject="title"
          title={subject.text}
          className="line-clamp-2 font-semibold break-words"
        >
          {subject.text}
        </bdi>
      </p>
    );
  }
  const href = safeHref(subject.url);
  if (href === null) {
    return (
      <p className="m-0 min-w-0 truncate" data-history-subject="text">
        <bdi>{shortUrl(subject.url)}</bdi>
      </p>
    );
  }
  return (
    <p className="m-0 flex min-w-0">
      <a
        data-history-subject="link"
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        title={subject.url}
        className="inline-flex min-h-8 min-w-0 items-center gap-1.5 rounded-md bg-surface-2 px-2 font-medium text-ink underline-offset-2 hover:underline phone:min-h-11"
      >
        {subject.key !== undefined ? (
          <span className="font-mono text-[13px] font-semibold text-spruce">
            {keyLabel(subject.key)}
          </span>
        ) : (
          <bdi className="min-w-0 truncate">{shortUrl(subject.url)}</bdi>
        )}{" "}
        <span className="sr-only">{t("round.opensInNewTab")}</span>
      </a>
    </p>
  );
}

function Final({ card }: { card: string | null }) {
  const t = useT();
  if (card === null) {
    return (
      <p data-history-final="" className="m-0 flex flex-col items-start gap-1">
        <span aria-hidden="true" className={CAPTION}>
          {t("final.short")}
        </span>
        <span aria-hidden="true" className="text-sm text-ink-2">
          {t("history.noFinal")}
        </span>
        <span className="sr-only">{t("history.noFinalSpoken")}</span>
      </p>
    );
  }
  return (
    <p data-history-final={card} className="m-0 flex flex-col items-start gap-1">
      <span aria-hidden="true" className={CAPTION}>
        {t("final.short")}
      </span>
      <MiniCard value={card} />
      <span className="sr-only">{t("history.finalSpoken", { card: cardLabel(t, card) })}</span>
    </p>
  );
}

/** The cards played and their counts, in the deck's order, as in the results (#20). */
function Distribution({ round }: { round: HistoryRoundView }) {
  const t = useT();
  const format = useFormat();
  const columns = round.stats.distribution;
  if (columns.length === 0) return null;
  const top = Math.max(1, ...columns.map((column) => column.count));
  return (
    <ul
      aria-label={t("results.distribution")}
      data-history-distribution
      className="m-0 flex list-none flex-wrap items-end gap-x-1 gap-y-2 p-0"
    >
      {columns.map((column) => (
        <li key={column.card} className="flex w-6 flex-col items-center gap-0.5">
          <span aria-hidden="true" className="text-[0.6875rem]/none font-semibold tabular-nums">
            {format.number(column.count)}
          </span>
          <span
            aria-hidden="true"
            className="pp-bar block w-4 rounded-t-[2px]"
            style={{ height: Math.max(BAR_MIN_PX, Math.round((column.count / top) * BAR_MAX_PX)) }}
          />
          <MiniCard value={column.card} className="h-[30px] w-[22px] text-[11px]" />
          <span className="sr-only">
            {t("results.cardVotes", { card: cardLabel(t, column.card), count: column.count })}
          </span>
        </li>
      ))}
    </ul>
  );
}

/** How long the voting took: "42 s", "2 min 13 s", or from an hour on "1 h 2 min". */
function Duration({ round }: { round: HistoryRoundView }) {
  const t = useT();
  const time = votingTime(round);
  return (
    <p data-history-duration={time.total} className="m-0 ml-auto flex items-center gap-1 text-sm">
      <TimerIcon aria-hidden className="size-3.5 text-ink-2" />
      <span aria-hidden="true" className="tabular-nums whitespace-nowrap">
        {shortDuration(t, time)}
      </span>
      <span className="sr-only">
        {t("history.tookSpoken", { duration: durationSpoken(t, time) })}
      </span>
    </p>
  );
}

/** A round's votes: names and cards, or in an anonymous round the cards alone. */
function Votes({ round }: { round: HistoryRoundView }) {
  const t = useT();
  const { votes } = round;
  if (votes.kind === "anonymous") {
    return (
      <div className="flex flex-col gap-2 pb-1">
        <p className="m-0 inline-flex items-center gap-1.5 text-sm text-ink-2">
          <EyeOffIcon aria-hidden className="size-3.5" />
          {t("history.anonymous")}
        </p>
        <ul aria-label={t("results.cards")} className="m-0 flex list-none flex-wrap gap-1.5 p-0">
          {votes.cards.map((card, i) => (
            // The cards in the deck's order, as stored: the index only tells repeats apart.
            // biome-ignore lint/suspicious/noArrayIndexKey: the same card may come twice.
            <li key={`${card}-${i}`}>
              <MiniCard value={card} />
              <span className="sr-only">{cardLabel(t, card)}</span>
            </li>
          ))}
        </ul>
      </div>
    );
  }
  return (
    <ul className="m-0 flex list-none flex-col gap-1.5 p-0 pb-1">
      {votes.votes.map((vote, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: names may repeat, and a vote has no id here.
        <li key={i} data-history-vote className="flex min-w-0 items-center gap-2 text-sm">
          <span aria-hidden="true" className="min-w-0 flex-1 truncate" dir="auto">
            <bdi>{vote.name ?? t("results.someone")}</bdi>
          </span>
          <span className="sr-only">
            {t(vote.changedAfterReveal ? "history.voteChangedSpoken" : "history.voteSpoken", {
              name: vote.name ?? t("results.someone"),
              card: cardLabel(t, vote.card),
            })}
          </span>
          {vote.changedAfterReveal ? (
            <span
              aria-hidden="true"
              data-history-changed
              className="shrink-0 rounded-full border border-line bg-surface-2 px-2 py-0.5 text-xs font-semibold"
            >
              {t("history.changed")}
            </span>
          ) : null}
          <MiniCard value={vote.card} className="h-[30px] w-[22px] text-[11px]" />
        </li>
      ))}
    </ul>
  );
}
