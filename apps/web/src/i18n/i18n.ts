import i18next, { type i18n as I18n, type TFunction as I18nextTFunction } from "i18next";
import { initReactI18next } from "react-i18next";
import { en } from "./en.ts";
import { detectLanguage, LANGUAGES, type Language, saveLanguage } from "./language.ts";

// i18next with react-i18next. English is bundled: it is the reference and the fallback.
// French and German are separate chunks, fetched on demand: before the first render when
// the page starts in that language (main.tsx waits for it alongside the route's chunk, so
// nothing shows in the wrong language), and when the switcher opens, so a pick is instant.

declare module "i18next" {
  interface CustomTypeOptions {
    defaultNS: "translation";
    resources: { translation: typeof en };
  }
}

/** The typed `t`: keys are checked, and so are their `{{variables}}`. */
export type TFunction = I18nextTFunction<"translation">;

export const i18n: I18n = i18next.createInstance();

void i18n.use(initReactI18next).init({
  resources: { en: { translation: en } },
  lng: "en",
  fallbackLng: "en",
  supportedLngs: [...LANGUAGES],
  // Resources are in memory: `init` finishes synchronously, so the first render has them.
  initAsync: false,
  // React escapes text itself.
  interpolation: { escapeValue: false },
  react: { useSuspense: false },
});

i18n.on("languageChanged", (language) => {
  if (typeof document !== "undefined") {
    document.documentElement.lang = language;
  }
});

const LOADERS: Record<Exclude<Language, "en">, () => Promise<object>> = {
  fr: () => import("./fr.ts").then((module) => module.fr),
  de: () => import("./de.ts").then((module) => module.de),
};

const loading = new Map<Language, Promise<void>>();

/** Fetches a language's catalog once; English is always there. */
export function loadLanguage(language: Language): Promise<void> {
  if (language === "en" || i18n.hasResourceBundle(language, "translation")) {
    return Promise.resolve();
  }
  let pending = loading.get(language);
  if (!pending) {
    pending = LOADERS[language]().then(
      (catalog) => {
        i18n.addResourceBundle(language, "translation", catalog);
      },
      (error: unknown) => {
        // A failed fetch (offline, a new deploy) may succeed on the next try.
        loading.delete(language);
        throw error;
      },
    );
    loading.set(language, pending);
  }
  return pending;
}

/** The language the app speaks now. */
export function currentLanguage(): Language {
  const language = i18n.resolvedLanguage;
  return LANGUAGES.find((supported) => supported === language) ?? "en";
}

/** Speaks `language` from now on: every mounted `useT` re-renders, `<html lang>` follows. */
export async function changeLanguage(language: Language): Promise<void> {
  await loadLanguage(language);
  await i18n.changeLanguage(language);
}

/** The switcher's action: changes the language and saves the choice for next time. */
export async function chooseLanguage(language: Language): Promise<void> {
  await changeLanguage(language);
  saveLanguage(language);
}

/**
 * Starts in the saved or the browser's language. If its catalog cannot be fetched, the
 * page stays in English rather than staying blank.
 */
export async function startLanguage(): Promise<void> {
  try {
    await changeLanguage(detectLanguage());
  } catch {
    await i18n.changeLanguage("en");
  }
}

/** A `t` bound to one language (its catalog loaded), for code outside React and tests. */
export function fixedT(language: Language): TFunction {
  return i18n.getFixedT(language) as TFunction;
}
