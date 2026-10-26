import { createContext, type ReactNode, useContext, useMemo } from "react";
import { createT, type Language, type TFunction } from "./i18n.ts";

interface I18nValue {
  language: Language;
  t: TFunction;
}

const I18nContext = createContext<I18nValue>({ language: "en", t: createT("en") });

export function I18nProvider({ language, children }: { language: Language; children: ReactNode }) {
  const value = useMemo(() => ({ language, t: createT(language) }), [language]);
  return <I18nContext value={value}>{children}</I18nContext>;
}

export function useI18n(): I18nValue {
  return useContext(I18nContext);
}

export function useT(): TFunction {
  return useContext(I18nContext).t;
}
