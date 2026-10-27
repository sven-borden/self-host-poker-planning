import { useId } from "react";
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
 * W7's branding. `card` lays one face-down card on the table, with the table's card back
 * (#13, `.pp-card-back`): brass with darker diagonal stripes inside a frame of the face
 * colour. Decorative: hidden from screen readers, and nothing it shows is missing from
 * the text.
 */
export function EmptyTable({ card = false, className }: { card?: boolean; className?: string }) {
  // An id fit for url(#…): React's ids carry characters a url() reference may not.
  const stripes = `pp-stripes-${useId().replace(/[^\w-]/g, "")}`;
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
        <g transform="rotate(-12 120 61)">
          <defs>
            {/* The stripes of .pp-card-back: 3 units of brass, 3 of the rim, at 45 degrees. */}
            <pattern
              id={stripes}
              width="6"
              height="6"
              patternUnits="userSpaceOnUse"
              patternTransform="rotate(45)"
            >
              <rect x="3" width="3" height="6" className="fill-table-rim" opacity="0.38" />
            </pattern>
          </defs>
          <rect
            x="108"
            y="44"
            width="24"
            height="34"
            rx="3"
            strokeWidth="1"
            className="fill-card-face stroke-card-edge"
          />
          <rect x="110.5" y="46.5" width="19" height="29" rx="1.5" className="fill-brass" />
          <rect x="110.5" y="46.5" width="19" height="29" rx="1.5" fill={`url(#${stripes})`} />
        </g>
      )}
    </svg>
  );
}
