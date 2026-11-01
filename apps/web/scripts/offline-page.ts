import type { Catalog } from "../src/i18n/en.ts";

export type OfflineCopy = Catalog["offline"];

/** The brand mark (`public/favicon.svg`), in the page: a file would need the network. */
const MARK = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" aria-hidden="true"><rect x="7" y="3" width="18" height="26" rx="3" fill="#A87A22" transform="rotate(6 16 16)"/><rect x="6" y="3" width="18" height="26" rx="3" fill="#1E5A53" transform="rotate(-6 16 16)"/></svg>`;

const section = (language: string, { title, body, retry }: OfflineCopy) =>
  `<section lang="${language}"><h1>${title}</h1><p>${body}</p><button type="button" data-retry>${retry}</button></section>`;

/**
 * The page a navigation gets with no network (#46, ADR-022), with every language in it: the
 * script in `src/pwa/offline.js` picks one by setting `<html lang>`. It says the same on
 * every URL, so it never shows a room's code. The copy is ours, from the catalogs, and holds
 * nothing to escape.
 */
export function offlinePage(
  copy: Readonly<Record<string, OfflineCopy>>,
  files: { script: string; style: string },
): string {
  const sections = Object.entries(copy).map(([language, text]) => section(language, text));
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta name="color-scheme" content="light dark" />
    <title>Poker Planning</title>
    <link rel="stylesheet" href="/${files.style}" />
    <script src="/${files.script}"></script>
  </head>
  <body>
    <main>${MARK}${sections.join("")}</main>
  </body>
</html>
`;
}
