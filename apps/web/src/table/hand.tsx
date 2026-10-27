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
 * vote and take the vote back, or send a command per key repeat. When the page puts the
 * focus here itself (after "Start voting" or "Next round" left with it, `relatedTarget`
 * null), Enter and Space do nothing for `PLACED_FOCUS_GUARD_MS`: the second press of a
 * double Enter on the button would otherwise vote for the first card.
 *
 * On a phone the hand scrolls sideways, snapping a card to the middle (#22). The selected
 * card is kept in view (after a reload, a vote of 21 would sit out of sight while the seat
 * says the viewer voted), so is the card the arrow keys focus, without moving the page,
 * and a fade on either edge says more cards lie that way.
 *
 * The cards deal in on mount (rise 12 px, fade, 260 ms, 30 ms stagger; a cross-fade under
 * reduced motion), in CSS, so they never wait for Motion's chunk.
 */
/** The edge fades' width; a card under one is scrolled clear of it. */
const FADE_PX = 32;
/** How long Enter and Space do nothing after the page, not the person, focused the hand. */
export const PLACED_FOCUS_GUARD_MS = 300;

const isPress = (key: string) => key === "Enter" || key === " ";

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
  /** Until when Enter and Space are ignored (`performance.now()`), after a placed focus. */
  const guardUntil = useRef(0);
  /** A Space whose keydown was ignored: its keyup must not press the card either. */
  const swallowSpace = useRef(false);
  const selectedAt = selected === null ? -1 : cards.indexOf(selected);
  const focusedCard = focused !== null && focused < cards.length ? focused : null;
  const tabStop = focusedCard ?? Math.max(selectedAt, 0);
  const deck = JSON.stringify(cards);

  const buttons = () => [...(toolbar.current?.querySelectorAll("button") ?? [])];

  /**
   * Scrolls the hand alone (never the page, which `scrollIntoView` or a plain `focus()`
   * would move under a docked hand) so that a card under a fade or beyond lies in the
   * middle, one of its snap points.
   */
  const centre = useCallback((button: HTMLElement | undefined) => {
    const bar = toolbar.current;
    if (!bar || !button) return;
    const box = bar.getBoundingClientRect();
    const at = button.getBoundingClientRect();
    if (at.left < box.left + FADE_PX || at.right > box.right - FADE_PX) {
      bar.scrollLeft += (at.left + at.right) / 2 - (box.left + box.right) / 2;
    }
  }, []);

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

  // The selected card in view, on mount and whenever the vote changes: when it lies under
  // a fade or beyond, the hand scrolls it to the middle, which is one of its snap points
  // (#22), so the browser leaves it there.
  useLayoutEffect(() => {
    if (selectedAt < 0) return;
    centre(toolbar.current?.querySelectorAll("button")[selectedAt]);
    measure();
  }, [selectedAt, centre, measure]);

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

  function onFocus(event: FocusEvent<HTMLDivElement>) {
    // No element lost the focus to the hand: the page moved it here (`focusSoon` after a
    // start), or the person came from nowhere. Either way a key still on its way is not
    // meant for a card.
    if (event.relatedTarget === null)
      guardUntil.current = performance.now() + PLACED_FOCUS_GUARD_MS;
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    // A held Enter repeats its keydown, and each would press the card again.
    if (isPress(event.key) && (event.repeat || performance.now() < guardUntil.current)) {
      event.preventDefault();
      if (!event.repeat && event.key === " ") swallowSpace.current = true;
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
    // The browser would scroll the card into view its own way, the page with it, and
    // leave it at the hand's edge: the hand centres it instead, as it does the vote.
    all[to]?.focus({ preventScroll: true });
    centre(all[to]);
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
        onKeyUp={(event) => {
          // A button presses on Space's keyup: one whose keydown was ignored does not.
          if (event.key === " " && swallowSpace.current) {
            swallowSpace.current = false;
            event.preventDefault();
          }
        }}
        onFocus={onFocus}
        onBlur={onBlur}
        onScroll={measure}
        // Snap points: a swipe on a phone comes to rest with a card in the middle, never
        // half under a fade. Cards keep 44 px of width, a whole touch target.
        className="flex min-w-0 snap-x snap-mandatory gap-2 overflow-x-auto px-3 pt-5 pb-4 sm:justify-center-safe phone:pt-4 phone:pb-2"
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
            className="snap-center animate-in fade-in slide-in-from-bottom-3 ease-standard animation-duration-260 fill-mode-backwards motion-reduce:[--tw-enter-translate-y:0]"
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
