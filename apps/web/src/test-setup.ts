import { configure } from "@testing-library/react";

// Testing Library waits 1 s for a findBy* by default, which a busy machine misses (#23's
// gate failed once with the CPU at 80 to 100 %); 3 s still fails fast on a real miss.
configure({ asyncUtilTimeout: 3000 });

// Vitest setup for the web project (jsdom). jsdom has no matchMedia; Motion and the theme
// read it, so tests get one that matches nothing (light theme, motion allowed).
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
