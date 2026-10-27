// Fails the build when a route's initial JavaScript exceeds its budget: 200 kB gzipped
// (docs/02-architecture.md, "Budgets"), for the room route and the landing page. Reads
// Vite's manifest, so it counts what the browser fetches before the page renders: the
// entry with its static imports, plus the route's split chunk with its own. Lazy chunks
// (Motion features, the toaster) do not count. Runs after `vite build` under Node 24's
// type stripping, on Windows and Linux.
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

export const BUDGET_BYTES = 200_000;

/** The room route's source in the manifest (TanStack Router splits it with a query). */
export const ROOM_ROUTE = "src/routes/r/$code.tsx";
/** The landing page's source (#24): the first page most people load. */
export const LANDING_ROUTE = "src/routes/index.tsx";

/** The routes the budget covers, each named as the build log prints it. */
export const BUDGET_ROUTES = [
  { name: "the room route", source: ROOM_ROUTE },
  { name: "the landing page", source: LANDING_ROUTE },
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
    if (total > BUDGET_BYTES) {
      console.error(
        `Budget: ${route.name} loads ${formatKb(total)} of JavaScript gzipped, over the ${formatKb(BUDGET_BYTES)} budget (${detail}).`,
      );
      process.exitCode = 1;
    } else {
      console.log(
        `Budget: ${route.name} loads ${formatKb(total)} of JavaScript gzipped, within ${formatKb(BUDGET_BYTES)} (${detail}).`,
      );
    }
  }
}
