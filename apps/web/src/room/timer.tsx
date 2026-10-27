import type { RoundView } from "@pp/protocol";
import { SquareIcon, TimerIcon } from "lucide-react";
import {
  lazy,
  type ReactNode,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { Popover, PopoverContent, PopoverTrigger } from "../components/ui/popover.tsx";
import { useT } from "../i18n/hooks.ts";
import { cn } from "../lib/utils.ts";
import { type CommandInput, commandSender } from "../realtime/room-connection.ts";
import { localNow, serverTime, useClockOffset } from "../realtime/server-clock.ts";
import { useRoomStore } from "../stores/room-store.ts";
import { AFTER_REVEAL, focusSoon } from "./focus.ts";
import {
  clockText,
  EXTEND_SECONDS,
  inWarnPhase,
  remainingMs,
  ringLeft,
  shownSeconds,
  type TimerState,
  timerState,
  WARN_MS,
} from "./timer-view.ts";

// The vote timer in the table's centre (#27, docs/03-design-brief.md, "The timer"). The
// server owns the deadline (`round.deadlineAt`, in its own clock); this page counts down
// to it with the clock offset `server-clock.ts` keeps, and at 0:00 it waits: the server's
// own timeout reveals, or says time is up. A page that still shows the round voting a
// moment later sends `timeUp`, the client ping of architecture section 9, which only asks
// the server's `apply` to look at the deadline. Nothing here decides an outcome.

/** The PO's menu (start, restart, custom length): a chunk of its own, loaded on first use. */
const TimerMenu = lazy(() => import("./timer-menu.tsx"));
const loadMenu = () => void import("./timer-menu.tsx");

const REDUCED = "(prefers-reduced-motion: reduce)";

function subscribeReduced(onChange: () => void) {
  const query = window.matchMedia?.(REDUCED);
  query?.addEventListener("change", onChange);
  return () => query?.removeEventListener("change", onChange);
}
const prefersReduced = () => window.matchMedia?.(REDUCED).matches ?? false;

/** Whether the person asked for reduced motion; follows a change while the page is open. */
export function useReducedMotionQuery(): boolean {
  return useSyncExternalStore(subscribeReduced, prefersReduced, () => false);
}

export interface Countdown {
  state: TimerState;
  /** Milliseconds left, never below 0 (0 while none runs). */
  remaining: number;
  /** The timer's whole length in milliseconds, for the ring (0 while none runs). */
  total: number;
  /** The deadline in this page's own clock (`localNow()`), for the ring's drain. */
  endsAt: number | null;
}

/**
 * The round's countdown, drawn again at each whole second of the time left (and when the
 * clock offset moves), so the text changes when the second does, on every page alike.
 */
export function useCountdown(round: RoundView | null): Countdown {
  const state = timerState(round);
  const deadlineAt = state.kind === "running" ? state.deadlineAt : null;
  const offset = useClockOffset();
  const [, tick] = useState(0);
  /** The time left when this page first saw a deadline without a start (an older server). */
  const seen = useRef<{ deadlineAt: number; total: number } | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: a new offset moves the next whole second.
  useEffect(() => {
    if (deadlineAt === null) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
      const left = remainingMs(deadlineAt, serverTime());
      if (left <= 0) return;
      // Just past the next whole second, so the text has changed when it is drawn.
      timer = setTimeout(
        () => {
          tick((n) => n + 1);
          schedule();
        },
        (left % 1000 || 1000) + 2,
      );
    };
    schedule();
    return () => clearTimeout(timer);
  }, [deadlineAt, offset]);

  if (state.kind !== "running") return { state, remaining: 0, total: 0, endsAt: null };
  const endsAt = state.deadlineAt - offset;
  const remaining = Math.max(0, endsAt - localNow());
  let total: number;
  if (state.startedAt !== null) {
    total = state.deadlineAt - state.startedAt;
  } else {
    if (seen.current?.deadlineAt !== state.deadlineAt) {
      seen.current = { deadlineAt: state.deadlineAt, total: remaining };
    }
    total = seen.current.total;
  }
  return { state, remaining, total, endsAt };
}

/**
 * "10 seconds left.", once per deadline, when this page sees the countdown cross 10 s (a
 * page that loads with 8 s left says nothing; an extension past 10 s may say it again).
 * Said in the table's live region, which says the rest of the timer's news.
 */
