import type { Language } from "./language.ts";

// Numbers, dates and times in the reader's language, through `Intl`. Every number the UI
// shows goes through here (or through `{{value, number}}` in a catalog, which is the same
// `Intl.NumberFormat`): 5.5 reads "5,5" in French and German. Formatters are cached,
// because building one costs far more than using it.

const cache = new Map<string, Intl.NumberFormat | Intl.DateTimeFormat | Intl.RelativeTimeFormat>();

function cached<T extends Intl.NumberFormat | Intl.DateTimeFormat | Intl.RelativeTimeFormat>(
  kind: string,
  language: Language,
  options: object | undefined,
  make: () => T,
): T {
  const key = `${kind}|${language}|${JSON.stringify(options ?? {})}`;
  let formatter = cache.get(key);
  if (!formatter) {
    formatter = make();
    cache.set(key, formatter);
  }
  return formatter as T;
}

export function formatNumber(
  value: number,
  language: Language,
  options?: Intl.NumberFormatOptions,
): string {
  return cached("number", language, options, () => new Intl.NumberFormat(language, options)).format(
    value,
  );
}

/** A calendar date, "27 Oct 2026" style by default. */
export function formatDate(
  date: Date | number,
  language: Language,
  options: Intl.DateTimeFormatOptions = { dateStyle: "medium" },
): string {
  return cached("date", language, options, () => new Intl.DateTimeFormat(language, options)).format(
    date,
  );
}

/** A time of day, "14:05" or "2:05 PM" depending on the language. */
export function formatTime(
  date: Date | number,
  language: Language,
  options: Intl.DateTimeFormatOptions = { timeStyle: "short" },
): string {
  return formatDate(date, language, options);
}

const UNITS: readonly [Intl.RelativeTimeFormatUnit, number][] = [
  ["second", 60],
  ["minute", 60],
  ["hour", 24],
  ["day", 7],
  ["week", 4.35],
  ["month", 12],
  ["year", Number.POSITIVE_INFINITY],
];

/**
 * How far `date` is from `now`, in the largest unit that keeps the number small: "now",
 * "5 minutes ago", "il y a 2 heures", "gestern", "in 3 days".
 */
export function formatRelativeTime(
  date: Date | number,
  language: Language,
  now: Date | number = Date.now(),
): string {
  const formatter = cached(
    "relative",
    language,
    undefined,
    () => new Intl.RelativeTimeFormat(language, { numeric: "auto" }),
  );
  let amount = (Number(date) - Number(now)) / 1000;
  for (const [unit, size] of UNITS) {
    if (Math.abs(amount) < size) {
      // `+ 0` turns -0 into 0, which `Intl` would otherwise print as "0 seconds ago".
      return formatter.format(Math.round(amount) + 0, unit);
    }
    amount /= size;
  }
  return formatter.format(Math.round(amount) + 0, "year");
}
