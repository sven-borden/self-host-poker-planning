import { cn } from "../../lib/utils.ts";

/** Seat centres around the drawing's table, in viewBox units: three a side, one per end. */
const SEATS = [
  [64, 14],
  [120, 14],
  [176, 14],
  [64, 106],
  [120, 106],
  [176, 106],
  [16, 60],
  [224, 60],
] as const;

/**
 * The picture on the not-found and error pages: the boardroom table of the design brief,
 * its seats empty, drawn from the tokens (no stock art), so it follows both themes and
 * W7's branding. `card` lays one face-down card on the table. Decorative: hidden from
 * screen readers, and nothing it shows is missing from the text.
 */
export function EmptyTable({ card = false, className }: { card?: boolean; className?: string }) {
  return (
    <svg
      viewBox="0 0 240 120"
      aria-hidden="true"
      focusable="false"
      className={cn("h-auto w-44 sm:w-52", className)}
    >
      <rect
        x="34"
        y="30"
        width="172"
        height="60"
        rx="30"
        strokeWidth="5"
        className="fill-table stroke-table-rim"
      />
      {SEATS.map(([cx, cy]) => (
        <circle
          key={`${cx}-${cy}`}
          cx={cx}
          cy={cy}
          r="8"
          strokeWidth="1.5"
          strokeDasharray="3 3"
          className="fill-none stroke-line-strong"
        />
      ))}
      {card && (
        <rect
          x="108"
          y="44"
          width="24"
          height="34"
          rx="3"
          strokeWidth="1.5"
          transform="rotate(-12 120 61)"
          className="fill-brass stroke-card-edge"
        />
      )}
    </svg>
  );
}
