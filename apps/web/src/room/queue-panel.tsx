import { MAX_QUEUE_ITEMS, queueIdentity } from "@pp/domain";
import type { CmdAck, QueueItemView } from "@pp/protocol";
import { ArrowDownIcon, ArrowUpIcon, GripVerticalIcon, XIcon } from "lucide-react";
import {
  type FormEvent,
  memo,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
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
import { useT } from "../i18n/hooks.ts";
import type { TFunction } from "../i18n/i18n.ts";
import { cn } from "../lib/utils.ts";
import { commandSender, requestQueue } from "../realtime/room-connection.ts";
import { useRoomStore } from "../stores/room-store.ts";
import { failureMessage } from "./failure.ts";
import { type PasteResult, parsePaste, queueBatches } from "./paste-queue.ts";
import { itemName, keyLabel, safeHref, shortUrl } from "./subject.ts";

/** A phone: the `phone:` variant in styles.css. The panel is a bottom sheet there. */
const PHONE_QUERY = "(max-width: 640px)";

function subscribePhone(onChange: () => void) {
  const query = window.matchMedia(PHONE_QUERY);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

const isPhone = () => window.matchMedia(PHONE_QUERY).matches;

/** The list is asked for again once the queue has been quiet this long. */
const REFRESH_QUIET_MS = 150;
/** Dragged this close to the sheet's edge, the list scrolls. */
const DRAG_EDGE_PX = 48;
const DRAG_SCROLL_PX = 12;

/** A row's actions: 44 px on a phone, as every touch target, 32 px with a mouse. */
const ROW_BUTTON =
  "grid size-8 shrink-0 place-items-center rounded-md text-ink-2 hover:bg-surface-2 hover:text-ink aria-disabled:cursor-default aria-disabled:opacity-40 aria-disabled:hover:bg-transparent phone:size-11 [&>svg]:size-4";

interface QueuePanelProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Where the focus returns when the panel closes: the button that opened it. */
  returnFocus: RefObject<HTMLElement | null>;
}

/**
 * The PO's queue (#52, ADR-024), in a modal sheet like the history: a paste box, then the
 * items in order, each moved by its buttons or its grip, or removed. The list comes by a
 * `queue` request of its own, never in a snapshot; it is asked for on every open and again
 * when the snapshot's `rev` moves, and the PO's own changes show at once and settle on the
 * next answer.
 */
export function QueuePanel({ open, onOpenChange, returnFocus }: QueuePanelProps) {
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
          // The title takes the focus, as in the history: the paste box would open a
          // phone's keyboard over the list.
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
        <QueueBody side={!phone} />
      </SheetContent>
    </Sheet>
  );
}

type Loading = "loading" | "ready" | "failed";

/** The queue's items with one moved to place `to`. Mirrors the domain's `queueMove`. */
export function movedItem(items: readonly QueueItemView[], id: number, to: number) {
  const from = items.findIndex((item) => item.id === id);
  const item = items[from];
  if (item === undefined) return [...items];
  return items.toSpliced(from, 1).toSpliced(to, 0, item);
}

/** What the sheet says after a paste: every count that is not zero, in one line. */
export function pasteReport(t: TFunction, result: PasteResult): string {
  const added = result.items.length;
  const parts = [added > 0 ? t("queue.added", { count: added }) : t("queue.addedNone")];
  if (result.duplicates > 0) parts.push(t("queue.duplicates", { count: result.duplicates }));
  if (result.shortened > 0) parts.push(t("queue.shortened", { count: result.shortened }));
  if (result.refused > 0) parts.push(t("queue.refused", { count: result.refused }));
  if (result.overflow > 0) {
    parts.push(t("queue.overflow", { count: result.overflow, max: MAX_QUEUE_ITEMS }));
  }
  return parts.join(" ");
}

