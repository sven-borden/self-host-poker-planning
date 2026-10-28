import {
  ChevronDownIcon,
  ClipboardListIcon,
  CopyIcon,
  DownloadIcon,
  FileSpreadsheetIcon,
  FileTextIcon,
} from "lucide-react";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { Button } from "../components/ui/button.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../components/ui/dropdown-menu.tsx";
import { useFormat, useLanguage, useT } from "../i18n/hooks.ts";
import { localeFor } from "../i18n/language.ts";
import { cn } from "../lib/utils.ts";
import { requestHistory } from "../realtime/room-connection.ts";
import { useRoomStore } from "../stores/room-store.ts";
import { createPacer, SUMMARY_PACE } from "./history-pace.ts";
import {
  CAPTION,
  durationSpoken,
  type HistoryList,
  historyKey,
  NO_ROUNDS,
  shortDuration,
  splitSeconds,
  withEarlierPage,
  withFirstPage,
} from "./history-view.ts";
import {
  capRounds,
  covers,
  defaultRange,
  EXPORT_PAGE,
  type ExportRound,
  exportRounds,
  inRange,
  MAX_EXPORT_ROUNDS,
  type Range,
  summarize,
  tableRound,
} from "./summary.ts";

type ExportsModule = typeof import("./exports.ts");

/** The export code: a chunk of its own, fetched when someone opens the export menu. */
const loadExports = () => import("./exports.ts");

/**
 * The rounds the summary read, kept across opens of the panel: the room they belong to
 * (its code, never logged), the `historyKey` its first page answered for, and the rounds,
 * newest first. A reopen asks for the first page only and joins it to them.
 */
let held: { room: string; key: string; list: HistoryList } | null = null;
/** Every summary request waits for its turn here, whichever open of the panel asks. */
const pace = createPacer(SUMMARY_PACE);

/** Forgets the rounds held and refills the pace (tests). */
export function forgetSummaryRounds(): void {
  held = null;
  pace.reset();
}

/** The range shown: the one chosen, else "Today" when a round held or the table's ended today. */
function rangeFor(
  list: HistoryList,
  chosen: Range | null,
  table: ExportRound | null,
  now: number,
): Range {
  return chosen ?? defaultRange(exportRounds(capRounds(list, "all", now).rounds, table), now);
}

/**
 * The finished rounds for the summary and the exports: the history read 50 at a time,
 * newest first, at `SUMMARY_PACE`, as far as the range needs (`covers`: to the oldest
 * round or `MAX_EXPORT_ROUNDS`, or for "Today" to a round that ended before local
 * midnight). The rounds stay held across opens (`held`), so a reopen, a new round or a
 * new final asks for the first page alone. Closing the panel stops the reading; a range
 * that needs more goes on from where it stopped. `list` is null until a first page of
 * this room came in.
 */
function useSummaryRounds(
  room: string | null,
  key: string,
  chosen: Range | null,
  table: ExportRound | null,
) {
  const [list, setList] = useState<HistoryList | null>(() =>
    held !== null && held.room === room && held.key === key ? held.list : null,
  );
  const [failed, setFailed] = useState(false);
  const run = useRef<{ stopped: boolean } | null>(null);
  const chosenNow = useRef(chosen);
  const tableNow = useRef(table);
  chosenNow.current = chosen;
  tableNow.current = table;

  const read = useCallback(
    async (fromTop: boolean) => {
      if (room === null) return;
      if (run.current) run.current.stopped = true;
      const me = { stopped: false };
      run.current = me;
      const done = () => {
        if (run.current === me) run.current = null;
      };
      setFailed(false);
      const ask = async (before?: number) => {
        if (!(await pace.wait(() => me.stopped))) return null;
        const page = await requestHistory(
          before === undefined ? { limit: EXPORT_PAGE } : { before, limit: EXPORT_PAGE },
        );
        return me.stopped ? null : page;
      };
      const mine = held?.room === room ? held : null;
      let merged = mine?.list ?? NO_ROUNDS;
      let at = mine?.key ?? key;
      const keep = () => {
        held = { room, key: at, list: merged };
        setList(merged);
      };
      if (fromTop || mine === null) {
        const first = await ask();
        if (first === null) return;
        if (!first.ok) {
          done();
          setFailed(true);
          return;
        }
        merged = withFirstPage(merged, first);
        at = key;
        keep();
      }
      const needs = () => {
        const now = Date.now();
        return !covers(merged, rangeFor(merged, chosenNow.current, tableNow.current, now), now);
      };
      while (needs()) {
        const page = await ask(merged.next);
        if (page === null) return;
        if (!page.ok) {
          // What came in stays; "Try again" goes on from where it stopped.
          done();
          setFailed(true);
          return;
        }
        merged = withEarlierPage(merged, page);
        keep();
      }
      done();
    },
    [room, key],
  );

  useEffect(() => {
    void read(true);
    return () => {
      if (run.current) run.current.stopped = true;
      run.current = null;
    };
  }, [read]);

  const range = rangeFor(list ?? NO_ROUNDS, chosen, table, Date.now());
  // A range that needs more than the rounds held ("All rounds" after "Today") reads on.
  useEffect(() => {
    if (run.current !== null || failed || list === null) return;
    if (!covers(list, range, Date.now())) void read(false);
  }, [range, list, failed, read]);

  return { list, failed, range, retry: () => void read(true) };
}

