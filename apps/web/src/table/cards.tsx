import { cardLength } from "@pp/domain";
import { CoffeeIcon, InfinityIcon } from "lucide-react";
import { type ComponentProps, type RefObject, useLayoutEffect, useRef, useState } from "react";
import type { TFunction } from "../i18n/i18n.ts";
import { cn } from "../lib/utils.ts";
import { measuredEms, useLabelFonts } from "./label-width.ts";
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
const FRACTION = /[½¼¾]/u;

/** A lowercase letter narrower than "m" and "w": at most 0.8 em of Archivo ExtraBold. */
const NARROW_LOWERCASE = /[a-ln-vx-z]/g;

/** No card label is drawn smaller than this, in CSS pixels (docs/03-design-brief.md, "Cards"). */
export const MIN_LABEL_PX = 7;

/**
 * An estimate of the widest a label can be, in ems of Archivo ExtraBold at 110 % width,
 * for when it cannot be measured (`label-width.ts`: tests, or before the font loads): per
 * grapheme (the domain's `cardLength`, at most 4), 0.72 em for a digit, 1 em for ½, ¼ and
 * ¾ and for any letter (W and M are the widest) but 0.8 em for a lowercase ASCII letter
 * other than m and w, 1.3 em for an emoji.
 */
export function labelEms(value: string): number {
  if (PICTOGRAPH.test(value)) return Math.max(1, cardLength(value)) * 1.3;
  if (NUMERAL.test(value)) {
    const ems = [...value].reduce((sum, char) => sum + (FRACTION.test(char) ? 1 : 0.72), 0);
    return Math.max(0.72, ems);
  }
  const narrow = value.match(NARROW_LOWERCASE)?.length ?? 0;
  return Math.max(0.8, Math.max(1, cardLength(value)) - 0.2 * narrow);
}

/**
 * How wide Archivo ExtraBold is at 70 % width against the faces' 110 %: 0.66 ("XXL",
 * "100") to 0.72 ("M"), measured in Chromium; rounded up, so a label never overflows.
 */
const NARROW_WIDTH = 0.73;

/** The label's width in ems at 110 % (`narrow` false) or 70 % width: measured, or estimated. */
function labelWidth(value: string, narrow: boolean): number {
  return measuredEms(value, narrow ? 70 : 110) ?? labelEms(value) * (narrow ? NARROW_WIDTH : 1);
}

const scaleFor = (room: number, width: number) =>
  Math.min(1, Math.floor((room / width) * 1000) / 1000);

/** The scale (at most 1) that fits `value` into `room` ems of the card's font size. */
export function labelScale(value: string, room: number): number {
  return scaleFor(room, labelWidth(value, false));
}

/** Below this scale a label narrows instead (`labelFit`). */
const NARROW_BELOW = 0.8;

/**
 * How a label fits `room` ems: its scale, whether it uses Archivo's width axis at 70 %
 * (`narrow`), and its width in ems at that axis. A label that would shrink below 80 %
 * narrows first, then shrinks (#22, #26), so "XXL" and "100" stay legible on the dense
 * phone slot and the results' chips. The drawn size never goes under `MIN_LABEL_PX`
 * (`CardValue`).
 */
export function labelFit(
  value: string,
  room: number,
): { scale: number; narrow: boolean; width: number } {
  const wide = labelWidth(value, false);
  const scale = scaleFor(room, wide);
  // An emoji comes from another font, which has no width axis: it only shrinks.
  if (scale >= NARROW_BELOW || PICTOGRAPH.test(value)) {
    return { scale, narrow: false, width: wide };
  }
  const width = labelWidth(value, true);
  return { scale: scaleFor(room, width), narrow: true, width };
}

/** The card a label is drawn on: its width is the room the label has. */
const CARD_BOX = "[data-hand-card], [data-face], [data-mini-card], [data-card-box]";

/**
 * Whether the drawn label is wider than its card's content box, measured after layout
 * on the real element: whatever font the system drew it in (Archivo has no Cyrillic, so
 * "щщщщ" comes from a fallback without a width axis), the check holds. Layout widths,
 * not boxes, so a card mid-turn (a transform) measures the same.
 */
function overflows(label: HTMLElement): boolean {
  const card = label.closest<HTMLElement>(CARD_BOX) ?? label.parentElement;
  if (!card || card.clientWidth === 0) return false;
  const style = getComputedStyle(card);
  const room =
    card.clientWidth -
    (Number.parseFloat(style.paddingLeft) || 0) -
    (Number.parseFloat(style.paddingRight) || 0);
  return label.offsetWidth > room;
}

/**
 * A card's face value, in the font size of its parent, fitted into `room` ems of that size
 * on one line (narrowed first when it is long, `labelFit`), never under 7 px. A label that
 * still does not fit its card at that size, as drawn, is clipped on that card, centred
 * (`data-clipped`, the whole label in a `title`); the card's accessible name, the seat's
 * popover and the results' words say it whole. ☕ and ∞ are drawn as icons: emoji and
 * missing glyphs would render in another font, colour or size on every system.
 *
 * `index`: a hand card's corner index (#37). Its text is drawn from `data-label` as
 * generated content, so the button's visible text is the big numeral alone and matches
 * its accessible name (WCAG 2.5.3: "5", not "5 5 5", for speech input and axe).
 */
