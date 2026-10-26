import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { formatDate, formatNumber, formatRelativeTime, formatTime } from "./format.ts";
import { chooseLanguage, type TFunction } from "./i18n.ts";
import { isLanguage, type Language } from "./language.ts";

// The hooks components use. Each re-renders its component when the language changes.

/** The typed `t` for the current language. */
export function useT(): TFunction {
  return useTranslation().t;
}

/** The current language, and the switcher's action (changes it and saves the choice). */
export function useLanguage(): [Language, (language: Language) => Promise<void>] {
  const { i18n } = useTranslation();
  const language = isLanguage(i18n.resolvedLanguage) ? i18n.resolvedLanguage : "en";
  return [language, chooseLanguage];
}

export interface Formatters {
  number: (value: number, options?: Intl.NumberFormatOptions) => string;
  date: (date: Date | number, options?: Intl.DateTimeFormatOptions) => string;
  time: (date: Date | number, options?: Intl.DateTimeFormatOptions) => string;
  relativeTime: (date: Date | number, now?: Date | number) => string;
}

/** `formatNumber` and friends, bound to the current language. */
export function useFormat(): Formatters {
  const [language] = useLanguage();
  return useMemo(
    () => ({
      number: (value, options) => formatNumber(value, language, options),
      date: (date, options) => formatDate(date, language, options),
      time: (date, options) => formatTime(date, language, options),
      relativeTime: (date, now) => formatRelativeTime(date, language, now),
    }),
    [language],
  );
}
