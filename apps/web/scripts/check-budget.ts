// Fails the build when a route's initial JavaScript exceeds its budget, for the room route and
// the landing page: each route's own figure, under the 200 kB gzipped ceiling of
// docs/02-architecture.md ("Budgets"). Reads Vite's manifest, so it counts what the browser
// fetches before the page renders: the entry with its static imports, plus the route's split
// chunk with its own. Lazy chunks (the panels and their words, the toaster, the French and
// German catalogs) do not count. Runs after `vite build` under Node 24's type stripping, on
// Windows and Linux.
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

export interface ManifestChunk {
  file: string;
  src?: string;
  isEntry?: boolean;
  imports?: string[];
  dynamicImports?: string[];
}

export type Manifest = Record<string, ManifestChunk>;

/** The architecture's ceiling: no route's budget may pass it. */
export const CEILING_BYTES = 200_000;

/** The room route's source in the manifest (TanStack Router splits it with a query). */
export const ROOM_ROUTE = "src/routes/r/$code.tsx";
/** The landing page's source (#24): the first page most people load. */
export const LANDING_ROUTE = "src/routes/index.tsx";

/**
 * The routes the budget covers, each named as the build log prints it, with its budget: the
 * route's last measured size plus a 4 % margin, rounded up to a whole kB. The margin was chosen
 * in U6, enough for a few small changes, small enough that growth is noticed. Measured in U6: the
 * room route 185.4 kB, the landing page 163.8 kB. A PR that adds more than the margin raises its
 * route's budget here and says why, in the PR and the build log.
 */
export const BUDGET_ROUTES = [
  { name: "the room route", source: ROOM_ROUTE, budget: 193_000 },
  { name: "the landing page", source: LANDING_ROUTE, budget: 171_000 },
] as const;

/**
 * Manifest keys loaded before the route renders: every entry, the route's chunks, and
 * everything they import statically. Dynamic imports stay out.
 */
export function initialChunks(manifest: Manifest, routeSource: string): string[] {
  const roots = Object.keys(manifest).filter(
    (key) => manifest[key]?.isEntry || key.split("?")[0] === routeSource,
  );
  if (!roots.some((key) => key.split("?")[0] === routeSource)) {
    throw new Error(`The manifest has no chunk for ${routeSource}.`);
  }
  const seen = new Set<string>();
  const visit = (key: string) => {
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    for (const imported of manifest[key]?.imports ?? []) {
      visit(imported);
    }
  };
  roots.forEach(visit);
  return [...seen];
}

export function formatKb(bytes: number): string {
  return `${(bytes / 1000).toFixed(1)} kB`;
}

const isMain =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  const dist = fileURLToPath(new URL("../dist", import.meta.url));
  const manifest = JSON.parse(
    readFileSync(join(dist, ".vite", "manifest.json"), "utf8"),
  ) as Manifest;
  for (const route of BUDGET_ROUTES) {
    const files = [
      ...new Set(initialChunks(manifest, route.source).map((key) => manifest[key]?.file ?? key)),
    ].filter((file) => file.endsWith(".js"));
    const sizes = files.map((file) => ({
      file,
      gzip: gzipSync(readFileSync(join(dist, file)), { level: 9 }).length,
    }));
    const total = sizes.reduce((sum, { gzip }) => sum + gzip, 0);
    const detail = sizes.map(({ file, gzip }) => `${file} ${formatKb(gzip)}`).join(", ");
    if (total > route.budget) {
      console.error(
        `Budget: ${route.name} loads ${formatKb(total)} of JavaScript gzipped, over its ${formatKb(route.budget)} budget (${detail}).`,
      );
      process.exitCode = 1;
    } else {
      console.log(
        `Budget: ${route.name} loads ${formatKb(total)} of JavaScript gzipped, within its ${formatKb(route.budget)} (${detail}).`,
      );
    }
  }
}
