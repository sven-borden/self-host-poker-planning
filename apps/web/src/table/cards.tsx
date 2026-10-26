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

/** What a screen reader says for a card: the number, or a word for a special. */
export function cardLabel(t: TFunction, value: string): string {
  return isSpecialCard(value) ? t(SPOKEN[value]) : value;
}

/**
 * A card's face value at `fontSize` pixels. ☕ and ∞ are drawn as icons: emoji and
 * missing glyphs would render in another font, colour or size on every system.
 */
export function CardValue({ value, fontSize }: { value: string; fontSize: number }) {
  if (value === "☕" || value === "∞") {
    const Icon = value === "☕" ? CoffeeIcon : InfinityIcon;
    const size = Math.round(fontSize * 1.05);
    return <Icon aria-hidden="true" width={size} height={size} strokeWidth={2.25} />;
  }
  // Long values ("100", "XXL") step down so they never touch the card's edges.
  const size = Array.from(value).length > 2 ? Math.round(fontSize * 0.78) : fontSize;
  return (
    <span aria-hidden="true" style={{ fontSize: size }}>
      {value}
    </span>
  );
}

const FACE =
  "border border-card-edge bg-card-face text-card-ink font-display leading-none font-extrabold [font-stretch:110%]";

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
 * means. Hover lifts 6 px, selected lifts 12 px; both are whole pixels.
 */
export function HandCard({ value, selected = false, label, className, ...props }: HandCardProps) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      aria-label={label}
      className={cn(
        FACE,
        "relative grid h-[72px] w-[50px] shrink-0 cursor-pointer place-items-center rounded-[7px] p-0 text-[20px] shadow-sm phone:h-16 phone:w-11 phone:text-[18px]",
        "transition-[translate,box-shadow] duration-200 ease-standard hover:not-disabled:-translate-y-1.5 hover:not-disabled:shadow-md",
        "aria-pressed:-translate-y-3 aria-pressed:shadow-md aria-pressed:ring-2 aria-pressed:ring-brass",
        "disabled:cursor-default disabled:opacity-40",
        className,
      )}
      {...props}
    >
      <span className="absolute top-[5px] left-[5px] font-bold">
        <CardValue value={value} fontSize={9} />
      </span>
      <CardValue value={value} fontSize={20} />
      <span className="absolute right-[5px] bottom-[5px] rotate-180 font-bold">
        <CardValue value={value} fontSize={9} />
      </span>
    </button>
  );
}

export type SlotFace = "empty" | "down" | "up";

interface SlotCardProps {
  /** `empty`: an outline waiting for a card; `down`: the brass back; `up`: the value. */
  face: SlotFace;
  value?: string | null;
  /** From the layout: 36 × 50, 32 × 44, 27 × 38 or 21 × 30. */
  size: Size;
  className?: string;
}

/** The card on the table in front of a seat. Decorative: the seat says the same. */
export function SlotCard({ face, value, size, className }: SlotCardProps) {
  const radius = size.width >= 27 ? 5 : 4;
  const box = { width: size.width, height: size.height, borderRadius: radius };
  if (face === "empty" || (face === "up" && !value)) {
    return (
      <div
        aria-hidden="true"
        data-face="empty"
        className={cn("border border-table-ink/30", className)}
        style={box}
      />
    );
  }
  if (face === "down") {
    return (
      <div
        aria-hidden="true"
        data-face="down"
        className={cn("bg-card-face p-[2px] shadow-md", className)}
        style={box}
      >
        <div className="pp-card-back size-full" style={{ borderRadius: radius - 2 }} />
      </div>
    );
  }
  return (
    <div
      aria-hidden="true"
      data-face="up"
      className={cn(FACE, "grid place-items-center shadow-md", className)}
      style={box}
    >
      <CardValue value={value ?? ""} fontSize={Math.round(size.height * 0.34)} />
    </div>
  );
}

/** A mini card for anonymous results: 28 × 39. */
export function MiniCard({ value, className }: { value: string; className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn(FACE, "grid h-[39px] w-7 shrink-0 place-items-center rounded-[4px]", className)}
    >
      <CardValue value={value} fontSize={13} />
    </span>
  );
}
