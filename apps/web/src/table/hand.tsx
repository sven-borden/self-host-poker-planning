import {
  type FocusEvent,
  type KeyboardEvent,
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { useT } from "../i18n/hooks.ts";
import { cn } from "../lib/utils.ts";
import { cardLabel, HandCard } from "./cards.tsx";

interface HandProps {
  /** The round's cards in display order: the deck, then the enabled specials. */
  cards: readonly string[];
  /** The card shown as the viewer's vote: lifted, with a brass ring, pressed. */
  selected: string | null;
  /** The domain would refuse a vote now: the cards stay focusable but do nothing. */
  disabled?: boolean;
  /** The id of the line under the hand: how to play, or why it cannot. */
  describedBy?: string;
  /** A press on an enabled card. The parent decides what it means (vote, retract). */
  onPick: (card: string, element: HTMLButtonElement) => void;
  className?: string;
}

const NEXT: Record<string, number> = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };

/**
 * The viewer's hand (#18): one toolbar, one tab stop. Arrow keys move through the cards
 * (roving tabindex, wrapping at the ends), Home and End jump; Enter or Space presses the
 * focused card, as any button. Each card is a toggle button (`aria-pressed`), so a screen
 * reader hears the card and whether it is the viewer's vote. Disabled cards keep the
 * focus (`aria-disabled`, never `disabled`), so the reveal never drops it; a deck change
 * that removes the focused card moves the focus to the nearest one.
 *
 * A double click counts once, and a held Enter does not repeat: either would otherwise
 * vote and take the vote back, or send a command per key repeat.
 *
 * On a phone the hand scrolls sideways. The selected card is kept in view (after a
 * reload, a vote of 21 would sit out of sight while the seat says the viewer voted), and
 * a fade on either edge says more cards lie that way.
 *
 * The cards deal in on mount (rise 12 px, fade, 260 ms, 30 ms stagger; a cross-fade under
 * reduced motion), in CSS, so they never wait for Motion's chunk.
 */
/** The edge fades' width; a card under one is scrolled clear of it. */
const FADE_PX = 32;

export function Hand({
  cards,
  selected,
  disabled = false,
  describedBy,
  onPick,
  className,
}: HandProps) {
  const t = useT();
  const toolbar = useRef<HTMLDivElement>(null);
  const [focused, setFocused] = useState<number | null>(null);
  const [edges, setEdges] = useState({ start: false, end: false });
  /** The card that last had the focus, while the focus is (or was, until removed) in the hand. */
  const lastFocus = useRef<{ value: string; index: number } | null>(null);
  const selectedAt = selected === null ? -1 : cards.indexOf(selected);
  const focusedCard = focused !== null && focused < cards.length ? focused : null;
  const tabStop = focusedCard ?? Math.max(selectedAt, 0);
  const deck = JSON.stringify(cards);

  const buttons = () => [...(toolbar.current?.querySelectorAll("button") ?? [])];

  const measure = useCallback(() => {
    const bar = toolbar.current;
    if (!bar) return;
    const start = bar.scrollLeft > 1;
    const end = bar.scrollLeft + bar.clientWidth < bar.scrollWidth - 1;
    setEdges((before) => (before.start === start && before.end === end ? before : { start, end }));
  }, []);

  // The fades follow the hand's width and its deck.
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new deck changes the width.
  useLayoutEffect(() => {
    measure();
    const bar = toolbar.current;
    if (!bar || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(bar);
    return () => observer.disconnect();
  }, [measure, deck]);

  // The selected card in view, on mount and whenever the vote changes. Only the hand
  // scrolls: `scrollIntoView` would scroll the page too.
  useLayoutEffect(() => {
    const bar = toolbar.current;
    const button = selectedAt < 0 ? undefined : bar?.querySelectorAll("button")[selectedAt];
    if (!bar || !button) return;
    const box = bar.getBoundingClientRect();
    const at = button.getBoundingClientRect();
    if (at.left < box.left + FADE_PX) bar.scrollLeft -= box.left + FADE_PX - at.left;
    else if (at.right > box.right - FADE_PX) bar.scrollLeft += at.right - box.right + FADE_PX;
    measure();
  }, [selectedAt, measure]);

  // A deck change removed the focused card: the focus goes to the nearest one.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs when the deck changes.
  useLayoutEffect(() => {
    const last = lastFocus.current;
    if (last === null || cards.includes(last.value)) return;
    lastFocus.current = null;
    const active = document.activeElement;
    if (active !== null && active !== document.body) return;
    const index = Math.min(last.index, cards.length - 1);
    if (index >= 0) buttons()[index]?.focus();
  }, [deck]);

  function onBlur(event: FocusEvent<HTMLDivElement>) {
    const next = event.relatedTarget;
    if (next instanceof Node && toolbar.current?.contains(next)) return;
    const card = event.target;
    // A card the deck change removed keeps its place; any other blur leaves the hand.
    requestAnimationFrame(() => {
      if (card.isConnected) lastFocus.current = null;
    });
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    // A held Enter repeats its keydown, and each would press the card again.
    if (event.repeat && (event.key === "Enter" || event.key === " ")) {
      event.preventDefault();
      return;
    }
    const all = buttons();
    const from = all.indexOf(event.target as HTMLButtonElement);
    if (from < 0 || all.length === 0) return;
    const step = NEXT[event.key];
    const to =
      step !== undefined
        ? (from + step + all.length) % all.length
        : event.key === "Home"
          ? 0
          : event.key === "End"
            ? all.length - 1
            : null;
    if (to === null) return;
    event.preventDefault();
    all[to]?.focus();
  }

  return (
    <div className={cn("relative", className)}>
      <div
        ref={toolbar}
        role="toolbar"
        aria-label={t("cards.yourCards")}
        aria-describedby={describedBy}
        aria-orientation="horizontal"
        data-hand
        onKeyDown={onKeyDown}
        onBlur={onBlur}
        onScroll={measure}
        className="flex min-w-0 gap-2 overflow-x-auto px-3 pt-5 pb-4 sm:justify-center-safe"
      >
        {cards.map((value, i) => (
          <HandCard
            key={value}
            value={value}
            label={cardLabel(t, value)}
            selected={value === selected}
            aria-disabled={disabled || undefined}
            tabIndex={i === tabStop ? 0 : -1}
            data-hand-card={value}
            onFocus={() => {
              setFocused(i);
              lastFocus.current = { value, index: i };
            }}
            onClick={(event) => {
              // The second click of a double click would take the vote straight back.
              if (!disabled && event.detail <= 1) onPick(value, event.currentTarget);
            }}
            className="animate-in fade-in slide-in-from-bottom-3 ease-standard animation-duration-260 fill-mode-backwards motion-reduce:[--tw-enter-translate-y:0]"
            style={i > 0 ? { animationDelay: `${i * 30}ms` } : undefined}
          />
        ))}
      </div>
      {/* More cards that way: decorative, the toolbar's arrows reach them all. */}
      {edges.start ? (
        <div
          aria-hidden="true"
          data-hand-fade="start"
          className="pointer-events-none absolute inset-y-0 left-0 w-8 rounded-l-xl bg-linear-to-r from-surface to-transparent"
        />
      ) : null}
      {edges.end ? (
        <div
          aria-hidden="true"
          data-hand-fade="end"
          className="pointer-events-none absolute inset-y-0 right-0 w-8 rounded-r-xl bg-linear-to-l from-surface to-transparent"
        />
      ) : null}
    </div>
  );
}
