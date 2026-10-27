import { en } from "./en.ts";
import { formatNumber } from "./format.ts";
import { detectLanguage, type Language, localeFor, saveLanguage } from "./language.ts";

// Our own `t()` (ADR-012, amended in #9's review): about 70 lines on `Intl.PluralRules`
// instead of i18next and react-i18next, which cost 17 kB gzipped for features we never
// use. The catalogs keep i18next's JSON v4 syntax, so translation platforms read them and
// a switch back stays cheap:
// - `{{name}}` interpolates; `{{name, number}}` and `{{name, number(maximumFractionDigits:
//   1)}}` go through `formatNumber` in the reader's locale (language.ts, `localeFor`).
// - Plural keys end in `_one`, `_other`, `_many`…; `count` picks the form through
//   `Intl.PluralRules`, falling back to `_other` when the language's form is absent.
// Values are inserted as plain text: React escapes them when it renders, so nothing here
// escapes twice. English is bundled and is the fallback; French and German are chunks
// fetched on demand.

// --- Types: keys and their placeholders, checked by tsc ---------------------------------

type Messages = typeof en;
type Join<P extends string, K extends string> = P extends "" ? K : `${P}.${K}`;
type Leaves<T, P extends string = ""> = {
  [K in keyof T & string]: T[K] extends string ? Join<P, K> : Leaves<T[K], Join<P, K>>;
}[keyof T & string];
type AllLeaves = Leaves<Messages>;
type Base<K> = K extends `${infer B}_${"zero" | "one" | "two" | "few" | "many" | "other"}` ? B : K;
type IsPlural<K extends string> = `${K}_other` extends AllLeaves ? true : false;

/** Every key `t` accepts: dotted, with plural suffixes removed (`table.votedSoFar`). */
export type MessageKey = Base<AllLeaves>;

type Get<T, K extends string> = K extends `${infer H}.${infer R}`
  ? H extends keyof T
    ? Get<T[H], R>
    : never
  : K extends keyof T
    ? T[K]
    : never;
type Text<K extends string> =
  IsPlural<K> extends true ? Get<Messages, `${K}_one` | `${K}_other`> : Get<Messages, K>;
type Trim<S extends string> = S extends ` ${infer R}`
  ? Trim<R>
  : S extends `${infer R} `
    ? Trim<R>
    : S;
type Slot<I extends string> = I extends `${infer N},${string}`
  ? { name: Trim<N>; value: number }
  : { name: Trim<I>; value: string | number };
type Slots<S> = S extends `${string}{{${infer Inner}}}${infer Rest}`
  ? Slot<Inner> | Slots<Rest>
  : never;

/** The values a key needs: one per placeholder (numbers for `, number`), plus `count` for plurals. */
export type Params<K extends MessageKey> = {
  [S in Slots<Text<K>> as S["name"]]: S["value"];
} & (IsPlural<K> extends true ? { count: number } : unknown);

type Args<K extends MessageKey> = keyof Params<K> extends never
  ? [params?: undefined]
  : [params: Params<K>];

/** The typed `t`: keys are checked, and so are their `{{placeholders}}`. */
export type TFunction = <K extends MessageKey>(key: K, ...args: Args<K>) => string;

// --- Translation -------------------------------------------------------------------------

type Values = Readonly<Record<string, string | number>>;

const catalogs: Partial<Record<Language, object>> = { en };
const pluralRules = new Map<Language, Intl.PluralRules>();
const numberOptions = new Map<string, Intl.NumberFormatOptions>();
const PLACEHOLDER = /\{\{\s*([^,}]+?)\s*(?:,\s*([^}]+?)\s*)?\}\}/g;

function lookup(catalog: object | undefined, key: string): string | undefined {
  let node: unknown = catalog;
  for (const part of key.split(".")) {
    node = typeof node === "object" && node !== null ? Reflect.get(node, part) : undefined;
  }
  return typeof node === "string" ? node : undefined;
}

function message(language: Language, key: string, count: unknown): string | undefined {
  const catalog = catalogs[language];
  if (typeof count !== "number") {
    return lookup(catalog, key);
  }
  let rules = pluralRules.get(language);
  if (!rules) {
    rules = new Intl.PluralRules(language);
    pluralRules.set(language, rules);
  }
  return (
    lookup(catalog, `${key}_${rules.select(count)}`) ??
    lookup(catalog, `${key}_other`) ??
    lookup(catalog, key)
  );
}

