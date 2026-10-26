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

/** The first supported language among the browser's preferences, English otherwise. */
export function pickLanguage(preferences: readonly string[]): Language {
  for (const tag of preferences) {
    const primary = tag.toLowerCase().split("-")[0];
    if (isLanguage(primary)) {
      return primary;
    }
  }
  return "en";
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
  const { languages, language } = window.navigator;
  return pickLanguage(languages?.length ? languages : language ? [language] : []);
}