export function useLastSecondsWarning(countdown: Countdown) {
  const t = useT();
  const last = useRef<{ endsAt: number | null; seconds: number } | null>(null);
  const deadline = countdown.state.kind === "running" ? countdown.state.deadlineAt : null;
  const seconds = shownSeconds(countdown.remaining);
  useEffect(() => {
    const before = last.current;
    last.current = { endsAt: deadline, seconds };
    if (deadline === null || before === null || before.endsAt !== deadline) return;
    const limit = WARN_MS / 1000;
    if (before.seconds > limit && seconds <= limit && seconds > 0) {
      useRoomStore.getState().announce(t("live.tenLeft", { n: limit }));
    }
  }, [deadline, seconds, t]);
}

/** A page pings `timeUp` this long after its estimate of the deadline, plus up to `PING_JITTER_MS`. */
export const PING_AFTER_MS = 1_000;
export const PING_JITTER_MS = 1_000;

/**
 * The client ping (architecture section 9): once per deadline, a second (plus a random
 * share of another, so a room's pages do not all arrive at once) after this page's
 * estimate of the deadline, if the round it shows still votes with that deadline, the page
 * sends `timeUp`. The server's own timeout normally got there first and nothing is sent;
 * when it did not (an instance restarted and nobody entered since), the server's `apply`
 * reveals or says time is up, once, whoever pings. A ping that finds nothing to do stores
 * and sends nothing. The page decides nothing: it only asks.
 */
export function useTimeUpPing(countdown: Countdown) {
  const deadlineAt = countdown.state.kind === "running" ? countdown.state.deadlineAt : null;
  const offset = useClockOffset();
  const pinged = useRef<number | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new offset moves the estimate.
  useEffect(() => {
    if (deadlineAt === null || pinged.current === deadlineAt) return;
    const wait =
      Math.max(0, deadlineAt - serverTime()) + PING_AFTER_MS + Math.random() * PING_JITTER_MS;
    const timer = setTimeout(() => {
      const round = useRoomStore.getState().snapshot?.room.round;
      if (round?.phase !== "voting" || round.deadlineAt !== deadlineAt) return;
      pinged.current = deadlineAt;
      void commandSender()({ type: "timeUp" });
    }, wait);
    return () => clearTimeout(timer);
  }, [deadlineAt, offset]);
}

/** The ring's stroke, in pixels, by variant. */
const STROKE = 2.5;

/** The ring steps at most this often: 20 times a second. */
export const RING_MIN_STEP_MS = 50;

/**
 * How many steps the ring drains a timer of `total` milliseconds in: one per device pixel
 * of its length, so each step moves the end of the arc by about a pixel and the drain
 * reads as linear, but never more than 20 a second. A 30 s timer steps about 5 times a
 * second, a 60 min one every 20 s or so: each step is one style change, nothing between.
 */
export function ringSteps(size: { width: number; height: number }, total: number, ratio = 1) {
  const r = (size.height - STROKE) / 2;
  const length = 2 * Math.max(0, size.width - size.height) + 2 * Math.PI * r;
  return Math.max(1, Math.min(Math.ceil(length * ratio), Math.ceil(total / RING_MIN_STEP_MS)));
}

/** The share of the ring drawn with `left` of it to go: the step it is in, rounded up. */
const steppedLeft = (left: number, steps: number) => Math.ceil(left * steps - 1e-9) / steps;

/**
 * A stadium (the table's own shape) around the chip, as an SVG path from the top centre,
 * clockwise. `pathLength` 100 makes the drain a dash offset from 0 to 100.
 */
function stadiumPath(width: number, height: number): string {
  const inset = STROKE / 2;
  const top = inset;
  const bottom = height - inset;
  const left = inset;
  const right = width - inset;
  const r = (bottom - top) / 2;
  const middle = width / 2;
  return [
    `M ${middle} ${top}`,
    `H ${right - r}`,
    `A ${r} ${r} 0 0 1 ${right - r} ${bottom}`,
    `H ${left + r}`,
    `A ${r} ${r} 0 0 1 ${left + r} ${top}`,
    "Z",
  ].join(" ");
}

