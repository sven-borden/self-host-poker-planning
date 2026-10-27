import { fileURLToPath } from "node:url";
import { expect, type Page, test } from "@playwright/test";
import {
  AVATAR_HALO,
  type GeometryProblem,
  geometryProblems,
  type PixelLayout,
  type Rect,
} from "../src/table/geometry.ts";

// The table in a real browser (#13). For 1 to 16 people at widths from 360 to 1440 px, in
// both themes, the measured layout passes the same rules as the unit sweep
// (geometryProblems: 4 px around named seats, 2 px between cards, cards on the felt and
// clear of the centre), with 0.5 px for rounding. Cards keep their labels inside, the
// table survives forced colours, and cut-off names open on tap. Screenshots land in
// apps/web/tmp/screenshots/ (gitignored) for a human look.

const COUNTS = [1, 4, 8, 12, 16];
const WIDTHS = [360, 600, 641, 768, 1024, 1440];
const THEMES = ["light", "dark"] as const;
const SHOTS = fileURLToPath(new URL("../tmp/screenshots/", import.meta.url));
/** Measured layouts land on fractional pixels. */
const ROUNDING = 0.5;

interface Measured {
  layout: PixelLayout;
  /** Per seat: the avatar part as measured, and what the avatar paints (ring, badge). */
  halos: { part: Rect; paint: Rect[] }[];
}

/** Bounding boxes relative to the stage's top-left corner, as the geometry rules take them. */
async function measure(page: Page): Promise<Measured> {
  const raw = await page.evaluate(() => {
    const stage = document.querySelector("[data-stage]");
    if (!stage) {
      throw new Error("No stage on the page.");
    }
    const origin = stage.getBoundingClientRect();
    const box = (element: Element, grow = 0) => {
      const r = element.getBoundingClientRect();
      return {
        left: r.left - origin.left - grow,
        top: r.top - origin.top - grow,
        right: r.right - origin.left + grow,
        bottom: r.bottom - origin.top + grow,
      };
    };
    const only = (selector: string) => {
      const element = stage.querySelector(selector);
      if (!element) {
        throw new Error(`No ${selector} on the stage.`);
      }
      return box(element);
    };
    const seats = [...stage.querySelectorAll("[data-seat]")];
    return {
      stage: { width: origin.width, height: origin.height },
      table: only("[data-table]"),
      centre: only("[data-centre]"),
      named: stage.querySelector('[data-seat-part="name"]') !== null,
      seats: seats.map((seat) => [...seat.querySelectorAll("[data-seat-part]")].map((p) => box(p))),
      avatars: seats.map((seat) => {
        const part = seat.querySelector('[data-seat-part="avatar"]');
        const avatar = seat.querySelector("[data-avatar]");
        const badges = [...seat.querySelectorAll("[data-badge]")];
        if (!part || !avatar) {
          throw new Error("A seat without an avatar.");
        }
        // The avatar's 2 px ring (4 px with the viewer's outline), and each badge's box.
        const ring = seat.hasAttribute("data-you") ? 4 : 2;
        return { part: box(part), paint: [box(avatar, ring), ...badges.map((b) => box(b))] };
      }),
      slots: [...stage.querySelectorAll("[data-slot-card] > *")].map((slot) => box(slot)),
    };
  });
  const { avatars, ...rest } = raw;
  // A named seat's avatar part is measured with its halo, as the unit sweep measures it;
  // an initials-only seat by its 44 px target.
  const grow = (r: Rect, by: number) => ({
    left: r.left - by,
    top: r.top - by,
    right: r.right + by,
    bottom: r.bottom + by,
  });
  const seats = rest.named
    ? rest.seats.map(([avatar, ...others]) =>
        avatar ? [grow(avatar, AVATAR_HALO), ...others] : [],
      )
    : rest.seats;
  return { layout: { ...rest, seats }, halos: avatars };
}

function describeProblem(problem: GeometryProblem): string {
  return `${problem.kind} ${problem.a}${problem.b === undefined ? "" : ` ${problem.b}`}`;
}

