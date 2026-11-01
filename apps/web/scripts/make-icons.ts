// Draws the home-screen icons (#46, ADR-022) from the brand mark in `public/favicon.svg` and
// the page's background in `src/tokens.css`, into `public/icons/`. By hand, not in the build:
// the PNGs are committed, and `scripts/pwa-files.test.ts` checks them.
//
//   node apps/web/scripts/make-icons.ts
//
// Playwright's browser draws them, so no image library joins the dependencies. The icons:
// - `icon-*`: a rounded tile, for wherever the icon shows as it is (a desktop).
// - `maskable-512`: a whole square. A launcher cuts it to its own shape and promises to keep
//   only the circle of 40 % of the side around the centre, so every corner of the mark
//   stays inside that circle.
// - `apple-touch-icon`: a whole opaque square. iOS rounds it itself and paints any
//   transparency black.
import { mkdirSync, readFileSync } from "node:fs";
import { chromium } from "@playwright/test";

const web = new URL("../", import.meta.url);

/** The mark's own rectangles, without the file's `<svg>` and `<title>`. */
const MARK = readFileSync(new URL("public/favicon.svg", web), "utf8").match(
  /<rect[\s\S]*<\/svg>/,
)?.[0];
const TILE = readFileSync(new URL("src/tokens.css", web), "utf8").match(
  /--bg:\s*(#[0-9a-f]{6})/,
)?.[1];

/** The side of the mark's 32-unit box, as a share of the icon. */
const OPEN = 0.78;
/**
 * The mark's farthest corner lies 16.4 units from the centre of its box, so this box puts
 * it at 38 % of the side: inside the 40 % circle, with a little air.
 */
const MASKED = (0.38 / 16.4) * 32;

const ICONS = [
  { file: "icon-192.png", size: 192, mark: OPEN, corner: 0.22 },
  { file: "icon-512.png", size: 512, mark: OPEN, corner: 0.22 },
  { file: "maskable-512.png", size: 512, mark: MASKED, corner: 0 },
  { file: "apple-touch-icon.png", size: 180, mark: OPEN, corner: 0 },
];

function svg(size: number, mark: number, corner: number) {
  const box = size * mark;
  const offset = (size - box) / 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" style="display:block">
    <rect width="${size}" height="${size}" rx="${size * corner}" fill="${TILE}"/>
    <svg x="${offset}" y="${offset}" width="${box}" height="${box}" viewBox="0 0 32 32">${MARK}
  </svg>`;
}

if (!MARK || !TILE) throw new Error("The mark or the background token moved.");
const folder = new URL("public/icons/", web);
mkdirSync(folder, { recursive: true });
const browser = await chromium.launch({ channel: "msedge" });
for (const { file, size, mark, corner } of ICONS) {
  const page = await browser.newPage({ viewport: { width: size, height: size } });
  await page.setContent(`<!doctype html><body style="margin:0">${svg(size, mark, corner)}`);
  await page.screenshot({ path: new URL(file, folder).pathname.slice(1), omitBackground: true });
  await page.close();
}
await browser.close();