function QueueBody({ side }: { side: boolean }) {
  const t = useT();
  const head = useRef<HTMLDivElement>(null);
  const key = useRoomStore((state) => {
    const queue = state.snapshot?.room.queue;
    return `${queue?.count ?? 0}:${queue?.rev ?? 0}`;
  });
  const [items, setItems] = useState<readonly QueueItemView[]>([]);
  const [loading, setLoading] = useState<Loading>("loading");
  /** A refusal under the list, as a code. */
  const [failure, setFailure] = useState<string | null>(null);
  /** What a screen reader hears of the PO's own changes; the row itself shows them. */
  const [news, setNews] = useState({ id: 0, text: "" });
  const [drag, setDrag] = useState<{ id: number; over: number } | null>(null);
  /** The control to focus once the list has redrawn: moving a row loses the focus. */
  const refocus = useRef<string | null>(null);
  const list = useRef<HTMLOListElement>(null);
  /** Counts the requests: an answer that a newer one overtook is dropped. */
  const asked = useRef(0);
  /** The PO's changes on their way: an answer read before them would undo them on screen. */
  const working = useRef(0);
  const quiet = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const fetchList = useCallback(async () => {
    const ask = ++asked.current;
    const answer = await requestQueue();
    if (ask !== asked.current || working.current > 0) return;
    if (!answer.ok) {
      // A refetch that fails keeps the rows shown; only an empty panel says so.
      setLoading((now) => (now === "ready" ? now : "failed"));
      return;
    }
    setItems(answer.items);
    setLoading("ready");
  }, []);

  const refresh = useCallback(() => {
    clearTimeout(quiet.current);
    quiet.current = setTimeout(() => void fetchList(), REFRESH_QUIET_MS);
  }, [fetchList]);

  useEffect(() => {
    void fetchList();
    return () => clearTimeout(quiet.current);
  }, [fetchList]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `key` is what asks again.
  useEffect(() => {
    if (asked.current > 0) refresh();
  }, [key, refresh]);

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

  // biome-ignore lint/correctness/useExhaustiveDependencies: every redraw of the list may need it.
  useLayoutEffect(() => {
    if (refocus.current === null) return;
    list.current
      ?.closest("[data-queue-panel]")
      ?.querySelector<HTMLElement>(refocus.current)
      ?.focus();
    refocus.current = null;
  }, [items]);

  const say = (text: string) => setNews((now) => ({ id: now.id + 1, text }));

  /** A change of the PO's: on screen at once, then sent; the next answer settles it. */
  async function act(
    change: () => void,
    send: () => Promise<Pick<CmdAck, "ok"> & { code?: string }>,
  ) {
    change();
    setFailure(null);
    working.current += 1;
    try {
      const ack = await send();
      if (!ack.ok) setFailure(ack.code ?? "unknown");
      return ack.ok;
    } finally {
      working.current -= 1;
      refresh();
    }
  }

  async function move(id: number, to: number, focus: string | null) {
    const from = items.findIndex((item) => item.id === id);
    const item = items[from];
    if (item === undefined || to < 0 || to >= items.length || to === from) return;
    const done = await act(
      () => {
        refocus.current = focus;
        setItems(movedItem(items, id, to));
      },
      () => commandSender()({ type: "queueMove", payload: { id, to } }),
    );
    if (done) {
      say(t("queue.moved", { item: itemName(item), place: to + 1, total: items.length }));
    }
  }

  async function remove(id: number) {
    const at = items.findIndex((item) => item.id === id);
    const item = items[at];
    if (item === undefined) return;
    const neighbour = items[at + 1] ?? items[at - 1];
    const done = await act(
      () => {
        refocus.current =
          neighbour === undefined
            ? "[data-queue-paste]"
            : `[data-queue-item='${neighbour.id}'] [data-queue-remove]`;
        setItems(items.filter((each) => each.id !== id));
      },
      () => commandSender()({ type: "queueRemove", payload: { id } }),
    );
    if (done) say(t("queue.removed", { item: itemName(item) }));
  }

  async function clearAll() {
    const done = await act(
      () => {
        refocus.current = "[data-queue-paste]";
        setItems([]);
      },
      () => commandSender()({ type: "queueClear" }),
    );
    if (done) say(t("queue.cleared"));
  }

  const latest = useRef({ move, remove });
  latest.current = { move, remove };
  const onMove = useCallback(
    (id: number, to: number, focus: string | null) => void latest.current.move(id, to, focus),
    [],
  );
  const onRemove = useCallback((id: number) => void latest.current.remove(id), []);

  /** A grip's drag: the pointer picks the row to land on; Move and Remove are its keyboard. */
  const startDrag = useCallback((event: ReactPointerEvent<HTMLElement>, id: number) => {
    if (event.button !== 0) return;
    const grip = event.currentTarget;
    grip.setPointerCapture(event.pointerId);
    const scroller = grip.closest<HTMLElement>("[data-slot=sheet-content]");
    const place = (y: number) => {
      const rows = list.current?.querySelectorAll<HTMLElement>("[data-queue-item]") ?? [];
      let over = 0;
      rows.forEach((row, index) => {
        if (y > row.getBoundingClientRect().top) over = index;
      });
      return over;
    };
    const follow = (moved: PointerEvent) => {
      if (scroller) {
        const box = scroller.getBoundingClientRect();
        if (moved.clientY < box.top + DRAG_EDGE_PX) scroller.scrollTop -= DRAG_SCROLL_PX;
        if (moved.clientY > box.bottom - DRAG_EDGE_PX) scroller.scrollTop += DRAG_SCROLL_PX;
      }
      setDrag({ id, over: place(moved.clientY) });
    };
    const end = (ended: PointerEvent) => {
      grip.removeEventListener("pointermove", follow);
      grip.removeEventListener("pointerup", end);
      grip.removeEventListener("pointercancel", end);
      setDrag(null);
      if (ended.type === "pointerup") void latest.current.move(id, place(ended.clientY), null);
    };
    grip.addEventListener("pointermove", follow);
    grip.addEventListener("pointerup", end);
    grip.addEventListener("pointercancel", end);
    setDrag({ id, over: place(event.clientY) });
  }, []);

  return (
    <div data-queue-panel>
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
            {t("queue.open")}
          </SheetTitle>
          <SheetDescription className="text-ink-2">{t("queue.lede")}</SheetDescription>
        </SheetHeader>
        <SheetClose asChild>
          <Button variant="ghost" size="icon" className="shrink-0">
            <XIcon aria-hidden />
            <span className="sr-only">{t("common.close")}</span>
          </Button>
        </SheetClose>
      </div>
      <PanelLive />
      <div role="status" data-queue-live className="sr-only">
        <span key={news.id}>{news.text}</span>
      </div>
      <PasteForm items={items} ready={loading !== "loading"} onAdded={refresh} />
      {failure !== null ? (
        <p role="alert" className="m-0 px-4 pb-2 text-sm">
          {failureMessage(t, failure)}
        </p>
      ) : null}
      {loading === "loading" ? (
        <p role="status" data-queue-loading className="m-0 px-4 py-6 text-ink-2">
          {t("queue.loading")}
        </p>
      ) : loading === "failed" ? (
        <div data-queue-failed className="flex flex-col items-start gap-3 px-4 py-6">
          <p role="alert" className="m-0 text-ink-2">
            {t("queue.failed")}
          </p>
          <Button
            variant="outline"
            onClick={() => {
              setLoading("loading");
              void fetchList();
            }}
          >
            {t("queue.retry")}
          </Button>
        </div>
      ) : items.length === 0 ? (
        <p data-queue-empty className="m-0 px-4 py-6 text-ink-2">
          {t("queue.empty")}
        </p>
      ) : (
        <>
          <ol
            ref={list}
            aria-label={t("queue.list")}
            data-queue-list
            className="m-0 list-none divide-y divide-line p-0"
          >
            {items.map((item, index) => (
              <QueueRow
                key={item.id}
                item={item}
                index={index}
                last={index === items.length - 1}
                dragged={drag?.id === item.id}
                drop={
                  drag === null || drag.over !== index || drag.id === item.id
                    ? null
                    : items.findIndex((each) => each.id === drag.id) < index
                      ? "after"
                      : "before"
                }
                onMove={onMove}
                onRemove={onRemove}
                onGrip={startDrag}
              />
            ))}
          </ol>
          <ClearQueue count={items.length} onClear={() => void clearAll()} />
        </>
      )}
    </div>
  );
}

/** What the room's live region says, for a page the open sheet hides from screen readers. */
function PanelLive() {
  const said = useRoomStore((state) => state.said);
  const [since] = useState(() => useRoomStore.getState().said.id);
  return (
    <div role="status" data-panel-live className="sr-only">
      <span key={said.id}>{said.id > since ? said.text : ""}</span>
    </div>
  );
}

/**
 * The paste box. The press parses here, in the page, and only the items leave; the text
 * is cleared once they are in, and kept when a send fails, so nothing has to be pasted
 * twice. A list that fits one socket message is one command, whatever its length.
 */
function PasteForm({
  items,
  ready,
  onAdded,
}: {
  items: readonly QueueItemView[];
  ready: boolean;
  onAdded: () => void;
}) {
  const t = useT();
  const ids = { field: useId(), hint: useId() };
  const [text, setText] = useState("");
  const [report, setReport] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);

  async function add(event: FormEvent) {
    event.preventDefault();
    if (pending.current || !ready) return;
    setProblem(null);
    if (text.trim() === "") {
      setReport(t("queue.nothingPasted"));
      return;
    }
    const result = parsePaste(text, {
      known: items.map(queueIdentity),
      room: MAX_QUEUE_ITEMS - items.length,
    });
    pending.current = true;
    setBusy(true);
    setReport(null);
    try {
      for (const batch of queueBatches(result.items)) {
        const ack = await commandSender()({ type: "queueAdd", payload: { items: batch } });
        if (!ack.ok) {
          setProblem(ack.code);
          return;
        }
      }
      setText("");
      setReport(pasteReport(t, result));
      onAdded();
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }

  return (
    <form data-queue-form noValidate onSubmit={add} className="flex flex-col gap-2 px-4 py-3">
      <label htmlFor={ids.field} className="text-sm font-medium">
        {t("queue.pasteLabel")}
      </label>
      <textarea
        id={ids.field}
        data-queue-paste
        value={text}
        onChange={(event) => setText(event.target.value)}
        aria-describedby={ids.hint}
        rows={4}
        autoComplete="off"
        spellCheck={false}
        className="w-full min-w-0 resize-y rounded-md border border-input bg-transparent px-3 py-2 font-mono text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 dark:bg-line/30"
      />
      <p id={ids.hint} className="m-0 text-sm text-ink-2">
        {t("queue.pasteHint")}
      </p>
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" data-queue-add aria-disabled={busy || !ready || undefined}>
          {t("queue.add")}
        </Button>
      </div>
      <div role="status" data-queue-report className="text-sm">
        {report}
      </div>
      {problem === null ? null : (
        <p role="alert" className="m-0 text-sm">
          {failureMessage(t, problem)}
        </p>
      )}
    </form>
  );
}

interface QueueRowProps {
  item: QueueItemView;
  index: number;
  last: boolean;
  dragged: boolean;
  drop: "before" | "after" | null;
  onMove: (id: number, to: number, focus: string | null) => void;
  onRemove: (id: number) => void;
  onGrip: (event: ReactPointerEvent<HTMLElement>, id: number) => void;
}

/**
 * One item. `memo`, and plain buttons, since a list holds up to 500 of them. The browser
 * skips the rows out of view (`content-visibility`), so a long list opens fast. The grip
 * is for a pointer alone and hidden from screen readers: "Move up" and "Move down" do the
 * same for the keyboard, and name the item they move.
 */
const QueueRow = memo(function QueueRow({
  item,
  index,
  last,
  dragged,
  drop,
  onMove,
  onRemove,
  onGrip,
}: QueueRowProps) {
  const t = useT();
  const name = itemName(item);
  const selector = `[data-queue-item='${item.id}']`;
  const href = item.url === undefined ? null : safeHref(item.url);
  const label = item.key !== undefined ? keyLabel(item.key) : null;
  return (
    <li
      data-queue-item={item.id}
      data-drop={drop ?? undefined}
      className={cn(
        "flex items-center gap-1 py-1.5 pr-2 pl-1 [contain-intrinsic-size:auto_3.25rem] [content-visibility:auto]",
        "data-[drop=before]:shadow-[inset_0_2px_0_0_var(--brass)] data-[drop=after]:shadow-[inset_0_-2px_0_0_var(--brass)]",
        dragged && "opacity-50",
      )}
    >
      <span
        aria-hidden
        data-queue-grip
        onPointerDown={(event) => onGrip(event, item.id)}
        className="grid h-8 w-6 shrink-0 cursor-grab touch-none place-items-center text-ink-2 phone:h-11 [&>svg]:size-4"
      >
        <GripVerticalIcon />
      </span>
      <div className="min-w-0 flex-1 text-sm">
        {label === null ? null : href === null ? (
          <span data-queue-key className="font-mono text-[13px] font-semibold text-spruce">
            {label}
          </span>
        ) : (
          <a
            data-queue-key
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            title={item.url}
            className="font-mono text-[13px] font-semibold text-spruce underline-offset-2 hover:underline"
          >
            {label}
          </a>
        )}
        {item.title !== undefined ? (
          <bdi data-queue-title title={item.title} className="line-clamp-2 break-words">
            {item.title}
          </bdi>
        ) : label === null && item.url !== undefined ? (
          <bdi data-queue-title title={item.url} className="line-clamp-2 break-all">
            {shortUrl(item.url)}
          </bdi>
        ) : null}
      </div>
      <button
        type="button"
        data-queue-up
        aria-label={t("queue.moveUp", { item: name })}
        aria-disabled={index === 0 || undefined}
        onClick={() => onMove(item.id, index - 1, `${selector} [data-queue-up]`)}
        className={ROW_BUTTON}
      >
        <ArrowUpIcon aria-hidden />
      </button>
      <button
        type="button"
        data-queue-down
        aria-label={t("queue.moveDown", { item: name })}
        aria-disabled={last || undefined}
        onClick={() => onMove(item.id, index + 1, `${selector} [data-queue-down]`)}
        className={ROW_BUTTON}
      >
        <ArrowDownIcon aria-hidden />
      </button>
      <button
        type="button"
        data-queue-remove
        aria-label={t("queue.remove", { item: name })}
        onClick={() => onRemove(item.id)}
        className={ROW_BUTTON}
      >
        <XIcon aria-hidden />
      </button>
    </li>
  );
});

/** "Clear the queue", asked first: it cannot be undone, and a paste may be long. */
function ClearQueue({ count, onClear }: { count: number; onClear: () => void }) {
  const t = useT();
  const [asking, setAsking] = useState(false);
  const keep = useRef<HTMLButtonElement>(null);
  const clear = useRef<HTMLButtonElement>(null);
  const changed = useRef(false);

  useEffect(() => {
    if (!changed.current) return;
    changed.current = false;
    (asking ? keep : clear).current?.focus();
  }, [asking]);

  const ask = (on: boolean) => {
    changed.current = true;
    setAsking(on);
  };

  return (
    <div
      data-queue-clear
      className="flex flex-wrap items-center gap-2 border-t border-line px-4 py-3"
    >
      {asking ? (
        <>
          <p className="m-0 text-sm">{t("queue.clearAsk", { count })}</p>
          <Button ref={keep} variant="outline" onClick={() => ask(false)}>
            {t("queue.clearNo")}
          </Button>
          <Button
            variant="destructive"
            data-queue-clear-yes
            onClick={() => {
              setAsking(false);
              onClear();
            }}
          >
            {t("queue.clearYes")}
          </Button>
        </>
      ) : (
        <Button ref={clear} variant="ghost" onClick={() => ask(true)}>
          {t("queue.clear")}
        </Button>
      )}
    </div>
  );
}
