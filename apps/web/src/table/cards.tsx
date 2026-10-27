import { cardLength } from "@pp/domain";
import { CoffeeIcon, InfinityIcon } from "lucide-react";
import { type ComponentProps, type RefObject, useLayoutEffect, useRef } from "react";
import type { TFunction } from "../i18n/i18n.ts";
import { cn } from "../lib/utils.ts";
import type { Size } from "./layout.ts";
import { cancelAll, fadeAway, play, prefersReducedMotion, turnUp } from "./reveal-motion.ts";
import "./table.css";

// Cards (docs/03-design-brief.md, "Cards"): warm faces in both themes, wide Archivo
// numerals, brass backs. Vector and CSS only, whole-pixel sizes, no transform at rest,
// so they stay crisp at any device pixel ratio.

/** Special cards: never counted in statistics. */
export const SPECIAL_CARDS = ["?", "☕", "∞"] as const;

const SPOKEN = { "?": "cards.unsure", "☕": "cards.coffee", "∞": "cards.infinite" } as const;

export function isSpecialCard(value: string): value is (typeof SPECIAL_CARDS)[number] {
  return (SPECIAL_CARDS as readonly string[]).includes(value);
}

/**
 * What a screen reader says for a card: the label as the deck holds it, or a word for a
 * special. Labels are never localised (docs/03-design-brief.md, "Copy"): no preset holds a
 * decimal mark ("½" reads the same everywhere) and custom labels stay as typed, so "0.5"
 * is "0.5" in French too. Numbers the app computes go through `formatNumber` instead.
 */
export function cardLabel(t: TFunction, value: string): string {
  return isSpecialCard(value) ? t(SPOKEN[value]) : value;
}

const PICTOGRAPH = /\p{Extended_Pictographic}/u;
const NUMERAL = /^[\d.,½¼¾]+$/u;

/**
 * The widest a label can be, in ems of Archivo ExtraBold at 110 % width: per grapheme
 * (the domain's `cardLength`, at most 4), 0.72 em for digits, 1 em for any letter (W
 * and M are the widest), 1.3 em for an emoji.
 */
export function labelEms(value: string): number {
  const perGrapheme = PICTOGRAPH.test(value) ? 1.3 : NUMERAL.test(value) ? 0.72 : 1;
  return Math.max(1, cardLength(value)) * perGrapheme;
}

/** The scale (at most 1) that fits `value` into `room` ems of the card's font size. */
export function labelScale(value: string, room: number): number {
  return Math.min(1, Math.floor((room / labelEms(value)) * 1000) / 1000);
}

/**
 * A card's face value, in the font size of its parent, shrunk so that it fits in `room`
 * ems of that size on one line. ☕ and ∞ are drawn as icons: emoji and missing glyphs
 * would render in another font, colour or size on every system.
 */
export function CardValue({ value, room }: { value: string; room: number }) {
  if (value === "☕" || value === "∞") {
    const Icon = value === "☕" ? CoffeeIcon : InfinityIcon;
    return (
      <Icon
        aria-hidden="true"
        data-card-value
        width="1.05em"
        height="1.05em"
        strokeWidth={2.25}
        className="block"
      />
    );
  }
  return (
    <span
      aria-hidden="true"
      data-card-value
      className="whitespace-nowrap"
      style={{ fontSize: `${labelScale(value, room)}em` }}
    >
      {value}
    </span>
  );
}

// No text size here: tailwind-merge treats a later `text-[20px]` as a conflict with
// `leading-none` and drops it, so each card sets its size and line height together.
export const CARD_FACE =
  "border border-card-edge bg-card-face text-card-ink font-display font-extrabold [font-stretch:110%]";

type HandCardProps = Omit<ComponentProps<"button">, "children"> & {
  value: string;
  /** The person's current pick: lifted, with a brass ring. */
  selected?: boolean;
  /** Accessible name, usually `cardLabel(t, value)`. */
  label: string;
};

/**
 * A card in the hand: 50 × 72 (44 × 64 on phones), numeral centred, corner indices
 * top-left and bottom-right (rotated). A toggle button; the parent decides what a press
 * means. Hover lifts 6 px, selected lifts 12 px; both are whole pixels. The selected ring
 * is a border on `::after`, not a box-shadow, so it survives forced colours. `disabled`
 * and `aria-disabled` look the same; the hand uses `aria-disabled`, which keeps the focus.
 */
export function HandCard({ value, selected = false, label, className, ...props }: HandCardProps) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      aria-label={label}
      className={cn(
        CARD_FACE,
        "relative grid h-[72px] w-[50px] shrink-0 cursor-pointer place-items-center rounded-[7px] p-0 text-[20px]/none shadow-sm phone:h-16 phone:w-11 phone:text-[18px]/none",
        "transition-[translate,box-shadow,opacity] duration-200 ease-standard hover:not-disabled:not-aria-disabled:-translate-y-1.5 hover:not-disabled:not-aria-disabled:shadow-md",
        "aria-pressed:-translate-y-3 aria-pressed:shadow-md aria-pressed:after:pointer-events-none aria-pressed:after:absolute aria-pressed:after:-inset-[3px] aria-pressed:after:rounded-[9px] aria-pressed:after:border-2 aria-pressed:after:border-brass",
        "disabled:cursor-default disabled:opacity-40 aria-disabled:cursor-default aria-disabled:opacity-40",
        className,
      )}
      {...props}
    >
      <span data-corner className="absolute top-[5px] left-[5px] text-[9px] leading-none font-bold">
        <CardValue value={value} room={3.6} />
      </span>
      {/* 34 px of the phone card's 44, in its 18 px font. */}
      <CardValue value={value} room={1.88} />
      <span
        data-corner
        className="absolute right-[5px] bottom-[5px] rotate-180 text-[9px] leading-none font-bold"
      >
        <CardValue value={value} room={3.6} />
      </span>
    </button>
  );
}