/**
 * The session summary and the exports (#34), at the top of the history panel, for
 * everyone in the room: how many rounds, the total of the numeric final estimates (and
 * how many stories have no number), the average agreement and the average voting time,
 * over "Today" or "All rounds". The export menu downloads a CSV or a Markdown file, or
 * copies the Markdown or "KEY estimate" lines for Jira or Azure DevOps; what it did is
 * said once in a live region. The round on the table counts once it has a final.
 */
export function HistorySummary({ roomName }: { roomName: string | null }) {
  const t = useT();
  const format = useFormat();
  const heading = useId();
  const room = useRoomStore((state) => state.code);
  const key = useRoomStore((state) => historyKey(state.snapshot?.room));
  const round = useRoomStore((state) => state.snapshot?.room.round);
  const table = useMemo(() => tableRound(round), [round]);
  const [chosen, setChosen] = useState<Range | null>(null);
  const all = useSummaryRounds(room, key, chosen, table);

  const now = Date.now();
  const list = all.list ?? NO_ROUNDS;
  const { range } = all;
  const { rounds: fetched, capped } = capRounds(list, range, now);
  const rows = exportRounds(fetched, table);
  if (rows.length === 0) {
    // Nothing to sum: the list below says why (loading, failed or empty).
    return all.failed ? <CountFailed onRetry={all.retry} /> : null;
  }
  // Until the rounds the range needs are in, figures would count only some of them.
  const counting = !all.failed && (all.list === null || !covers(list, range, now));
  const shown = inRange(rows, range, now);
  const summary = summarize(shown);
  const noValue = t("results.noValue");
  const time = summary.votingSeconds === null ? null : splitSeconds(summary.votingSeconds);

  return (
    <section
      aria-labelledby={heading}
      data-history-summary
      className="flex flex-col gap-3 border-b border-line px-4 py-4"
    >
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
        <h3 id={heading} className={CAPTION}>
          {t("summary.title")}
        </h3>
        <RangeChoice value={range} onChange={setChosen} />
      </div>
      {counting ? (
        <p data-summary-counting className="m-0 text-sm text-ink-2">
          {t("summary.counting")}
        </p>
      ) : shown.length === 0 ? (
        <p data-summary-none className="m-0 text-sm text-ink-2">
          {t("summary.noneToday")}
        </p>
      ) : (
        // Each figure spans three rows of one grid (caption, value, note), so the values
        // of a row line up when a caption wraps.
        <dl className="m-0 grid grid-cols-2 gap-x-4 gap-y-0.5 [&>div:nth-child(n+3)]:mt-2.5">
          <Stat name="rounds" label={t("summary.rounds")} value={format.number(summary.rounds)} />
          <Stat
            name="total"
            label={t("summary.total")}
            value={format.number(summary.total, { maximumFractionDigits: 2 })}
            note={
              summary.withoutNumber > 0
                ? t("summary.withoutNumber", { count: summary.withoutNumber })
                : undefined
            }
          />
          <Stat
            name="agreement"
            label={t("summary.agreement")}
            value={
              summary.agreement === null
                ? noValue
                : format.number(summary.agreement, { style: "percent", maximumFractionDigits: 0 })
            }
          />
          <Stat
            name="time"
            label={t("summary.votingTime")}
            value={time === null ? noValue : shortDuration(t, time)}
            spoken={time === null ? undefined : durationSpoken(t, time)}
          />
        </dl>
      )}
      {capped ? (
        <p data-summary-capped className="m-0 text-xs text-ink-2">
          {t("summary.capped", { max: MAX_EXPORT_ROUNDS })}
        </p>
      ) : null}
      {all.failed ? <CountFailed onRetry={all.retry} inline /> : null}
      <ExportMenu
        rounds={shown}
        range={range}
        roomName={roomName}
        disabled={counting || all.failed || shown.length === 0}
      />
    </section>
  );
}