function problems({ layout, halos }: Measured): string[] {
  const found = geometryProblems(layout, ROUNDING).map(describeProblem);
  halos.forEach(({ part, paint }, a) => {
    const room = {
      left: part.left - AVATAR_HALO - ROUNDING,
      top: part.top - AVATAR_HALO - ROUNDING,
      right: part.right + AVATAR_HALO + ROUNDING,
      bottom: part.bottom + AVATAR_HALO + ROUNDING,
    };
    const outside = paint.some(
      (r) =>
        r.left < room.left || r.top < room.top || r.right > room.right || r.bottom > room.bottom,
    );
    if (outside) {
      found.push(`avatar ${a} paints outside its halo`);
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
          expect(measured.layout.seats).toHaveLength(count);
          expect(measured.layout.slots).toHaveLength(count);
          expect(problems(measured)).toEqual([]);
          await page.screenshot({
            path: `${SHOTS}${theme}-${width}-n${count}.png`,
            fullPage: true,
          });
        });
      }
    });
  }

  // #17: the viewer, the PO, some away and some voted, from 1 to 16 people (AC 2).
  test.describe(`${theme} theme with presence`, () => {
    test.use({ colorScheme: theme });

    for (const width of [360, 1440]) {
      for (const count of [1, 2, 5, 8, 12, 16]) {
        test(`${count} people, some away and some voted, fit at ${width} px`, async ({ page }) => {
          await page.setViewportSize({ width, height: 900 });
          await open(page, `n=${count}&state=voting&observers=2&away=1`);
          const measured = await measure(page);
          expect(measured.layout.seats).toHaveLength(count);
          expect(problems(measured)).toEqual([]);
          const away = Math.floor(count / 4);
          await expect(page.locator("[data-seat][data-away]")).toHaveCount(away);
          await expect(page.locator('[data-seat] [data-badge="away"]')).toHaveCount(away);
          await expect(page.locator('[data-seat] [data-badge="owner"]')).toHaveCount(1);
          await expect(page.locator("[data-seat][data-you]")).toHaveCount(1);
          await page.screenshot({
            path: `${SHOTS}${theme}-${width}-n${count}-presence.png`,
            fullPage: true,
          });
        });
      }
    }
  });

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