/**
 * `empty`: an outline waiting for a card; `down`: the brass back; `up`: the value;
 * `gone`: after an anonymous reveal, the card left the seat for the row under the table,
 * and the slot is an outline again.
 */
export type SlotFace = "empty" | "down" | "up" | "gone";

interface SlotCardProps {
  face: SlotFace;
  value?: string | null;
  /** From the layout: 36 × 50 or 30 × 42 on desktop, 27 × 38 or 20 × 28 on phones. */
  size: Size;
  /**
   * When this card turns face up while on screen (the reveal, #19), it waits this many
   * milliseconds first: the table staggers the cards in seat order.
   */
  turnDelay?: number;
  className?: string;
}

/** The brass back over a slot card, shown only while it turns or fades (#19). */
function Cover({ radius, cover }: { radius: number; cover: RefObject<HTMLDivElement | null> }) {
  return (
    <div
      ref={cover}
      data-cover
      className="pointer-events-none absolute -inset-px border border-transparent bg-card-face p-px opacity-0 shadow-md"
      style={{ borderRadius: radius }}
    >
      <div className="pp-card-back size-full" style={{ borderRadius: radius - 2 }} />
    </div>
  );
}

/**
 * The card on the table in front of a seat. Decorative: the seat says the same. A card
 * seen face down or as an empty slot that turns `up` flips (after `turnDelay`, its back
 * showing while it waits): the last vote arrives together with the reveal, so on every
 * other screen its slot was still empty, and it turns in its place in the stagger like
 * the others. One seen face down that is `gone` (an anonymous reveal) shrinks and fades.
 * Both keep their back mounted over the slot for that (`Cover`, hidden at rest). A card
 * that is already up or gone when it mounts (a late joiner, a reload) shows at rest, with
 * no motion. A new face cancels the motion.
 */
export function SlotCard({ face, value, size, turnDelay = 0, className }: SlotCardProps) {
  const root = useRef<HTMLDivElement>(null);
  const cover = useRef<HTMLDivElement>(null);
  const before = useRef(face);
  const delay = useRef(turnDelay);
  delay.current = turnDelay;
  const radius = size.width >= 27 ? 5 : 4;
  const box = { width: size.width, height: size.height, borderRadius: radius };
  const shown: SlotFace = face === "up" && !value ? "empty" : face;

  useLayoutEffect(() => {
    const was = before.current;
    before.current = shown;
    const turns = shown === "up" && (was === "down" || was === "empty");
    const fades = shown === "gone" && was === "down";
    if (!turns && !fades) return;
    const reduced = prefersReducedMotion();
    if (fades) {
      const fading = play(cover.current, fadeAway(reduced));
      return () => cancelAll([fading]);
    }
    const turn = turnUp(delay.current, reduced, size.width * 6);
    const animations = [play(root.current, turn.face), play(cover.current, turn.cover)];
    return () => cancelAll(animations);
  }, [shown, size.width]);

  if (shown === "empty" || shown === "gone") {
    // Dashed in forced colours, where the filled back of a played card reads solid.
    return (
      <div
        ref={root}
        aria-hidden="true"
        data-face={shown}
        className={cn("relative border border-table-ink/30 forced-colors:border-dashed", className)}
        style={box}
      >
        {shown === "gone" ? <Cover radius={radius} cover={cover} /> : null}
      </div>
    );
  }
  if (shown === "down") {
    return (
      <div
        ref={root}
        aria-hidden="true"
        data-face="down"
        className={cn("border border-transparent bg-card-face p-px shadow-md", className)}
        style={box}
      >
        <div className="pp-card-back size-full" style={{ borderRadius: radius - 2 }} />
      </div>
    );
  }
  const fontSize = Math.round(size.height * 0.34);
  return (
    <div
      ref={root}
      aria-hidden="true"
      data-face="up"
      className={cn(
        CARD_FACE,
        "relative grid place-items-center leading-none shadow-md",
        className,
      )}
      style={{ ...box, fontSize }}
    >
      {/* The inner width less 2 px a side. */}
      <CardValue value={value ?? ""} room={(size.width - 6) / fontSize} />
      <Cover radius={radius} cover={cover} />
    </div>
  );
}

/** A mini card for anonymous results: 28 × 39. */
export function MiniCard({ value, className }: { value: string; className?: string }) {
  return (
    <span
      aria-hidden="true"
      data-mini-card
      className={cn(
        CARD_FACE,
        "grid h-[39px] w-7 shrink-0 place-items-center rounded-[4px] text-[13px] leading-none",
        className,
      )}
    >
      <CardValue value={value} room={22 / 13} />
    </span>
  );
}
