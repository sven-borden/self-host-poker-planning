import { configure } from "@testing-library/react";
import { COPY_PARTS } from "./i18n/copy-parts.ts";
import { loadCopyIn } from "./i18n/i18n.ts";

// Testing Library waits 1 s for a findBy* by default, which a busy machine misses (#23's
// gate failed once with the CPU at 80 to 100 %); 3 s still fails fast on a real miss.
configure({ asyncUtilTimeout: 3000 });

// Vitest setup for the web project (jsdom). jsdom has no matchMedia; the theme and the
// animations read it, so tests get one that matches nothing (light theme, motion allowed).
if (typeof window !== "undefined" && typeof window.matchMedia !== "function") {
  window.matchMedia = (query: string): MediaQueryList => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  });
}

// The panels' words in English, as if each panel had loaded its part (U6): a test that renders a
// panel by itself reads them as the page would. They are not "wanted", so a change of language
// in a test loads only what the page would (i18n.ts, `loadCopy`).
await Promise.all(COPY_PARTS.map((part) => loadCopyIn(part, "en")));
