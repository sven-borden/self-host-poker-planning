import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Paths are absolute because the root Vitest config extends this file from the repo root:
// relative paths would resolve against the current directory, not apps/web.
const src = (path: string) => fileURLToPath(new URL(`./src/${path}`, import.meta.url));

// In development the web app runs on 5173 and forwards the API and the socket to the
// server on 3000, so the browser sees a single origin, as it does in production. The
// server (#6) serves `dist/` with a history fallback, so the base stays "/".
// E2E_API_PORT moves the server for an end-to-end run beside another (playwright.config.ts).
const api = `http://localhost:${process.env.E2E_API_PORT ?? 3000}`;

export default defineConfig({
  base: "/",
  plugins: [
    // The router plugin must come before the React plugin.
    tanstackRouter({
      target: "react",
      autoCodeSplitting: true,
      routesDirectory: src("routes"),
      generatedRouteTree: src("routeTree.gen.ts"),
      quoteStyle: "double",
      semicolons: true,
    }),
    react(),
    tailwindcss(),
  ],
  build: {
    // The real budget is 200 kB of gzipped JavaScript on the room route
    // (docs/02-architecture.md, "Budgets"), enforced by scripts/check-budget.ts from the
    // manifest after every build; Vite's default warning counts raw bytes.
    chunkSizeWarningLimit: 600,
    manifest: true,
    rolldownOptions: {
      output: {
        // React, React DOM and the scheduler in one chunk of their own. Without it, once
        // the lazy settings panel (#25) shared them with the entry, Rolldown split them
        // into several small common chunks that the landing page and the room route loaded
        // too, about 1 kB more gzipped. One vendor chunk also stays cached across deploys.
        codeSplitting: {
          groups: [
            {
              name: "vendor",
              test: /node_modules[\\/]\.pnpm[\\/](react|react-dom|scheduler)@/,
              priority: 10,
            },
          ],
        },
      },
    },
  },
  resolve: {
    alias: { "@": src("") },
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": api,
      "/socket.io": { target: api, ws: true },
    },
  },
});
