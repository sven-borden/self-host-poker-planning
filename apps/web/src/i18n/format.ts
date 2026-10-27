// Numbers, dates and times through `Intl`. Every number the UI shows goes through here
// (a catalog's `{{value, number}}` included): 5.5 reads "5,5" in French and German. Each
// helper takes a locale, normally `localeFor(language)` (language.ts), so the reader's
// region decides the details: "6.5" for de-CH, a 24-hour clock for en-GB. Formatters are
// cached on the kind, the locale and the options, never on the value, because building
// one costs far more than using it.

const cache = new Map<string, Intl.NumberFormat | Intl.DateTimeFormat | Intl.RelativeTimeFormat>();

function cached<T extends Intl.NumberFormat | Intl.DateTimeFormat | Intl.RelativeTimeFormat>(
  kind: string,
  locale: string,
  options: object | undefined,
  make: () => T,
): T {
  const key = `${kind}|${locale}|${JSON.stringify(options ?? {})}`;
  let formatter = cache.get(key);
  if (!formatter) {
    formatter = make();
    cache.set(key, formatter);
  }
  return formatter as T;
}

export function formatNumber(
  value: number,
  locale: string,
  options?: Intl.NumberFormatOptions,
): string {
  return cached("number", locale, options, () => new Intl.NumberFormat(locale, options)).format(
    value,
  );
}

/** A calendar date, "27 Oct 2026" style by default. */
export function formatDate(
  date: Date | number,
  locale: string,
  options: Intl.DateTimeFormatOptions = { dateStyle: "medium" },
): string {
  return cached("date", locale, options, () => new Intl.DateTimeFormat(locale, options)).format(
    date,
  );
}

/** A time of day, "14:05" or "2:05 PM" depending on the language. */
export function formatTime(
  date: Date | number,
  locale: string,
  options: Intl.DateTimeFormatOptions = { timeStyle: "short" },
): string {
  return formatDate(date, locale, options);
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
  locale: string,
  now: Date | number = Date.now(),
): string {
  const formatter = cached(
    "relative",
    locale,
    undefined,
    () => new Intl.RelativeTimeFormat(locale, { numeric: "auto" }),
  );
  let amount = (Number(date) - Number(now)) / 1000;
  for (const [unit, size] of UNITS) {
    // Compare the rounded amount, so 59.6 s reads "1 minute ago", not "60 seconds ago".
    const rounded = Math.round(amount);
    if (Math.abs(rounded) < size) {
      // `+ 0` turns -0 into 0, which `Intl` would otherwise print as "0 seconds ago".
      return formatter.format(rounded + 0, unit);
    }
    amount /= size;
  }
  return formatter.format(Math.round(amount) + 0, "year");
}
