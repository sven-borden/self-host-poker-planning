import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

// Paths are absolute because the root Vitest config extends this file from the repo root:
// relative paths would resolve against the current directory, not apps/web.
const src = (path: string) => fileURLToPath(new URL(`./src/${path}`, import.meta.url));

// In development the web app runs on 5173 and forwards the API and the socket to the
// server on 3000, so the browser sees a single origin, as it does in production. The
// server (#6) serves `dist/` with a history fallback, so the base stays "/".
// E2E_API_PORT moves that server, for a second `pnpm dev` beside another.
const api = `http://localhost:${process.env.E2E_API_PORT ?? 3000}`;

/**
 * The eager vendor modules, by their folder under `node_modules/.pnpm`: React, then the
 * Radix modules under the menus and the sheet. pnpm spells a scope's slash "+" and cuts
 * long folder names short, hence the prefixes. The dialog itself (`react-dialog`) stays in
 * the lazy sheet chunk.
 */
const VENDOR = new RegExp(
  [
    String.raw`node_modules[\\/]\.pnpm[\\/](`,
    "(react|react-dom|scheduler)@",
    String.raw`|@radix-ui\+(primitive@|react-(primitive|context|presence|id|portal)@`,
    "|react-(use-layout-|use-effect-|use-control|use-callbac|dismissable|focus-scope|focus-guard))",
    "|(react-remove-scroll|react-remove-scroll-bar|use-callback-ref|use-sidecar)@",
    "|(get-nonce|react-style-singleton|aria-hidden|tslib)@",
    ")",
  ].join(""),
);

/**
 * sonner writes its style sheet into a `<style>` element when it is imported, which the
 * Content Security Policy refuses (`style-src 'self'`, #36). The call is cut from the
 * built bundle, and `components/ui/sonner.tsx` imports the same sheet from
 * `sonner/dist/styles.css` into the app's own CSS. A sonner release that writes it some
 * other way fails the build here, before the policy would block it in the browser.
 */
function sonnerStylesAsCss(): Plugin {
  return {
    name: "pp:sonner-styles-as-css",
    apply: "build",
    transform(code, id) {
      if (!/[\\/]sonner[\\/]dist[\\/]index\.mjs$/.test(id.split("?")[0] ?? "")) return null;
      const cut = code.replace(/__insertCSS\("(?:[^"\\]|\\.)*"\);?/, "");
      if (cut === code) this.error("sonner no longer calls __insertCSS: check its styles");
      return { code: cut, map: null };
    },
  };
}

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
    sonnerStylesAsCss(),
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
        // The Radix modules every page already loads (the menus' layer, focus and scroll
        // lock) go with them: once two lazy chunks used the sheet (#25, #33), Rolldown put
        // them in an eager chunk of their own, compressed apart, about 0.8 kB more.
        codeSplitting: {
          groups: [
            {
              name: "vendor",
              test: VENDOR,
              priority: 10,
            },
          ],
        },
      },
    },
  },
  resolve: {
    alias: {
      "@": src(""),
      // Radix's scroll lock builds its sheet without a <style> element (src/csp/, #36).
      "react-style-singleton": src("csp/style-singleton.ts"),
    },
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
