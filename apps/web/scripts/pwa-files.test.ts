import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { de } from "../src/i18n/de.ts";
import { en } from "../src/i18n/en.ts";
import { fr } from "../src/i18n/fr.ts";
import { offlinePage } from "./offline-page.ts";
import { buildId, pwa, workerSource } from "./pwa-plugin.ts";

// The files that make the app installable (#46): their values against their sources. How the
// icons look was judged by eye (PR #46's note); `make-icons.ts` draws them again.

const file = (path: string) => join(import.meta.dirname, "..", path);
const text = (path: string) => readFileSync(file(path), "utf8");

const html = text("index.html");
const tokens = text("src/tokens.css");
const manifest = JSON.parse(text("public/manifest.webmanifest")) as {
  name: string;
  short_name: string;
  start_url: string;
  scope: string;
  display: string;
  theme_color: string;
  background_color: string;
  icons: { src: string; sizes: string; type: string; purpose: string }[];
};

const lightBg = /--bg:\s*(#[0-9a-f]{6})/.exec(tokens)?.[1];
const darkBg = /--bg:\s*(#[0-9a-f]{6})/.exec(
  tokens.slice(tokens.indexOf("prefers-color-scheme: dark")),
)?.[1];

/** The size in a PNG's header, after its 8-byte signature and the chunk's length and type. */
function pngSize(path: string) {
  const png = readFileSync(file(`public${path}`));
  expect(png.subarray(1, 4).toString()).toBe("PNG");
  return `${png.readUInt32BE(16)}x${png.readUInt32BE(20)}`;
}

describe("the manifest", () => {
  it("stands alone from the site's root under the product's name", () => {
    expect(manifest).toMatchObject({
      name: "Poker Planning",
      start_url: "/",
      scope: "/",
      display: "standalone",
    });
    expect(manifest.short_name.length).toBeLessThanOrEqual(12);
  });

  it("takes its colours from the tokens", () => {
    expect(lightBg).toBeDefined();
    expect(manifest.theme_color).toBe(lightBg);
    expect(manifest.background_color).toBe(lightBg);
  });

  it("has every icon a phone asks for, each the size it claims", () => {
    expect(manifest.icons.map(({ sizes, purpose }) => `${sizes} ${purpose}`).sort()).toEqual([
      "192x192 any",
      "512x512 any",
      "512x512 maskable",
    ]);
    for (const { src, sizes, type } of manifest.icons) {
      expect(type).toBe("image/png");
      expect(pngSize(src)).toBe(sizes);
    }
  });
});

describe("index.html", () => {
  it("links the manifest and the icon iOS reads, at 180 px", () => {
    expect(html).toContain('<link rel="manifest" href="/manifest.webmanifest" />');
    expect(html).toContain('<link rel="apple-touch-icon" href="/icons/apple-touch-icon.png" />');
    expect(pngSize("/icons/apple-touch-icon.png")).toBe("180x180");
  });

  it("has a theme colour per scheme, from the tokens, before the theme's script", () => {
    expect(darkBg).toBeDefined();
    for (const [scheme, colour] of [
      ["light", lightBg],
      ["dark", darkBg],
    ]) {
      expect(html).toContain(
        `<meta name="theme-color" data-scheme="${scheme}" media="(prefers-color-scheme: ${scheme})" content="${colour}" />`,
      );
    }
    expect(html.lastIndexOf('<meta name="theme-color"')).toBeLessThan(
      html.indexOf('<script src="/theme-init.js"'),
    );
  });
});

describe("the offline page", () => {
  const copy = { en: en.offline, fr: fr.offline, de: de.offline };
  const page = offlinePage(copy, { script: "assets/o.js", style: "assets/o.css" });

  it("holds every language", () => {
    for (const [language, { title, body, retry }] of Object.entries(copy)) {
      expect(page).toContain(`<section lang="${language}">`);
      for (const text of [title, body, retry]) expect(page).toContain(text);
    }
  });

  it("is plain enough for the policy: nothing inline", () => {
    expect(page).toContain('<script src="/assets/o.js"></script>');
    expect(page).toContain('<link rel="stylesheet" href="/assets/o.css" />');
    expect(page).not.toMatch(/<style|\sstyle=|\son[a-z]+=|<script>/);
  });

  it("draws the brand mark as the favicon does", () => {
    for (const rect of text("public/favicon.svg").match(/<rect[^>]*>/g) ?? [])
      expect(page).toContain(rect);
  });
});

describe("the build", () => {
  it("is the same worker for the same files, a new one for any other", () => {
    const files = [
      ["a.js", "one"],
      ["b.css", new Uint8Array([1, 2])],
    ] as const;
    expect(buildId(files)).toBe(buildId([...files].reverse()));
    expect(buildId(files)).not.toBe(buildId([["a.js", "two"], files[1]]));
    expect(buildId([["ab", "c"]])).not.toBe(buildId([["a", "bc"]]));
  });

  it("covers the offline files, which Vite does not put in the bundle", async () => {
    // A stand-in for the build: emitted files get a content-hashed name and stay out of
    // `bundle`, as under Vite 8.
    async function worker(changed: { source?: Record<string, string>; page?: string } = {}) {
      const emitted = new Map<string, string>();
      const context = {
        emitFile(file: { name?: string; fileName?: string; source: string }) {
          const name = file.fileName ?? `assets/${file.name}-${buildId([["x", file.source]])}`;
          emitted.set(name, file.source);
          return name;
        },
        getFileName: (name: string) => name,
      };
      const read = (path: string) => changed.source?.[path] ?? text(`src/${path}`);
      const page = (...args: Parameters<typeof offlinePage>) =>
        offlinePage(...args) + (changed.page ?? "");
      const bundle = {
        "assets/index-1.js": { type: "chunk", fileName: "assets/index-1.js", code: "x" },
      };
      const { generateBundle } = pwa(read, page);
      await (generateBundle as (...args: unknown[]) => unknown).call(context, {}, bundle);
      return emitted.get("sw.js");
    }
    const same = await worker();
    expect(same).toBeDefined();
    expect(await worker()).toBe(same);
    // The page's template alone: its file name does not change, so only the hash can tell.
    expect(await worker({ page: "<!-- changed -->" })).not.toBe(same);
    expect(await worker({ source: { "pwa/offline.js": "// changed" } })).not.toBe(same);
    expect(await worker({ source: { "pwa/offline.css": "/* changed */" } })).not.toBe(same);
  });

  it("refuses a worker that lost a placeholder", () => {
    expect(() => workerSource("const BUILD = 1;", "x", [])).toThrow("placeholder");
  });

  it("runs at build time only", () => {
    expect(pwa().apply).toBe("build");
  });
});
