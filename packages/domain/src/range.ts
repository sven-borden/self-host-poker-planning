import { type Card, cardLength, MAX_CARD_LENGTH, MAX_DECK_CARDS } from "./decks.ts";

export type RangeErrorCode =
  | "range_not_finite"
  | "range_step_not_positive"
  | "range_end_before_start"
  | "range_too_many_cards"
  | "range_label_too_long";

/** Labels hold at most 4 characters, so no value needs more than 3 decimal places. */
const MAX_DECIMALS = 3;

/** The decimal places of `n` up to MAX_DECIMALS, or null when it needs more. */
function decimals(n: number): number | null {
  for (let k = 0; k <= MAX_DECIMALS; k++) {
    const scale = 10 ** k;
    if (Math.round(n * scale) / scale === n) return k;
  }
  return null;
}

/** The canonical label of `units / scale`: "." as the mark, no trailing zeros. */
function label(units: number, digits: number): Card {
  const scale = 10 ** digits;
  const abs = Math.abs(units);
  const whole = String(Math.floor(abs / scale));
  const frac = String(abs % scale)
    .padStart(digits, "0")
    .replace(/0+$/, "");
  return (units < 0 ? "-" : "") + whole + (frac ? `.${frac}` : "");
}

/**
 * The cards from `start` to `end` (inclusive when reached) by `step`, for example 0 to 4
 * by 0.5. The arithmetic runs on integers scaled by the decimal places of `start` and
 * `step`, so 0 to 1 by 0.1 gives exactly "0", "0.1" … "1" with no floating-point drift.
 */
export function generateRange({
  start,
  end,
  step,
}: {
  start: number;
  end: number;
  step: number;
}): { ok: true; cards: Card[] } | { ok: false; code: RangeErrorCode } {
  if (!Number.isFinite(start) || !Number.isFinite(end) || !Number.isFinite(step)) {
    return { ok: false, code: "range_not_finite" };
  }
  if (step <= 0) return { ok: false, code: "range_step_not_positive" };
  if (end < start) return { ok: false, code: "range_end_before_start" };
  const startDigits = decimals(start);
  const stepDigits = decimals(step);
  // A value with more than 3 decimal places has a label of 5 characters or more.
  if (startDigits === null || stepDigits === null) {
    return { ok: false, code: "range_label_too_long" };
  }
  const digits = Math.max(startDigits, stepDigits);
  const scale = 10 ** digits;
  const first = Math.round(start * scale);
  const stride = Math.round(step * scale);
  // The tolerance absorbs binary noise in `end * scale` (0.29 * 100 = 28.999…).
  const count = Math.floor((end * scale - first) / stride + 1e-9) + 1;
  if (count > MAX_DECK_CARDS) return { ok: false, code: "range_too_many_cards" };
  const cards: Card[] = [];
  for (let i = 0; i < count; i++) {
    const card = label(first + i * stride, digits);
    if (cardLength(card) > MAX_CARD_LENGTH) return { ok: false, code: "range_label_too_long" };
    cards.push(card);
  }
  return { ok: true, cards };
}
