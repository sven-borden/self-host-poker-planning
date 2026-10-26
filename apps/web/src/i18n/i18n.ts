import { de } from "./de.ts";
import { en, type Messages } from "./en.ts";
import { fr } from "./fr.ts";

// A minimal stand-in for react-i18next: same catalogs, same dotted keys, same `{{var}}`
// interpolation. #9 replaces this module and keeps the catalogs.

export const LANGUAGES = ["en", "fr", "de"] as const;
export type Language = (typeof LANGUAGES)[number];

export const catalogs: Record<Language, Messages> = { en, fr, de };

type Leaves<T, Prefix extends string = ""> = {
  [K in keyof T & string]: T[K] extends string ? `${Prefix}${K}` : Leaves<T[K], `${Prefix}${K}.`>;
}[keyof T & string];

/** Every translatable key, such as "home.createRoom". */
export type MessageKey = Leaves<Messages>;

export type TFunction = (key: MessageKey, values?: Record<string, string | number>) => string;

/** The first supported language among the browser's preferences, English otherwise. */
export function pickLanguage(preferences: readonly string[]): Language {
  for (const tag of preferences) {
    const primary = tag.toLowerCase().split("-")[0];
    const match = LANGUAGES.find((language) => language === primary);
    if (match) {
      return match;
    }
  }
  return "en";
}

export function detectLanguage(): Language {
  if (typeof navigator === "undefined") {
    return "en";
  }
  return pickLanguage(navigator.languages?.length ? navigator.languages : [navigator.language]);
}

function lookup(messages: Messages, key: string): string | undefined {
  let node: unknown = messages;
  for (const part of key.split(".")) {
    if (typeof node !== "object" || node === null) {
      return undefined;
    }
    node = (node as Record<string, unknown>)[part];
  }
  return typeof node === "string" ? node : undefined;
}

export function createT(language: Language): TFunction {
  return (key, values) => {
    const template = lookup(catalogs[language], key) ?? lookup(en, key) ?? key;
    if (!values) {
      return template;
    }
    return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (whole, name: string) =>
      name in values ? String(values[name]) : whole,
    );
  };
}
