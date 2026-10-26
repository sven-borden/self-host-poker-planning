import { fileURLToPath } from "node:url";
import { expect, type Page, test } from "@playwright/test";
import {
  type Rect,
  RIM_WIDTH,
  rectInsideStadium,
  rectsOverlap,
  rectTouchesStadium,
} from "../src/table/geometry.ts";

// The table in a real browser (#13): for 1 to 16 people at 360, 768, 1024 and 1440 px, in
// both themes, no seat overlaps another seat or the table (its real stadium shape, not
// its bounding box), and every card slot lies on the felt. Screenshots land in
// apps/web/tmp/screenshots/ (gitignored) for a human look.

const COUNTS = [1, 4, 8, 12, 16];
const WIDTHS = [360, 768, 1024, 1440];
const THEMES = ["light", "dark"] as const;
const SHOTS = fileURLToPath(new URL("../tmp/screenshots/", import.meta.url));

interface Measured {
  stage: Rect;
  table: Rect;
  seats: Rect[][];
  slots: Rect[];
}

/** Bounding boxes relative to the stage's top-left corner. */
async function measure(page: Page): Promise<Measured> {
  return page.evaluate(() => {
    const stage = document.querySelector("[data-stage]");
    if (!stage) {
      throw new Error("No stage on the page.");
    }
    const origin = stage.getBoundingClientRect();
    const box = (element: Element) => {
      const r = element.getBoundingClientRect();
      return {
        left: r.left - origin.left,
        top: r.top - origin.top,
        right: r.right - origin.left,
        bottom: r.bottom - origin.top,
      };
    };
    const table = stage.querySelector("[data-table]");
    if (!table) {
      throw new Error("No table on the stage.");
    }
    return {
      stage: box(stage),
      table: box(table),
      seats: [...stage.querySelectorAll("[data-seat]")].map((seat) =>
        [...seat.querySelectorAll("[data-seat-part]")].map(box),
      ),
      slots: [...stage.querySelectorAll("[data-slot-card] > *")].map(box),
    };
  });
}

function problems({ stage, table, seats, slots }: Measured): string[] {
  const found: string[] = [];
  seats.forEach((parts, a) => {
    seats.slice(a + 1).forEach((other, offset) => {
      if (parts.some((part) => other.some((rect) => rectsOverlap(part, rect)))) {
        found.push(`seat ${a} overlaps seat ${a + 1 + offset}`);
      }
    });
    if (parts.some((part) => rectTouchesStadium(part, table))) {
      found.push(`seat ${a} overlaps the table`);
    }
    const outside = (part: Rect) =>
      part.left < -0.5 ||
      part.top < -0.5 ||
      part.right > stage.right - stage.left + 0.5 ||
      part.bottom > stage.bottom - stage.top + 0.5;
    if (parts.some(outside)) {
      found.push(`seat ${a} leaves the stage`);
    }
  });
  slots.forEach((slot, a) => {
    slots.slice(a + 1).forEach((other, offset) => {
      if (rectsOverlap(slot, other)) {
        found.push(`slot ${a} overlaps slot ${a + 1 + offset}`);
      }
    });
    if (!rectInsideStadium(slot, table, RIM_WIDTH - 0.5)) {
      found.push(`slot ${a} is off the felt`);
    }
  });
  return found;
}

async function open(page: Page, query: string) {
  await page.goto(`/dev/table?${query}`);
  await expect(page.locator("[data-stage]")).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
}

for (const theme of THEMES) {
  for (const width of WIDTHS) {
    test.describe(`${theme} theme at ${width} px`, () => {
      test.use({ colorScheme: theme, viewport: { width, height: 900 } });

      for (const count of COUNTS) {
        test(`${count} people sit clear of each other and of the table`, async ({ page }) => {
          await open(page, `n=${count}&state=voting&observers=2`);
          const measured = await measure(page);
          expect(measured.seats).toHaveLength(count);
          expect(measured.slots).toHaveLength(count);
          expect(problems(measured)).toEqual([]);
          await page.screenshot({
            path: `${SHOTS}${theme}-${width}-n${count}.png`,
            fullPage: true,
          });
        });
      }
    });
  }

  test.describe(`${theme} theme, revealed, at device pixel ratio 2`, () => {
    test.use({ colorScheme: theme, deviceScaleFactor: 2 });

    for (const width of [360, 1440]) {
      test(`cards stay crisp at ${width} px`, async ({ page }) => {
        await page.setViewportSize({ width, height: 900 });
        await open(page, "n=8&state=revealed&observers=1");
        expect(problems(await measure(page))).toEqual([]);
        await page.screenshot({
          path: `${SHOTS}${theme}-${width}-n8-revealed-2x.png`,
          fullPage: true,
        });
      });
    }
  });
}

test("the bench is not indexed", async ({ page }) => {
  await open(page, "n=4");
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", "noindex");
});