test.describe("cards", () => {
  for (const width of [360, 1440]) {
    test(`corner indices sit clear above and below the number at ${width} px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await open(page, "n=4&state=voting");
      for (const label of ["13", "21", "34", "100"]) {
        const card = page.getByRole("button", { name: label, exact: true });
        const boxes = await card.evaluate((button) => {
          const rect = (element: Element | null) => {
            if (!element) {
              throw new Error("A card part is missing.");
            }
            const r = element.getBoundingClientRect();
            return { top: r.top, bottom: r.bottom };
          };
          const [top, bottom] = [...button.querySelectorAll("[data-corner] [data-card-value]")];
          return {
            top: rect(top ?? null),
            number: rect(button.querySelector(":scope > [data-card-value]")),
            bottom: rect(bottom ?? null),
          };
        });
        expect(boxes.top.bottom, `${label}: top index`).toBeLessThan(boxes.number.top);
        expect(boxes.bottom.top, `${label}: bottom index`).toBeGreaterThan(boxes.number.bottom);
      }
    });

    for (const n of [8, 16]) {
      test(`every label fits its card, one line, with ${n} people at ${width} px`, async ({
        page,
      }) => {
        await page.setViewportSize({ width, height: 900 });
        await open(page, `n=${n}&state=revealed`);
        const spills = await page.evaluate(() => {
          const cards = [
            ...document.querySelectorAll("fieldset button, [data-face='up'], [data-mini-card]"),
          ];
          return cards.flatMap((card) => {
            const c = card.getBoundingClientRect();
            return [...card.querySelectorAll("[data-card-value]")].flatMap((value) => {
              const v = value.getBoundingClientRect();
              const size = Number.parseFloat(getComputedStyle(value).fontSize);
              // Inside the 1 px border, give or take rounding, and a single line.
              const inside =
                v.left >= c.left + 0.5 &&
                v.right <= c.right - 0.5 &&
                v.top >= c.top + 0.5 &&
                v.bottom <= c.bottom - 0.5;
              const oneLine = v.height < size * 1.6;
              return inside && oneLine
                ? []
                : [`${card.getAttribute("aria-label") ?? value.textContent} spills`];
            });
          });
        });
        expect(spills).toEqual([]);
      });
    }
  }

  test("the hand and the table switch to the phone layout at the same width", async ({ page }) => {
    for (const width of [640, 641]) {
      await page.setViewportSize({ width, height: 900 });
      await open(page, "n=8&state=voting");
      const variant = await page.locator("[data-stage]").getAttribute("data-variant");
      const card = await page.getByRole("button", { name: "8", exact: true }).boundingBox();
      // The table follows its room (layout.ts), the hand the `phone:` CSS variant.
      expect(variant, `${width} px`).toBe(width === 640 ? "phone" : "desktop");
      expect(card?.width, `${width} px`).toBe(width === 640 ? 44 : 50);
    }
  });
});

test.describe("forced colours", () => {
  test.use({ forcedColors: "active", viewport: { width: 1440, height: 900 } });

  test("keep the table, played cards and the selected card visible", async ({ page }) => {
    await open(page, "n=8&state=voting");
    const styles = await page.evaluate(() => {
      const style = (selector: string, pseudo?: string) => {
        const element = document.querySelector(selector);
        if (!element) {
          throw new Error(`No ${selector}.`);
        }
        const s = getComputedStyle(element, pseudo);
        return {
          background: s.backgroundColor,
          borderWidth: s.borderTopWidth,
          borderStyle: s.borderTopStyle,
          borderColor: s.borderTopColor,
        };
      };
      return {
        page: getComputedStyle(document.body).backgroundColor,
        table: style("[data-table]"),
        down: style("[data-face='down']"),
        back: style("[data-face='down'] .pp-card-back"),
        empty: style("[data-face='empty']"),
        selected: style("fieldset button[aria-pressed='true']", "::after"),
      };
    });
    // Forced colours keep only the alpha of a background; "rgba(r, g, b, 0)" is hollow.
    const alpha = (colour: string) =>
      colour.startsWith("rgba(") ? Number(colour.slice(5, -1).split(",")[3]) : 1;
    // The table's outline.
    expect(styles.table).toMatchObject({ borderWidth: "2px", borderStyle: "solid" });
    expect(alpha(styles.table.borderColor)).toBe(1);
    // A played card: outlined and filled; an empty slot: dashed and hollow.
    expect(styles.down.borderStyle).toBe("solid");
    expect(alpha(styles.down.borderColor)).toBe(1);
    expect(styles.back.background).not.toBe(styles.page);
    expect(alpha(styles.back.background)).toBe(1);
    expect(styles.empty.borderStyle).toBe("dashed");
    expect(alpha(styles.empty.background)).toBe(0);
    // The selected card's ring.
    expect(styles.selected).toMatchObject({ borderWidth: "2px", borderStyle: "solid" });
    expect(alpha(styles.selected.borderColor)).toBe(1);
    await page.screenshot({ path: `${SHOTS}forced-1440-n8.png`, fullPage: true });
  });
});

test.describe("cut-off names", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("open the whole name and the state on tap and by keyboard", async ({ page }) => {
    await open(page, "n=16&state=voting");
    // Exactly the seats whose name does not fit are buttons.
    const seats = await page.locator("[data-seat]").evaluateAll((items) =>
      items
        .filter((item) => item.querySelector('[data-seat-part="name"]'))
        .map((item) => {
          const name = item.querySelector('[data-seat-part="name"]') as HTMLElement;
          return {
            cut: name.scrollWidth > name.clientWidth,
            button: item.querySelector("[data-seat-trigger]") !== null,
          };
        }),
    );
    expect(seats.some((seat) => seat.cut)).toBe(true);
    expect(seats.every((seat) => seat.cut === seat.button)).toBe(true);

    const seat = page.getByRole("button", { name: "Maximilian Oberhuber-Schwarz, voted" });
    await seat.click();
    await expect(page.getByRole("dialog")).toHaveText("Maximilian Oberhuber-SchwarzVoted");
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await seat.focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("dialog")).toContainText("Maximilian Oberhuber-Schwarz");
  });
});

test("the bench is not indexed", async ({ page }) => {
  await open(page, "n=4");
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", "noindex");
});
