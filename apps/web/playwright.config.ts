import { defineConfig } from "@playwright/test";

// End-to-end checks against the built app served by `vite preview` (not part of
// `pnpm gate`; CI runs them in the `web-e2e` job). Locally they use the installed
// Microsoft Edge and build first; in CI they use Playwright's Chromium on a fresh build.

const PORT = 4173;
const ci = Boolean(process.env.CI);
const preview = `pnpm exec vite preview --port ${PORT} --strictPort`;

// With DATABASE_URL (a Postgres the server may migrate), the real server runs on 3000,
// where `vite preview` forwards `/api` and `/socket.io`, as `pnpm dev` does: the identity
// tests (e2e/identity.spec.ts) need it and skip without it. The secret is a fake.
const databaseUrl = process.env.DATABASE_URL;
const apiServer = databaseUrl
  ? [
      {
        command: "pnpm --filter @pp/server exec tsx src/main.ts",
        url: "http://localhost:3000/api/health",
        reuseExistingServer: false,
        timeout: 60_000,
        env: {
          DATABASE_URL: databaseUrl,
          PORT: "3000",
          BASE_URL: `http://localhost:${PORT}`,
          BETTER_AUTH_SECRET: "e2e-fake-secret-not-used-anywhere-else-0123456789",
          // `vite preview` forwards without adding X-Forwarded-For, so the header a test
          // sends is the client address: e2e/join.spec.ts gives each person their own, to
          // stay under the per-address room-creation and sign-in limits. Without the
          // header the socket's address counts, as before.
          TRUST_PROXY: "1",
          LOG_LEVEL: "warn",
        },
      },
    ]
  : [];

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
  },
  webServer: [
    {
      command: ci ? preview : `pnpm exec vite build && ${preview}`,
      url: `http://localhost:${PORT}/dev/table`,
      reuseExistingServer: false,
      timeout: 120_000,
    },
    ...apiServer,
  ],
});
