/**
 * Stands in for `react-style-singleton` (vite.config.ts aliases it here). Radix's scroll
 * lock (`react-remove-scroll`, under every dialog, sheet and menu) builds a style sheet at
 * run time; the original writes it into a `<style>` element, which the Content Security
 * Policy (`style-src 'self'`, #36) refuses. This one adopts a constructed style sheet
 * instead: CSSOM, which no policy blocks. Same API, same reference counting: the sheet is
 * added when the first user mounts and removed when the last one unmounts.
 *
 * A browser without constructed style sheets (Safari before 16.4, jsdom) gets no sheet:
 * the page still works, only the scroll behind an open dialog stays unlocked.
 */
import { useEffect } from "react";

/** Adopts `css` as a sheet of the document; the function returned removes it again. */
export function adoptStyles(css: string): () => void {
  if (
    typeof document === "undefined" ||
    typeof CSSStyleSheet === "undefined" ||
    !("adoptedStyleSheets" in document) ||
    typeof CSSStyleSheet.prototype.replaceSync !== "function"
  ) {
    return () => {};
  }
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(css);
  document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
  return () => {
    document.adoptedStyleSheets = document.adoptedStyleSheets.filter((s) => s !== sheet);
  };
}

export interface StyleSheetSingleton {
  add(style: string): void;
  remove(): void;
}

export const stylesheetSingleton = (): StyleSheetSingleton => {
  let counter = 0;
  let drop: (() => void) | null = null;
  return {
    add(style) {
      if (counter === 0) drop = adoptStyles(style);
      counter++;
    },
    remove() {
      counter--;
      if (counter === 0 && drop) {
        drop();
        drop = null;
      }
    },
  };
};

export const styleHookSingleton = () => {
  const sheet = stylesheetSingleton();
  return (styles: string, isDynamic?: boolean) => {
    // The original's dependency, kept as it is: a dynamic sheet follows its styles.
    // biome-ignore lint/correctness/useExhaustiveDependencies: the original library's rule
    useEffect(() => {
      sheet.add(styles);
      return () => sheet.remove();
    }, [styles && isDynamic]);
  };
};

export const styleSingleton = () => {
  const useStyle = styleHookSingleton();
  // A factory by the library's design: react-remove-scroll calls it once, at module level.
  // biome-ignore lint/correctness/noComponentHookFactories: the original library's API
  const Sheet = ({ styles, dynamic }: { styles: string; dynamic?: boolean }) => {
    useStyle(styles, dynamic);
    return null;
  };
  return Sheet;
};
