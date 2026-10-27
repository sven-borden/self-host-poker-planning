import { type KeyboardEvent, useRef, useState } from "react";
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
 * focus (`aria-disabled`, never `disabled`), so the reveal never drops it.
 *
 * The cards deal in on mount (rise 12 px, fade, 260 ms, 30 ms stagger; a cross-fade under
 * reduced motion), in CSS, so they never wait for Motion's chunk.
 */
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
  const selectedAt = selected === null ? -1 : cards.indexOf(selected);
  const focusedCard = focused !== null && focused < cards.length ? focused : null;
  const tabStop = focusedCard ?? Math.max(selectedAt, 0);

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const buttons = [...(toolbar.current?.querySelectorAll("button") ?? [])];
    const from = buttons.indexOf(event.target as HTMLButtonElement);
    if (from < 0 || buttons.length === 0) return;
    const step = NEXT[event.key];
    const to =
      step !== undefined
        ? (from + step + buttons.length) % buttons.length
        : event.key === "Home"
          ? 0
          : event.key === "End"
            ? buttons.length - 1
            : null;
    if (to === null) return;
    event.preventDefault();
    buttons[to]?.focus();
  }

  return (
    <div
      ref={toolbar}
      role="toolbar"
      aria-label={t("cards.yourCards")}
      aria-describedby={describedBy}
      aria-orientation="horizontal"
      data-hand
      onKeyDown={onKeyDown}
      className={cn(
        "flex min-w-0 gap-2 overflow-x-auto px-3 pt-5 pb-4 sm:justify-center",
        className,
      )}
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
          onFocus={() => setFocused(i)}
          onClick={(event) => {
            if (!disabled) onPick(value, event.currentTarget);
          }}
          className="animate-in fade-in slide-in-from-bottom-3 ease-standard animation-duration-260 fill-mode-backwards motion-reduce:[--tw-enter-translate-y:0]"
          style={i > 0 ? { animationDelay: `${i * 30}ms` } : undefined}
        />
      ))}
    </div>
  );
}
