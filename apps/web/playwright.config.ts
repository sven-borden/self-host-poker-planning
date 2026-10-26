import { defineConfig } from "@playwright/test";

// End-to-end checks against the built app served by `vite preview` (not part of
// `pnpm gate`; CI runs them in the `web-e2e` job). Locally they use the installed
// Microsoft Edge and build first; in CI they use Playwright's Chromium on a fresh build.

const PORT = 4173;
const ci = Boolean(process.env.CI);
const preview = `pnpm exec vite preview --port ${PORT} --strictPort`;

export default defineConfig({
  testDir: "./e2e",
  outputDir: "./test-results",
  fullyParallel: true,
  forbidOnly: ci,
  // One retry: Edge occasionally refuses a screenshot under parallel load.
  retries: 1,
  workers: ci ? 2 : undefined,
  reporter: ci ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: `http://localhost:${PORT}`,
    browserName: "chromium",
    ...(ci ? {} : { channel: "msedge" }),
  },
  webServer: {
    command: ci ? preview : `pnpm exec vite build && ${preview}`,
    url: `http://localhost:${PORT}/dev/table`,
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