function CountFailed({ onRetry, inline = false }: { onRetry: () => void; inline?: boolean }) {
  const t = useT();
  return (
    <div
      data-summary-failed
      className={cn(
        "flex flex-wrap items-center gap-3",
        !inline && "border-b border-line px-4 py-4",
      )}
    >
      <p role="status" className="m-0 text-sm text-ink-2">
        {t("summary.failed")}
      </p>
      <Button variant="outline" size="sm" onClick={onRetry}>
        {t("history.retry")}
      </Button>
    </div>
  );
}

/** One figure of the summary: its caption, its value, and a note under it. */
function Stat({
  name,
  label,
  value,
  note,
  spoken,
}: {
  name: string;
  label: string;
  value: string;
  note?: string | undefined;
  /** The value in words, for screen readers ("1 minute 5 seconds" for "1 min 5 s"). */
  spoken?: string | undefined;
}) {
  return (
    <div data-summary-stat={name} className="row-span-3 grid min-w-0 grid-rows-subgrid">
      <dt className={CAPTION}>{label}</dt>
      <dd className="m-0 self-start text-xl font-semibold tabular-nums">
        {spoken === undefined ? (
          value
        ) : (
          <>
            <span aria-hidden="true">{value}</span>
            <span className="sr-only">{spoken}</span>
          </>
        )}
      </dd>
      {note === undefined ? null : <dd className="m-0 text-xs text-ink-2">{note}</dd>}
    </div>
  );
}

const RANGES: readonly { value: Range; label: "summary.today" | "summary.all" }[] = [
  { value: "today", label: "summary.today" },
  { value: "all", label: "summary.all" },
];

/** "Today" or "All rounds": two radio buttons that look like one segmented control. */
function RangeChoice({ value, onChange }: { value: Range; onChange: (range: Range) => void }) {
  const t = useT();
  const name = useId();
  return (
    <fieldset
      data-summary-range
      className="m-0 flex min-w-0 rounded-lg border border-line-strong p-0.5"
    >
      <legend className="sr-only">{t("summary.range")}</legend>
      {RANGES.map((option) => (
        <label
          key={option.value}
          data-summary-range-option={option.value}
          className={cn(
            "inline-flex min-h-9 cursor-pointer items-center rounded-md px-3 text-sm font-medium text-ink-2 transition-colors phone:min-h-11",
            "hover:text-ink has-checked:bg-surface-2 has-checked:text-ink has-checked:shadow-[inset_0_0_0_1px_var(--color-spruce)]",
            "has-focus-visible:outline-2 has-focus-visible:outline-brass motion-reduce:transition-none",
          )}
        >
          <input
            type="radio"
            name={name}
            value={option.value}
            checked={value === option.value}
            onChange={() => onChange(option.value)}
            className="sr-only"
          />
          {t(option.label)}
        </label>
      ))}
    </fieldset>
  );
}

type ExportAction = "csv" | "markdown" | "copyMarkdown" | "copyKeys";

/**
 * "Export": a menu of four. Opening it fetches the export chunk, so a pick runs at once
 * and the clipboard still counts it as the person's own gesture. A refused clipboard
 * shows the text in a read-only field, selected, to copy by hand.
 */
