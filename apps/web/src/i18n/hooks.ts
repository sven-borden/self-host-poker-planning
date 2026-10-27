import { useMemo, useSyncExternalStore } from "react";
import { formatDate, formatList, formatNumber, formatRelativeTime, formatTime } from "./format.ts";
import { chooseLanguage, currentLanguage, fixedT, subscribe, type TFunction } from "./i18n.ts";
import { type Language, localeFor } from "./language.ts";

// The hooks components use. Each re-renders its component when the language changes,
// through React's own `useSyncExternalStore`: no provider, no shim.

function useCurrentLanguage(): Language {
  return useSyncExternalStore(subscribe, currentLanguage, currentLanguage);
}

/** The typed `t` for the current language. */
export function useT(): TFunction {
  return fixedT(useCurrentLanguage());
}

/** The current language, and the switcher's action (changes it and saves the choice). */
export function useLanguage(): [Language, (language: Language) => Promise<void>] {
  return [useCurrentLanguage(), chooseLanguage];
}

export interface Formatters {
  number: (value: number, options?: Intl.NumberFormatOptions) => string;
  date: (date: Date | number, options?: Intl.DateTimeFormatOptions) => string;
  time: (date: Date | number, options?: Intl.DateTimeFormatOptions) => string;
  relativeTime: (date: Date | number, now?: Date | number) => string;
  list: (items: readonly string[]) => string;
}

/** `formatNumber` and friends, in the current language and the reader's region. */
export function useFormat(): Formatters {
  const language = useCurrentLanguage();
  return useMemo(() => {
    const locale = localeFor(language);
    return {
      number: (value, options) => formatNumber(value, locale, options),
      date: (date, options) => formatDate(date, locale, options),
      time: (date, options) => formatTime(date, locale, options),
      relativeTime: (date, now) => formatRelativeTime(date, locale, now),
      list: (items) => formatList(items, locale),
    };
  }, [language]);
}