/** The chip's size, measured: the ring follows its text in every language. */
function useBoxSize<E extends HTMLElement>() {
  const ref = useRef<E>(null);
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const measure = () => {
      const width = element.offsetWidth;
      const height = element.offsetHeight;
      setSize((was) =>
        was?.width === width && was.height === height ? was : width > 0 ? { width, height } : null,
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return [ref, size] as const;
}

/**
 * The ring: a faint track and the time left in brass, `--warn` in the last 10 s, full and
 * `--warn` once time is up. It drains linearly to the deadline in `ringSteps` steps, each
 * set on the path when its time comes (a timeout, not an animation: an animation of the
 * dash offset restyles the page every frame, `steps()` easing or not, as measured in
 * Chromium). Under reduced motion it moves only with the text, once a second.
 */
function TimerRing({
  countdown,
  size,
  reduced,
}: {
  countdown: Countdown;
  size: { width: number; height: number };
  reduced: boolean;
}) {
  const progress = useRef<SVGPathElement>(null);
  const up = countdown.state.kind === "up";
  const left = up ? 1 : ringLeft(countdown.remaining, countdown.total);
  const { endsAt, total } = countdown;
  const path = stadiumPath(size.width, size.height);
  const steps = ringSteps(size, total, window.devicePixelRatio || 1);
  // A render draws the step it is in too, so the text's tick never moves the ring off it.
  const drawn = reduced || up ? left : steppedLeft(left, steps);

  useLayoutEffect(() => {
    const element = progress.current;
    if (reduced || endsAt === null || !element) return;
    const stepMs = total / steps;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const draw = () => {
      const remaining = Math.max(0, endsAt - localNow());
      const share = steppedLeft(ringLeft(remaining, total), steps);
      element.setAttribute("stroke-dashoffset", String(100 * (1 - share)));
      if (remaining <= 0) return;
      // The next step starts when the time left falls under this step's lower edge.
      const next = remaining - (Math.round(share * steps) - 1) * stepMs;
      timer = setTimeout(draw, Math.max(RING_MIN_STEP_MS, next + 1));
    };
    draw();
    return () => clearTimeout(timer);
  }, [reduced, endsAt, total, steps]);

  return (
    <svg
      aria-hidden="true"
      data-timer-ring
      className="pp-timer-ring pointer-events-none absolute inset-0 overflow-visible"
      width={size.width}
      height={size.height}
    >
      <path d={path} fill="none" strokeWidth={STROKE} className="pp-timer-track" />
      <path
        ref={progress}
        d={path}
        fill="none"
        strokeWidth={STROKE}
        strokeLinecap="round"
        pathLength={100}
        strokeDasharray="100 100"
        strokeDashoffset={100 * (1 - drawn)}
        data-ring-left={left.toFixed(3)}
        className={cn(
          "pp-timer-progress",
          (up || inWarnPhase(countdown.remaining)) && "pp-timer-warn",
        )}
      />
    </svg>
  );
}

/** The chip's look: a stadium on the felt, its text in tabular numerals. */
const CHIP =
  "relative inline-flex h-9 min-w-16 items-center justify-center gap-1.5 rounded-full px-3.5 text-[15px] leading-none font-bold whitespace-nowrap text-table-ink tabular-nums in-data-[variant=phone]:h-6 in-data-[variant=phone]:min-w-10 in-data-[variant=phone]:gap-1 in-data-[variant=phone]:px-1.5 in-data-[variant=phone]:text-[11px]";

/** "Time is up" is the chip's longest text: smaller on a phone, so it stays within 76 px. */
const UP_TEXT = "in-data-[variant=phone]:text-[10px] in-data-[variant=phone]:tracking-tight";

/** The 1 Hz pulse of the last 10 s; never under reduced motion, where colour and text say it. */
function usePulse<E extends HTMLElement>(on: boolean) {
  const ref = useRef<E>(null);
  useEffect(() => {
    const element = ref.current;
    if (!on || !element || typeof element.animate !== "function") return;
    const animation = element.animate(
      [
        { transform: "scale(1)" },
        { transform: "scale(1.08)", offset: 0.5 },
        { transform: "scale(1)" },
      ],
      { duration: 1000, iterations: Number.POSITIVE_INFINITY, easing: "ease-in-out" },
    );
    return () => animation.cancel();
  }, [on]);
  return ref;
}

/** What the chip shows: the time left, "Time is up", or (the PO's, idle) "Timer". */
function ChipFace({
  countdown,
  reduced,
  size,
  children,
}: {
  countdown: Countdown;
  reduced: boolean;
  size: { width: number; height: number } | null;
  children: ReactNode;
}) {
  return (
    <>
      {size !== null && countdown.state.kind !== "none" ? (
        <TimerRing countdown={countdown} size={size} reduced={reduced} />
      ) : null}
      {children}
    </>
  );
}

function chipState(countdown: Countdown): "idle" | "running" | "warn" | "zero" | "up" {
  if (countdown.state.kind === "up") return "up";
  if (countdown.state.kind === "none") return "idle";
  if (countdown.remaining <= 0) return "zero";
  return inWarnPhase(countdown.remaining) ? "warn" : "running";
}

/**
 * Everyone's timer (#27): the time left as text ("0:45"), the ring around it, and "Time
 * is up" once the deadline passed in a room that does not reveal at the end. Read by
 * screen readers as "Time left: 0:45" (a `timer`, which is never live: the live region
 * says the news instead of a tick every second).
 */
export function TimerChip({ countdown }: { countdown: Countdown }) {
  const t = useT();
  const reduced = useReducedMotionQuery();
  const state = chipState(countdown);
  const pulse = usePulse<HTMLDivElement>(state === "warn" && !reduced);
  const [box, size] = useBoxSize<HTMLDivElement>();
  if (state === "idle") return null;
  const time = clockText(countdown.remaining);
  return (
    <div
      ref={(element) => {
        box.current = element;
        pulse.current = element;
      }}
      role="timer"
      data-timer={state}
      data-ends-at={countdown.endsAt ?? undefined}
      className={CHIP}
    >
      <ChipFace countdown={countdown} reduced={reduced} size={size}>
        {state === "up" ? (
          <span data-timer-text className={UP_TEXT}>
            {t("timer.up")}
          </span>
        ) : (
          <>
            <span aria-hidden="true" data-timer-text>
              {time}
            </span>
            <span className="sr-only">{t("timer.left", { time })}</span>
          </>
        )}
      </ChipFace>
    </div>
  );
}

/** The PO's small buttons beside the chip on a desktop: card faces, 32 px, 44 px to touch. */
const SIDE_BUTTON =
  "relative inline-flex h-8 items-center gap-1 rounded-md border border-card-edge bg-card-face px-2 text-[12px] leading-none font-semibold whitespace-nowrap text-card-ink shadow-sm outline-none after:absolute after:-inset-y-1.5 after:inset-x-0 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brass aria-disabled:opacity-60 in-data-[variant=phone]:hidden";

/**
 * Refusals that only say the reveal won a race with the PO's press: the round no longer
 * votes, or (for "+30 s" at 0:00) its timer just ended. The screen already shows why.
 */
const RACED: readonly string[] = ["not_voting"];
const RACED_EXTEND: readonly string[] = ["not_voting", "no_timer"];
const racedFor = (command: CommandInput) => (command.type === "extendTimer" ? RACED_EXTEND : RACED);

/** Sends the PO's timer commands one at a time; a refusal shows under the table. */
function useTimerCommands(onFailure: (code: string | null) => void) {
  const pending = useRef(false);
  const [busy, setBusy] = useState(false);
  const send = useCallback(
    async (command: CommandInput) => {
      if (pending.current) return false;
      pending.current = true;
      setBusy(true);
      onFailure(null);
      try {
        const ack = await commandSender()(command);
        if (!ack.ok && !racedFor(command).includes(ack.code)) onFailure(ack.code);
        return ack.ok;
      } finally {
        pending.current = false;
        setBusy(false);
      }
    },
    [onFailure],
  );
  return { send, busy };
}

/**
 * When a button that has the focus leaves (the timer stopped, or the round revealed), the
 * focus goes to the chip, or to the PO's decision after a reveal.
 */
function useFocusHandOff<E extends HTMLElement>() {
  const ref = useRef<E>(null);
  useLayoutEffect(() => {
    const element = ref.current;
    return () => {
      // Decided a frame later, once the page shows what replaced the button: the chip while
      // the round votes, else the PO's decision after the reveal.
      if (element !== null && document.activeElement === element) {
        focusSoon("[data-timer-button]", ...AFTER_REVEAL);
      }
    };
  }, []);
  return ref;
}

/**
 * The menu leaves with the voting round (a reveal while the PO types a length): if it
 * holds the focus then, the focus goes where a reveal sends it, the PO's decision (or the
 * chip, if the round still votes), never to the page. Closing the menu otherwise gives
 * the focus back to the chip (Radix).
 */
function useMenuHandOff() {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const menu = ref;
    return () => {
      // A layout cleanup runs before React removes the menu: the focus is still in it.
      if (menu.current?.contains(document.activeElement)) {
        focusSoon("[data-timer-button]", ...AFTER_REVEAL);
      }
    };
  }, []);
  return ref;
}

