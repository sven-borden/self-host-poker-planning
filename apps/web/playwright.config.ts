import { fileURLToPath } from "node:url";
import { defineConfig } from "@playwright/test";

// End-to-end checks against the built app, served by the real server with its production
// headers (#36: the Content Security Policy and the rest), not by `vite preview`: a policy
// that breaks the page must fail here before it reaches poker.borden.ch. Not part of
// `pnpm gate`; CI runs them in the `web-e2e` job. Locally they use the installed Microsoft
// Edge and build first; in CI they use Playwright's Chromium on a fresh build.
//
// The server needs a Postgres it may migrate: DATABASE_URL. E2E_WEB_PORT moves the app,
// so two worktrees can run the suite side by side. The secret is a fake.

const PORT = Number(process.env.E2E_WEB_PORT ?? 4173);
const ci = Boolean(process.env.CI);
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error(
    "The e2e suite runs against the real server: set DATABASE_URL to a Postgres it may migrate",
  );
}
const serve = "pnpm --filter @pp/server exec tsx src/main.ts";

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
  use: {
    baseURL: `http://localhost:${PORT}`,
    // The same browser language on every machine; a test that needs another says so.
    locale: "en-US",
    browserName: "chromium",
    ...(ci ? {} : { channel: "msedge" }),
    // A failed test keeps its trace in test-results/ (`pnpm exec playwright show-trace
    // <trace.zip>`); a passing one does not. The trace's screencast covers every page,
    // also those of contexts a test makes itself, which a video would miss. CI uploads
    // test-results/ only when the job fails.
    trace: "retain-on-failure",
    video: "off",
  },
  webServer: [
    {
      command: ci ? serve : `pnpm exec vite build && ${serve}`,
      url: `http://localhost:${PORT}/api/health`,
      reuseExistingServer: false,
      timeout: 120_000,
      env: {
        DATABASE_URL: databaseUrl,
        PORT: String(PORT),
        BASE_URL: `http://localhost:${PORT}`,
        BETTER_AUTH_SECRET: "e2e-fake-secret-not-used-anywhere-else-0123456789",
        STATIC_DIR: fileURLToPath(new URL("./dist", import.meta.url)),
        // The header a test sends is the client address: e2e/join.spec.ts gives each person
        // their own, to stay under the per-address room-creation and sign-in limits. A page
        // sends none, so the socket's address counts.
        TRUST_PROXY: "1",
        LOG_LEVEL: "warn",
      },
    },
  ],
});