/** `number` or `number(maximumFractionDigits: 1; useGrouping: false)`, parsed once per spelling. */
function parseNumberFormat(format: string): Intl.NumberFormatOptions | undefined {
  let options = numberOptions.get(format);
  if (!options) {
    const match = /^number(?:\((.*)\))?$/.exec(format);
    if (!match) {
      return undefined;
    }
    const parsed: Record<string, string | number | boolean> = {};
    for (const pair of (match[1] ?? "").split(";")) {
      const [name, raw] = pair.split(":").map((part) => part.trim());
      if (name && raw !== undefined) {
        parsed[name] =
          raw === "true"
            ? true
            : raw === "false"
              ? false
              : Number.isNaN(Number(raw))
                ? raw
                : Number(raw);
      }
    }
    options = parsed as Intl.NumberFormatOptions;
    numberOptions.set(format, options);
  }
  return options;
}

function translate(language: Language, key: string, values: Values | undefined): string {
  const text = message(language, key, values?.count) ?? message("en", key, values?.count) ?? key;
  if (!values) {
    return text;
  }
  return text.replace(PLACEHOLDER, (whole, name: string, format: string | undefined) => {
    const value = values[name];
    if (value === undefined) {
      return whole;
    }
    const options = format === undefined ? undefined : parseNumberFormat(format);
    return typeof value === "number" && options
      ? formatNumber(value, localeFor(language), options)
      : String(value);
  });
}

const bound = new Map<Language, TFunction>();

/** A `t` bound to one language (English where its catalog is not loaded yet). */
export function fixedT(language: Language): TFunction {
  let t = bound.get(language);
  if (!t) {
    t = ((key: string, values?: Values) => translate(language, key, values)) as TFunction;
    bound.set(language, t);
  }
  return t;
}

/** The language a `t` from `fixedT` speaks: lists in a sentence join the way it does. */
export function languageOf(t: TFunction): Language {
  for (const [language, known] of bound) {
    if (known === t) return language;
  }
  return current;
}

// --- The current language ----------------------------------------------------------------

let current: Language = "en";
let latestPick = 0;
const listeners = new Set<() => void>();

/** The language the app speaks now. */
export function currentLanguage(): Language {
  return current;
}

/** For `useSyncExternalStore`: calls `listener` after every language change. */
export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const LOADERS: Record<Exclude<Language, "en">, () => Promise<object>> = {
  fr: () => import("./fr.ts").then((module) => module.fr),
  de: () => import("./de.ts").then((module) => module.de),
};

const loading = new Map<Language, Promise<void>>();

/** Fetches a language's catalog once; English is always there. */
export function loadLanguage(language: Language): Promise<void> {
  if (catalogs[language]) {
    return Promise.resolve();
  }
  let pending = loading.get(language);
  if (!pending) {
    pending = LOADERS[language as Exclude<Language, "en">]().then(
      (catalog) => {
        catalogs[language] = catalog;
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

/**
 * Speaks `language` from now on, once its catalog is in: every mounted `useT` re-renders
 * and `<html lang>` follows. Only the latest request wins: if another language was asked
 * for while this catalog loaded, nothing changes and the result is false.
 */
export async function changeLanguage(language: Language): Promise<boolean> {
  const pick = ++latestPick;
  try {
    await loadLanguage(language);
  } catch (error) {
    // A pick the reader has already moved on from fails quietly.
    if (pick !== latestPick) {
      return false;
    }
    throw error;
  }
  if (pick !== latestPick) {
    return false;
  }
  if (typeof document !== "undefined") {
    document.documentElement.lang = language;
  }
  if (language !== current) {
    current = language;
    for (const listener of listeners) {
      listener();
    }
  }
  return true;
}

/** The switcher's action: changes the language and saves it, unless a later pick won. */
export async function chooseLanguage(language: Language): Promise<void> {
  if (await changeLanguage(language)) {
    saveLanguage(language);
  }
}

/** How long the first render waits for a French or German catalog before showing English. */
export const START_TIMEOUT_MS = 3000;

/**
 * Starts in the saved or the browser's language. Never rejects, and settles within
 * `timeoutMs`: a failed catalog leaves the page in English, and a slow one lets it render
 * in English first and switch when the catalog lands (unless the reader picked a
 * language meanwhile).
 */
export function startLanguage(timeoutMs = START_TIMEOUT_MS): Promise<void> {
  const change = changeLanguage(detectLanguage()).then(
    () => {},
    () => {},
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, timeoutMs);
  });
  return Promise.race([change, timeout]).finally(() => clearTimeout(timer));
}