function StopButton({ onStop, busy }: { onStop: () => void; busy: boolean }) {
  const t = useT();
  const ref = useFocusHandOff<HTMLButtonElement>();
  return (
    <button
      ref={ref}
      type="button"
      data-timer-stop
      aria-disabled={busy || undefined}
      onClick={onStop}
      className={SIDE_BUTTON}
    >
      <SquareIcon aria-hidden className="size-3 fill-current" />
      <span aria-hidden="true">{t("timer.stop")}</span>
      <span className="sr-only">{t("timer.stopSpoken")}</span>
    </button>
  );
}

function AddButton({ onAdd, busy }: { onAdd: () => void; busy: boolean }) {
  const t = useT();
  const ref = useFocusHandOff<HTMLButtonElement>();
  return (
    <button
      ref={ref}
      type="button"
      data-timer-extend
      title={t("timer.addSpoken")}
      aria-disabled={busy || undefined}
      onClick={onAdd}
      className={SIDE_BUTTON}
    >
      <span aria-hidden="true">{t("timer.add")}</span>
      <span className="sr-only">{t("timer.addSpoken")}</span>
    </button>
  );
}

/**
 * The PO's timer controls (#27), above the count and "Reveal cards": the chip itself is a
 * button that opens a small menu (30 s, 60 s, 2 min, or a custom length; while a timer
 * runs, "Start again" with those and, on a phone, "+30 s" and "Stop"). On a desktop "Stop"
 * and "+30 s" also flank the chip while it runs. A phone's centre has no room beside it:
 * the menu holds them there.
 */
