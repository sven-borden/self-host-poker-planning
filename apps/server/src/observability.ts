/**
 * The opt-in services (#40, architecture section 11): Sentry for error reports from the
 * server and the page, Umami for page views. Each is off unless its variables are set, and
 * then nothing of it loads: no tag in the page, no origin in the policy, no module on the
 * server. On, this module says what the page's head carries (`observabilityTags`) and what
 * the policy allows (`observabilitySources`); the server's own reports are `sentry.ts`.
 */
import type { Config } from "./config.ts";
import type { CspSources } from "./security-headers.ts";

/** The `<meta>` that hands the page the DSN (`apps/web/src/observability/errors.ts`). */
export const SENTRY_META = "pp-sentry-dsn";

/**
 * Origins the policy adds for the services that are on: Umami's tracker and its
 * `/api/send` (the tracker's own origin), and the origin of Sentry's envelope endpoint
 * (the DSN's host).
 */
export function observabilitySources(config: Config): CspSources {
  const umami = config.umami && new URL(config.umami.scriptUrl).origin;
  const sentry = config.sentryDsn && new URL(config.sentryDsn).origin;
  const connect = [umami, sentry].filter((origin) => origin !== undefined);
  return {
    ...(umami && { "script-src": [umami] }),
    ...(connect.length > 0 && { "connect-src": connect }),
  };
}

/**
 * Tags for the page's head. Sentry: a `<meta>` with the DSN and the release, read by the
 * page, which loads its Sentry chunk only then. Umami: its tracker, `async` so that it
 * never holds the app back, with automatic tracking off: the page sends each view itself,
 * with the room code hidden (`apps/web/src/observability/page-views.ts`). It honours Do
 * Not Track.
 */
export function observabilityTags(config: Config): string[] {
  const tags: string[] = [];
  if (config.sentryDsn) {
    const release = config.gitCommit ?? config.appVersion;
    tags.push(
      `<meta name="${SENTRY_META}" content="${attribute(config.sentryDsn)}"${release ? ` data-release="${attribute(release)}"` : ""}>`,
    );
  }
  if (config.umami) {
    tags.push(
      `<script async src="${attribute(config.umami.scriptUrl)}" data-website-id="${attribute(config.umami.websiteId)}" data-auto-track="false" data-do-not-track="true"></script>`,
    );
  }
  return tags;
}

/** A value for a double-quoted HTML attribute. */
function attribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}
