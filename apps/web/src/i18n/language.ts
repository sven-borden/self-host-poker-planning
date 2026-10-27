// Which language the app speaks: the saved choice first, then the browser's preferences,
// then English. Pure functions and storage access only; i18n.ts applies the result.

export const LANGUAGES = ["en", "fr", "de"] as const;
export type Language = (typeof LANGUAGES)[number];

/** Each language named in itself, so a reader finds theirs whatever the page speaks. */
export const LANGUAGE_NAMES: Readonly<Record<Language, string>> = {
  en: "English",
  fr: "Français",
  de: "Deutsch",
};

export const LANGUAGE_STORAGE_KEY = "pp-language";

export function isLanguage(value: unknown): value is Language {
  return typeof value === "string" && (LANGUAGES as readonly string[]).includes(value);
}

/** Languages whose readers read one of ours: Swiss German (`gsw`) is written German. */
const ALIASES: Readonly<Record<string, Language>> = { gsw: "de" };

/** The supported language a BCP 47 tag (`de-CH`, `fr_CA`, `gsw`) belongs to, or null. */
export function languageOf(tag: string): Language | null {
  const primary = tag.toLowerCase().split(/[-_]/)[0] ?? "";
  const language = ALIASES[primary] ?? primary;
  return isLanguage(language) ? language : null;
}

/** The first supported language among the browser's preferences, English otherwise. */
export function pickLanguage(preferences: readonly string[]): Language {
  for (const tag of preferences) {
    const language = languageOf(tag);
    if (language) {
      return language;
    }
  }
  return "en";
}

/**
 * The locale numbers and dates use for `language`: the reader's first browser tag in
 * that language, so their region decides the details (`de-CH` writes 6.5 and 1’234,
 * `en-GB` a 24-hour clock), or the bare language when they list none (French and German
 * then write 6,5). `gsw` reads as `de-CH`.
 */
export function regionalLocale(language: Language, preferences: readonly string[]): string {
  for (const tag of preferences) {
    if (languageOf(tag) !== language) {
      continue;
    }
    const [primary = "", ...rest] = tag.split(/[-_]/);
    // Swiss German is written as Swiss Standard German: `gsw` and `gsw-CH` both read de-CH.
    const swiss = primary.toLowerCase() === "gsw";
    const candidate = swiss
      ? ["de", ...(rest.length ? rest : ["CH"])].join("-")
      : [primary, ...rest].join("-");
    try {
      return Intl.getCanonicalLocales(candidate)[0] ?? language;
    } catch {
      // A malformed tag: try the next one.
    }
  }
  return language;
}

const locales = new Map<Language, string>();
if (typeof window !== "undefined") {
  window.addEventListener("languagechange", () => locales.clear());
}

/** `regionalLocale` for this browser, remembered until its languages change. */
export function localeFor(language: Language): string {
  let locale = locales.get(language);
  if (!locale) {
    locale = regionalLocale(language, browserLanguages());
    locales.set(language, locale);
  }
  return locale;
}

function browserLanguages(): readonly string[] {
  if (typeof navigator === "undefined") {
    return [];
  }
  const { languages, language } = navigator;
  return languages?.length ? languages : language ? [language] : [];
}

/** Forgets the remembered locales (tests that change `navigator.languages`). */
export function resetLocales(): void {
  locales.clear();
}

/** The language the person picked in the switcher, or null (nothing saved, storage blocked). */
export function readSavedLanguage(): Language | null {
  try {
    const saved = window.localStorage.getItem(LANGUAGE_STORAGE_KEY);
    return isLanguage(saved) ? saved : null;
  } catch {
    return null;
  }
}

/** Saves the choice; storage errors are ignored (the choice then lasts for this page). */
export function saveLanguage(language: Language): void {
  try {
    window.localStorage.setItem(LANGUAGE_STORAGE_KEY, language);
  } catch {
    // Storage blocked: nothing to do.
  }
}

/** The saved choice, then the browser's languages, then English. */
export function detectLanguage(): Language {
  if (typeof window === "undefined") {
    return "en";
  }
  const saved = readSavedLanguage();
  if (saved) {
    return saved;
  }
  return pickLanguage(browserLanguages());
}
