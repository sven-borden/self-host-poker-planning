/**
 * Error reports to Sentry (#40), only when the server put a DSN in the page
 * (`<meta name="pp-sentry-dsn">`, `observabilityTags` in apps/server/src/observability.ts);
 * otherwise nothing loads. Sentry's SDK is a chunk of its own (`sentry.ts`), fetched then,
 * after the first render's code: it reports uncaught errors, unhandled rejections and
 * what `reportError` gets, the errors a page's error boundary caught (the router's
 * `defaultOnCatch`). Errors before the chunk is there wait for it, a few at most.
 */

let report: ((error: unknown) => void) | undefined;
let waiting: unknown[] | undefined;

/** Errors kept while the chunk loads. */
const WAITING_MAX = 10;

/** Loads Sentry when the page carries a DSN. Call once, at start. */
export function startErrorReports(doc: Document = document): void {
  const meta = doc.querySelector<HTMLMetaElement>('meta[name="pp-sentry-dsn"]');
  const dsn = meta?.content;
  if (!dsn) return;
  waiting = [];
  import("./sentry.ts").then(
    ({ startSentry }) => {
      report = startSentry({ dsn, release: meta.dataset.release });
      for (const error of waiting?.splice(0) ?? []) report(error);
    },
    () => {
      // The chunk did not load (a deploy replaced it, a blocker): no reports, no error.
      waiting = undefined;
    },
  );
}

/** Reports an error a boundary caught; nothing when reports are off. */
export function reportError(error: unknown): void {
  if (report) report(error);
  else if (waiting && waiting.length < WAITING_MAX) waiting.push(error);
}
