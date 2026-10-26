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
  },
  resolve: {
    alias: { "@": src("") },
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": "http://localhost:3000",
      "/socket.io": { target: "http://localhost:3000", ws: true },
    },
  },
});
