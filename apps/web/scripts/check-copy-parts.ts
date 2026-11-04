// Fails the build when a word that loads with a panel (src/i18n/copy-parts.ts, U6) could show
// before that panel's part is in: a page, the table, or another panel would print the key, or
// English, instead. A key is used where its dotted name sits in a built chunk, quoted
// (`"settings.deck"`) or as the head of a key built in code (`` `exports.${column}` ``); the
// chunk must load only with its part's panel, that is from the panel's own lazy chunk or one it
// alone loads. Reads Vite's manifest and the built chunks after `vite build`, like
// check-budget.ts, under Node 24's type stripping.
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { COPY_LOADERS, COPY_PARTS, type CopyPart } from "../src/i18n/copy-parts.ts";
import { BUDGET_ROUTES, initialChunks, type Manifest } from "./check-budget.ts";

/**
 * The lazy chunks each part loads with, by source. The first is the one whose loader awaits the
 * part (`loadCopy`); the others must be loaded from those chunks alone.
 */
export const PART_ROOTS: Readonly<Record<CopyPart, readonly string[]>> = {
  settings: ["src/room/settings-panel.tsx"],
  history: ["src/room/history-panel.tsx", "src/room/exports.ts"],
  queue: [
    "src/room/queue-panel.tsx",
    "src/connectors/connector-section.tsx",
    "src/connectors/azure-section.tsx",
  ],
  sound: ["src/sound/sound-control.tsx", "src/sound/music-render.ts"],
  myRooms: ["src/routes/rooms.tsx"],
};

/** What loads before a page renders, as the budget counts it. */
export const FIRST_SCREEN = "the first screen";

const source = (key: string) => key.split("?")[0] ?? key;

/**
 * For each built file, what makes the browser fetch it: `FIRST_SCREEN` for the budget's routes,
 * else every lazy chunk (by source) that loads it, itself or through its static imports.
 */
export function loadedWith(manifest: Manifest): Map<string, Set<string>> {
  const roots = new Map<string, Set<string>>();
  const add = (key: string, root: string) => {
    const file = manifest[key]?.file ?? key;
    const known = roots.get(file) ?? new Set<string>();
    known.add(root);
    roots.set(file, known);
  };
  const first = new Set(BUDGET_ROUTES.flatMap((route) => initialChunks(manifest, route.source)));
  for (const key of first) add(key, FIRST_SCREEN);
  const lazy = new Set(Object.values(manifest).flatMap((chunk) => chunk.dynamicImports ?? []));
  for (const entry of lazy) {
    const seen = new Set<string>();
    const visit = (key: string) => {
      if (seen.has(key) || first.has(key)) return;
      seen.add(key);
      add(key, source(entry));
      for (const imported of manifest[key]?.imports ?? []) visit(imported);
    };
    visit(entry);
  }
  return roots;
}

const PLURAL = /_(zero|one|two|few|many|other)$/;

/** A part's keys, dotted, with their plural suffix taken off. */
export function partKeys(copy: object, prefix = ""): string[] {
  return [
    ...new Set(
      Object.entries(copy).flatMap(([key, value]) => {
        const dotted = prefix ? `${prefix}.${key}` : key;
        return typeof value === "object" && value !== null
          ? partKeys(value, dotted)
          : [dotted.replace(PLURAL, "")];
      }),
    ),
  ];
}

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Whether `code` names `key`, quoted or as the head of a key it builds. */
export function names(code: string, key: string): boolean {
  if (new RegExp(`[\`"']${escape(key)}[\`"']`).test(code)) return true;
  const head = key.slice(0, key.lastIndexOf(".") + 1);
  return (
    head !== "" &&
    new RegExp(`[\`"']${escape(head)}(?:\\$\\{|["']\\s*\\+|["']\\.concat)`).test(code)
  );
}

/**
 * Every way the build breaks the split, in words; empty when it holds. `parts`: each part's
 * English words; `partRoots`: the chunks each loads with.
 */
export function findings(
  manifest: Manifest,
  read: (file: string) => string,
  parts: Readonly<Record<string, object>>,
  partRoots: Readonly<Record<string, readonly string[]>> = PART_ROOTS,
): string[] {
  const found: string[] = [];
  const roots = loadedWith(manifest);
  const sources = new Set(Object.keys(manifest).map(source));
  for (const [part, copy] of Object.entries(parts)) {
    const own = partRoots[part] ?? [];
    const allowed = new Set(own);
    if (own.length === 0) found.push(`${part}: no chunk loads it.`);
    for (const root of own) {
      if (!sources.has(root)) found.push(`${part}: ${root} is not in the build any more.`);
    }
    // A chunk after the first must be loaded by the part's chunks alone.
    for (const root of own.slice(1)) {
      for (const [key, chunk] of Object.entries(manifest)) {
        if (!(chunk.dynamicImports ?? []).some((entry) => source(entry) === root)) continue;
        const outside = [...(roots.get(chunk.file) ?? [])].filter((by) => !allowed.has(by));
        if (outside.length > 0) {
          found.push(
            `${part}: ${root} is loaded by ${source(key)}, which ${outside.join(", ")} loads.`,
          );
        }
      }
    }
    const keys = partKeys(copy);
    for (const [file, by] of roots) {
      if (!file.endsWith(".js")) continue;
      const outside = [...by].filter((root) => !allowed.has(root));
      if (outside.length === 0) continue;
      const code = read(file);
      for (const key of keys) {
        if (names(code, key)) {
          found.push(`${part}: ${key} is in ${file}, which loads with ${outside.join(", ")}.`);
        }
      }
    }
  }
  return found;
}

const isMain =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  const dist = fileURLToPath(new URL("../dist", import.meta.url));
  const manifest = JSON.parse(
    readFileSync(join(dist, ".vite", "manifest.json"), "utf8"),
  ) as Manifest;
  const parts = Object.fromEntries(
    await Promise.all(COPY_PARTS.map(async (part) => [part, await COPY_LOADERS[part].en()])),
  ) as Record<CopyPart, object>;
  const problems = findings(manifest, (file) => readFileSync(join(dist, file), "utf8"), parts);
  if (problems.length > 0) {
    console.error(
      `Copy parts: ${problems.length} word(s) of a panel's part could show without it. Keep the key in the catalog (src/i18n/en.ts, fr.ts, de.ts), or load the part there (apps/web/README.md, "i18n").\n${problems.join("\n")}`,
    );
    process.exitCode = 1;
  } else {
    console.log(`Copy parts: the ${COPY_PARTS.length} panels' words load with their panels only.`);
  }
}