function ExportMenu({
  rounds,
  range,
  roomName,
  disabled,
}: {
  rounds: readonly ExportRound[];
  range: Range;
  roomName: string | null;
  disabled: boolean;
}) {
  const t = useT();
  const [language] = useLanguage();
  const fieldId = useId();
  const loaded = useRef<ExportsModule | null>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  /**
   * A copy was picked: the menu must not hand the focus back to "Export" on closing, since
   * a refused clipboard puts it on the text to copy instead (Radix restores the focus in a
   * timeout, after the copy may already have failed).
   */
  const copying = useRef(false);
  /** What the last pick did, said once (`id` tells two equal sentences apart). */
  const [said, setSaid] = useState<{ id: number; text: string } | null>(null);
  /** The text the browser refused to copy, shown to copy by hand. */
  const [manual, setManual] = useState<{ id: number; text: string } | null>(null);

  useEffect(() => {
    if (manual === null) return;
    field.current?.focus();
    field.current?.select();
  }, [manual]);

  const load = async () => {
    loaded.current ??= await loadExports();
    return loaded.current;
  };
  const say = (text: string) => setSaid((now) => ({ id: (now?.id ?? 0) + 1, text }));
  /** After a copy that needs no field: the focus goes back to "Export". */
  const back = () => trigger.current?.focus();

  async function copy(text: string, done: string) {
    try {
      if (!navigator.clipboard) throw new Error("no clipboard");
      await navigator.clipboard.writeText(text);
      setManual(null);
      say(done);
      back();
    } catch {
      setManual((now) => ({ id: (now?.id ?? 0) + 1, text }));
      say(t("exports.refused"));
    }
  }

  async function run(action: ExportAction) {
    let exports: ExportsModule;
    try {
      exports = loaded.current ?? (await load());
    } catch {
      say(t("exports.failed"));
      back();
      return;
    }
    const context = {
      t,
      language,
      locale: localeFor(language),
      roomName,
      range,
      now: Date.now(),
    };
    switch (action) {
      case "csv":
        exports.downloadCsv(rounds, context);
        setManual(null);
        say(t("exports.csvDone"));
        return;
      case "markdown":
        exports.downloadMarkdown(rounds, context);
        setManual(null);
        say(t("exports.markdownDone"));
        return;
      case "copyMarkdown":
        await copy(exports.toMarkdown(rounds, context), t("exports.markdownCopied"));
        return;
      case "copyKeys": {
        const lines = exports.keyLines(rounds);
        if (lines.lines === 0) {
          setManual(null);
          say(t("exports.noKeys"));
          back();
          return;
        }
        const copied = t("exports.keysCopied", { count: lines.lines });
        await copy(
          lines.text,
          lines.skipped > 0
            ? `${copied} ${t("exports.keysSkipped", { count: lines.skipped })}`
            : copied,
        );
        return;
      }
    }
  }

  const items: readonly { action: ExportAction; icon: typeof DownloadIcon }[] = [
    { action: "csv", icon: FileSpreadsheetIcon },
    { action: "markdown", icon: FileTextIcon },
    { action: "copyMarkdown", icon: CopyIcon },
    { action: "copyKeys", icon: ClipboardListIcon },
  ];

  return (
    <div className="flex flex-col items-start gap-2">
      <DropdownMenu
        onOpenChange={(open) => {
          // A failed fetch is tried again by the pick, which then says so.
          if (open) load().catch(() => {});
        }}
      >
        <DropdownMenuTrigger asChild>
          <Button ref={trigger} variant="outline" disabled={disabled} data-export-menu>
            <DownloadIcon aria-hidden />
            {t("exports.menu")}
            <ChevronDownIcon aria-hidden className="text-ink-2" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="start"
          className="min-w-60"
          onCloseAutoFocus={(event) => {
            if (!copying.current) return;
            // The copy's outcome places the focus: the field when refused, else "Export".
            copying.current = false;
            event.preventDefault();
            field.current?.focus();
            field.current?.select();
          }}
        >
          {items.map(({ action, icon: Icon }) => (
            <DropdownMenuItem
              key={action}
              data-export={action}
              className="min-h-11"
              onSelect={() => {
                copying.current = action === "copyMarkdown" || action === "copyKeys";
                void run(action);
              }}
            >
              <Icon aria-hidden />
              {t(`exports.${action}`)}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      <p role="status" data-export-status className="m-0 text-sm text-ink-2">
        <span key={said?.id}>{said?.text}</span>
      </p>
      {manual === null ? null : (
        <div className="flex w-full flex-col gap-1.5">
          <label htmlFor={fieldId} className="text-sm font-medium">
            {t("exports.field")}
          </label>
          <textarea
            id={fieldId}
            ref={field}
            readOnly
            data-export-manual
            value={manual.text}
            rows={6}
            onFocus={(event) => event.currentTarget.select()}
            className="w-full resize-y rounded-md border border-line-strong bg-surface p-2 font-mono text-xs text-ink focus-visible:outline-2 focus-visible:outline-brass"
          />
        </div>
      )}
    </div>
  );
}