export function TimerControls({
  countdown,
  onFailure,
}: {
  countdown: Countdown;
  onFailure: (code: string | null) => void;
}) {
  const t = useT();
  const reduced = useReducedMotionQuery();
  const state = chipState(countdown);
  const running = countdown.state.kind === "running";
  const { send, busy } = useTimerCommands(onFailure);
  const [open, setOpen] = useState(false);
  const [compact, setCompact] = useState(false);
  const pulse = usePulse<HTMLButtonElement>(state === "warn" && !reduced);
  const [box, size] = useBoxSize<HTMLButtonElement>();
  const handOff = useFocusHandOff<HTMLButtonElement>();
  const menu = useMenuHandOff();
  const time = clockText(countdown.remaining);

  const stop = () => void send({ type: "stopTimer" });
  const add = () => void send({ type: "extendTimer", payload: { seconds: EXTEND_SECONDS } });
  // The chip's name says its state only: the focus comes back to it after every choice,
  // and a screen reader speaks a focused control's name again when it changes, so a name
  // with the time in it would tick. The time is in the `timer` beside it, never live.
  const name =
    state === "idle"
      ? t("timer.button")
      : state === "up"
        ? t("timer.buttonUp")
        : t("timer.buttonRunning");

  return (
    <div data-timer-controls className="flex items-center gap-1.5">
      {running ? <StopButton onStop={stop} busy={busy} /> : null}
      <Popover
        open={open}
        onOpenChange={(next) => {
          if (next) {
            // A phone's centre has no room for "Stop" and "+30 s": the menu holds them.
            const stage = box.current?.closest<HTMLElement>("[data-variant]");
            setCompact(stage?.dataset.variant === "phone");
          }
          setOpen(next);
        }}
      >
        <PopoverTrigger asChild>
          <button
            ref={(element) => {
              box.current = element;
              pulse.current = element;
              handOff.current = element;
            }}
            type="button"
            data-timer-button
            data-timer={state}
            data-ends-at={countdown.endsAt ?? undefined}
            aria-label={name}
            onPointerEnter={loadMenu}
            onFocus={loadMenu}
            className={cn(
              CHIP,
              "outline-none after:absolute after:-inset-y-2.5 after:-inset-x-1 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brass",
              state === "idle" && "border border-table-ink/50 hover:border-table-ink",
            )}
          >
            <ChipFace countdown={countdown} reduced={reduced} size={size}>
              {state === "idle" ? (
                <>
                  <TimerIcon aria-hidden className="size-3.5 shrink-0" />
                  <span className="in-data-[variant=phone]:sr-only">{t("timer.button")}</span>
                </>
              ) : (
                <span data-timer-text className={cn(state === "up" && UP_TEXT)}>
                  {state === "up" ? t("timer.up") : time}
                </span>
              )}
            </ChipFace>
          </button>
        </PopoverTrigger>
        <PopoverContent
          ref={menu}
          side="bottom"
          aria-label={t("timer.menu")}
          data-timer-menu
          className="w-64 border-line bg-surface p-3 text-ink"
        >
          {open ? (
            <Suspense fallback={<div className="h-24" />}>
              <TimerMenu
                running={running}
                compact={compact}
                busy={busy}
                onCommand={async (command) => {
                  setOpen(false);
                  await send(command);
                }}
              />
            </Suspense>
          ) : null}
        </PopoverContent>
      </Popover>
      {state === "running" || state === "warn" || state === "zero" ? (
        <span role="timer" data-timer-spoken className="sr-only">
          {t("timer.left", { time })}
        </span>
      ) : null}
      {running ? <AddButton onAdd={add} busy={busy} /> : null}
    </div>
  );
}
