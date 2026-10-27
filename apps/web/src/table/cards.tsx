import { cardLength } from "@pp/domain";
import { CoffeeIcon, InfinityIcon } from "lucide-react";
import type { ComponentProps } from "react";
import type { TFunction } from "../i18n/i18n.ts";
import { cn } from "../lib/utils.ts";
import type { Size } from "./layout.ts";
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
const FACE =
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
 * is a border on `::after`, not a box-shadow, so it survives forced colours.
 */
export function HandCard({ value, selected = false, label, className, ...props }: HandCardProps) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      aria-label={label}
      className={cn(
        FACE,
        "relative grid h-[72px] w-[50px] shrink-0 cursor-pointer place-items-center rounded-[7px] p-0 text-[20px]/none shadow-sm phone:h-16 phone:w-11 phone:text-[18px]/none",
        "transition-[translate,box-shadow] duration-200 ease-standard hover:not-disabled:-translate-y-1.5 hover:not-disabled:shadow-md",
        "aria-pressed:-translate-y-3 aria-pressed:shadow-md aria-pressed:after:pointer-events-none aria-pressed:after:absolute aria-pressed:after:-inset-[3px] aria-pressed:after:rounded-[9px] aria-pressed:after:border-2 aria-pressed:after:border-brass",
        "disabled:cursor-default disabled:opacity-40",
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

export type SlotFace = "empty" | "down" | "up";

interface SlotCardProps {
  /** `empty`: an outline waiting for a card; `down`: the brass back; `up`: the value. */
  face: SlotFace;
  value?: string | null;
  /** From the layout: 36 × 50 or 30 × 42 on desktop, 27 × 38 or 20 × 28 on phones. */
  size: Size;
  className?: string;
}

/** The card on the table in front of a seat. Decorative: the seat says the same. */
export function SlotCard({ face, value, size, className }: SlotCardProps) {
  const radius = size.width >= 27 ? 5 : 4;
  const box = { width: size.width, height: size.height, borderRadius: radius };
  if (face === "empty" || (face === "up" && !value)) {
    // Dashed in forced colours, where the filled back of a played card reads solid.
    return (
      <div
        aria-hidden="true"
        data-face="empty"
        className={cn("border border-table-ink/30 forced-colors:border-dashed", className)}
        style={box}
      />
    );
  }
  if (face === "down") {
    return (
      <div
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
      aria-hidden="true"
      data-face="up"
      className={cn(FACE, "grid place-items-center leading-none shadow-md", className)}
      style={{ ...box, fontSize }}
    >
      {/* The inner width less 2 px a side. */}
      <CardValue value={value ?? ""} room={(size.width - 6) / fontSize} />
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
        FACE,
        "grid h-[39px] w-7 shrink-0 place-items-center rounded-[4px] text-[13px] leading-none",
        className,
      )}
    >
      <CardValue value={value} room={22 / 13} />
    </span>
  );
}
