import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Plugin } from "vite";
import { de } from "../src/i18n/de.ts";
import { en } from "../src/i18n/en.ts";
import { fr } from "../src/i18n/fr.ts";
import { offlinePage } from "./offline-page.ts";

const read = (path: string) => readFileSync(new URL(`../src/${path}`, import.meta.url), "utf8");

/** Fills `src/pwa/service-worker.js`; one that lost a placeholder fails the build. */
export function workerSource(template: string, build: string, precache: readonly string[]) {
  const places = ['"__PP_BUILD__"', '["__PP_PRECACHE__"]'];
  if (!places.every((place) => template.includes(place))) {
    throw new Error("service-worker.js has lost a placeholder");
  }
  return template
    .replace(places[0] ?? "", JSON.stringify(build))
    .replace(places[1] ?? "", JSON.stringify(precache));
}

/**
 * The hash of everything a build's worker can store: a build that changes none of it is
 * the same worker, so a redeploy of the same files disturbs nobody.
 */
export function buildId(files: Iterable<readonly [string, string | Uint8Array]>) {
  const hash = createHash("sha256");
  for (const [name, content] of [...files].sort(([a], [b]) => (a < b ? -1 : 1))) {
    hash.update(name).update("\0").update(content).update("\0");
  }
  return hash.digest("hex").slice(0, 16);
}

/**
 * Writes the offline page and `sw.js` (#46, ADR-022) into the build. The page's script and
 * style get hashed names under `assets/`, so the worker has one rule for files; the page
 * itself and the worker keep plain names at the root, which the server revalidates. Last
 * among the plugins, so the worker's id covers the finished files.
 */
export function pwa(): Plugin {
  return {
    name: "pp:pwa",
    apply: "build",
    enforce: "post",
    generateBundle(_options, bundle) {
      const script = this.getFileName(
        this.emitFile({ type: "asset", name: "offline.js", source: read("pwa/offline.js") }),
      );
      const style = this.getFileName(
        this.emitFile({
          type: "asset",
          name: "offline.css",
          source: read("tokens.css") + read("pwa/offline.css"),
        }),
      );
      const copy = { en: en.offline, fr: fr.offline, de: de.offline };
      this.emitFile({
        type: "asset",
        fileName: "offline.html",
        source: offlinePage(copy, { script, style }),
      });
      const template = read("pwa/service-worker.js");
      const files = Object.values(bundle).map(
        (file) => [file.fileName, file.type === "chunk" ? file.code : file.source] as const,
      );
      const precache = ["/offline.html", `/${script}`, `/${style}`];
      this.emitFile({
        type: "asset",
        fileName: "sw.js",
        source: workerSource(template, buildId([...files, ["sw", template]]), precache),
      });
    },
  };
}