export function CardValue({
  value,
  room,
  index = false,
}: {
  value: string;
  room: number;
  index?: boolean;
}) {
  useLabelFonts();
  const ref = useRef<HTMLSpanElement>(null);
  const [clipped, setClipped] = useState(false);

  // After every layout, and whenever the card's size changes without a render (a
  // breakpoint): measure the drawn label against its card.
  useLayoutEffect(() => {
    const label = ref.current;
    if (!label) return;
    const check = () => setClipped(overflows(label));
    check();
    if (typeof ResizeObserver === "undefined") return;
    const card = label.closest(CARD_BOX);
    if (!card) return;
    const observer = new ResizeObserver(check);
    observer.observe(card);
    return () => observer.disconnect();
  });

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
  const { scale, narrow } = labelFit(value, room);
  const label = (
    <span
      ref={ref}
      aria-hidden="true"
      data-card-value
      data-narrow={narrow || undefined}
      data-clipped={clipped || undefined}
      data-label={index ? value : undefined}
      className={cn("whitespace-nowrap", index && "before:content-[attr(data-label)]")}
      style={{
        fontSize: `max(${MIN_LABEL_PX}px, ${scale}em)`,
        fontStretch: narrow ? "70%" : undefined,
      }}
    >
      {index ? null : value}
    </span>
  );
  if (!clipped) return label;
  // Cut at both edges of the card's content box: justify-content centres an overflowing
  // item. The label keeps its own width, so the next check still sees it overflow.
  return (
    <span
      aria-hidden="true"
      data-label-clip
      title={value}
      className="flex max-w-full min-w-0 justify-center overflow-hidden"
    >
      {label}
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
      <span
        aria-hidden="true"
        data-corner
        className="absolute top-[5px] left-[5px] text-[9px] leading-none font-bold"
      >
        <CardValue value={value} room={3.6} index />
      </span>
      {/* 34 px of the phone card's 44, in its 18 px font. */}
      <CardValue value={value} room={1.88} />
      <span
        aria-hidden="true"
        data-corner
        className="absolute right-[5px] bottom-[5px] rotate-180 text-[9px] leading-none font-bold"
      >
        <CardValue value={value} room={3.6} index />
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
 * no motion. A new face cancels the motion. A face-up card whose value changes (a vote
 * changed after the reveal, #29) turns over once more, at once, to its new value; under
 * reduced motion the new value simply replaces the old.
 */
export function SlotCard({ face, value, size, turnDelay = 0, className }: SlotCardProps) {
  const root = useRef<HTMLDivElement>(null);
  const cover = useRef<HTMLDivElement>(null);
  const before = useRef({ face, value });
  const delay = useRef(turnDelay);
  delay.current = turnDelay;
  const radius = size.width >= 27 ? 5 : 4;
  const box = { width: size.width, height: size.height, borderRadius: radius };
  const shown: SlotFace = face === "up" && !value ? "empty" : face;

  useLayoutEffect(() => {
    const was = before.current;
    before.current = { face: shown, value };
    const changes = shown === "up" && was.face === "up" && was.value !== value;
    const turns = shown === "up" && (was.face === "down" || was.face === "empty");
    const fades = shown === "gone" && was.face === "down";
    if (!turns && !fades && !changes) return;
    const reduced = prefersReducedMotion();
    if (changes) {
      if (reduced) return;
      const turn = turnUp(0, false, size.width * 6);
      const animations = [play(root.current, turn.face), play(cover.current, turn.cover)];
      return () => cancelAll(animations);
    }
    if (fades) {
      const fading = play(cover.current, fadeAway(reduced));
      return () => cancelAll([fading]);
    }
    const turn = turnUp(delay.current, reduced, size.width * 6);
    const animations = [play(root.current, turn.face), play(cover.current, turn.cover)];
    return () => cancelAll(animations);
  }, [shown, value, size.width]);

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
  // The dense phone slot (20 × 28, 16 people) cannot grow without touching its
  // neighbours (layout.test.ts), so its label gets a larger font and 1 px a side
  // instead of 2, and a long one narrows (`labelFit`): "13" and "XL" show at 11 px,
  // "100" at 10 px, "XXL" at 7 px (#22).
  const small = size.width <= 20;
  const fontSize = Math.round(size.height * (small ? 0.39 : 0.34));
  const inner = size.width - (small ? 4 : 6);
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
      {/* The inner width less 2 px a side (1 px on the dense phone slot). A label that does
          not fit at 7 px is clipped: the seat and its popover say it whole. */}
      <CardValue value={value ?? ""} room={inner / fontSize} />
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
