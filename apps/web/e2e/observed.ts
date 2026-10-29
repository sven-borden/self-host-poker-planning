// The second server of the e2e run (#40): the same app and database with Sentry and Umami
// on, for e2e/observability.spec.ts. Their services "live" at SERVICES_ORIGIN, where
// nothing listens: the spec answers for them through Playwright's routing, so nothing
// leaves the machine. Shared by playwright.config.ts and the spec.

const PORT = Number(process.env.E2E_WEB_PORT ?? 4173);

/** The port of the server with the services on; the first server keeps E2E_WEB_PORT. */
export const OBSERVED_PORT = PORT + 1;
export const OBSERVED_BASE = `http://localhost:${OBSERVED_PORT}`;

/** Where Umami and Sentry are, for that server. Another origin than the app's. */
export const SERVICES_ORIGIN = `http://127.0.0.1:${PORT + 2}`;
export const UMAMI_WEBSITE_ID = "6639e935-21ce-47c9-89d2-da5d28b7dc15";
export const SENTRY_KEY = "0123abcd";
export const SENTRY_PROJECT = "42";
export const RELEASE = "e2e0040";

/** The variables that turn the services on. */
export const OBSERVED_ENV = {
  SENTRY_DSN: `http://${SENTRY_KEY}@127.0.0.1:${PORT + 2}/${SENTRY_PROJECT}`,
  UMAMI_URL: SERVICES_ORIGIN,
  UMAMI_WEBSITE_ID,
  GIT_COMMIT: RELEASE,
};
