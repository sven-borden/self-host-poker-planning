import { fileURLToPath } from "node:url";
import { defineConfig } from "@playwright/test";
import { OBSERVED_ENV, OBSERVED_PORT } from "./e2e/observed.ts";
import { SIGN_IN_ENV, SIGN_IN_PORT } from "./e2e/signed-in.ts";

// End-to-end checks against the built app, served by the real server with its production
// headers (#36: the Content Security Policy and the rest), not by `vite preview`: a policy
// that breaks the page must fail here before it reaches poker.borden.ch. Not part of
// `pnpm gate`; CI runs them in the `web-e2e` job. Locally they use the installed Microsoft
// Edge and build first; in CI they use Playwright's Chromium on a fresh build. The `webkit`
// project uses Playwright's WebKit (`pnpm --filter @pp/web exec playwright install webkit`
// once): without it a full local run fails `webkit` and then skips `performance`, which
// depends on it.
//
// The server needs a Postgres it may migrate: DATABASE_URL. E2E_WEB_PORT moves the app,
// so two worktrees can run the suite side by side. The secret is a fake. A second server,
// on the next port, has Sentry and Umami on (#40, e2e/observed.ts); it starts once the
// first is up, so locally it serves the fresh build too. A third, on the next free port, has
// provider keys and a stand-in for the providers in its own process (#47, e2e/signed-in.ts), and
// Jira's keys, the vault and a stand-in for Atlassian beside it (#54), and one for Azure DevOps (#55).

const PORT = Number(process.env.E2E_WEB_PORT ?? 4173);
const ci = Boolean(process.env.CI);
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error(
    "The e2e suite runs against the real server: set DATABASE_URL to a Postgres it may migrate",
  );
}
// Chromium for every project but WebKit's: Edge locally, Playwright's Chromium in CI. A
// project cannot unset a `channel` from the shared `use`, so each project names its browser.
const chromium = { browserName: "chromium", ...(ci ? {} : { channel: "msedge" }) } as const;
const serve = "pnpm --filter @pp/server exec tsx src/main.ts";
const serveWithFakeProviders =
  "pnpm --filter @pp/server exec tsx --import ./src/fake-oidc-start.ts --import ./src/fake-jira-start.ts --import ./src/fake-azure-devops-start.ts src/main.ts";
const env = {
  DATABASE_URL: databaseUrl,
  PORT: String(PORT),
  BASE_URL: `http://localhost:${PORT}`,
  BETTER_AUTH_SECRET: "e2e-fake-secret-not-used-anywhere-else-0123456789",
  STATIC_DIR: fileURLToPath(new URL("./dist", import.meta.url)),
  // The header a test sends is the client address: each test's default context gets its own
  // (e2e/fixtures.ts), and `newPerson` one per person (e2e/support.ts), to stay under the
  // per-address room-creation and sign-in limits. A context the test makes without its own
  // header inherits the test's address (Playwright applies `use` options, `extraHTTPHeaders`
  // included, to every `browser.newContext()` in a test); `newPerson`, `phone` or `ownAddress()`
  // give it one of its own.
  TRUST_PROXY: "1",
  LOG_LEVEL: "warn",
};

export default defineConfig({
  testDir: "./e2e",
  outputDir: "./test-results",
  fullyParallel: true,
  forbidOnly: ci,
  // One retry in CI, for a screenshot the browser refuses under parallel load; locally a
  // failure shows at once.
  retries: ci ? 1 : 0,
  workers: ci ? 2 : undefined,
  reporter: ci ? [["list"], ["html", { open: "never" }]] : "list",
  projects: [
    { name: "e2e", testIgnore: [/reveal-performance/, /webkit\.spec/], use: chromium },
    // The app in Playwright's WebKit (U3): the table's bench and one round, desktop and
    // iPhone, beside the e2e project, in CI too. `pnpm exec playwright install webkit` once;
    // `--project=webkit` runs it alone.
    {
      name: "webkit",
      testMatch: /webkit\.spec/,
      use: { browserName: "webkit" },
    },
    // Long tasks mean nothing on a machine busy with other tests: this one runs alone,
    // after them (#43). The worst task sits a little under 50 ms, so a stray 51 from the
    // system is one more try; a real regression fails all three. `--no-deps` runs it alone.
    {
      name: "performance",
      testMatch: /reveal-performance/,
      dependencies: ["e2e", "webkit"],
      fullyParallel: false,
      workers: 1,
      retries: 2,
      use: chromium,
    },
  ],
  use: {
    baseURL: `http://localhost:${PORT}`,
    // The same browser language on every machine; a test that needs another says so.
    locale: "en-US",
    // A failed test keeps its trace in test-results/ (`pnpm exec playwright show-trace
    // <trace.zip>`); a passing one does not. The trace's screencast covers every page,
    // also those of contexts a test makes itself, which a video would miss. CI uploads
    // test-results/ only when the job fails.
    trace: "retain-on-failure",
    video: "off",
    // A page under the service worker (#46) hides its files from `page.route`, on which many
    // specs fail a chunk on purpose. e2e/pwa.spec.ts turns it on and plays a round with it.
    serviceWorkers: "block",
  },
  webServer: [
    {
      command: ci ? serve : `pnpm exec vite build && ${serve}`,
      url: `http://localhost:${PORT}/api/health`,
      reuseExistingServer: false,
      timeout: 120_000,
      env,
    },
    {
      command: serve,
      url: `http://localhost:${OBSERVED_PORT}/api/health`,
      reuseExistingServer: false,
      timeout: 120_000,
      env: {
        ...env,
        PORT: String(OBSERVED_PORT),
        BASE_URL: `http://localhost:${OBSERVED_PORT}`,
        ...OBSERVED_ENV,
      },
    },
    {
      command: serveWithFakeProviders,
      url: `http://localhost:${SIGN_IN_PORT}/api/health`,
      reuseExistingServer: false,
      timeout: 120_000,
      env: {
        ...env,
        PORT: String(SIGN_IN_PORT),
        BASE_URL: `http://localhost:${SIGN_IN_PORT}`,
        ...SIGN_IN_ENV,
      },
    },
  ],
});
