import { CENTRE_GAP } from "../src/table/geometry.ts";
import { expect, type Page, test } from "./fixtures.ts";
import { createRoom, type Guest, guestsJoin, join, phone, SHOTS } from "./support.ts";

// Larger text on phones (#37, WCAG 1.4.4): at 150 % text the centre of the table stays
// clear of the slot cards around it, and "Karten aufdecken" stays on one line. The centre
// is sized in px, as the layout places the table in px: a text setting enlarges the page
// around the table, browser zoom the table too.

/** The smallest gap between what the table's centre draws and the slot cards, in px. */
function centreClearance(page: Page) {
  return page.evaluate(() => {
    const centre = document.querySelector("[data-centre]");
    if (!centre) throw new Error("no centre");
    // What the centre draws: its buttons, its icons and its words (their lines, not the
    // paragraph's box), not the boxes they are stacked in, nor the centre's own box,
    // which taller content overflows.
    const range = document.createRange();
    const drawn = [...centre.querySelectorAll("*")]
      .filter((element) => element.tagName === "BUTTON" || element.children.length === 0)
      // Clipped to 1 px (screen-reader text): its words' rectangles would still be laid out.
      .filter((element) => element.getBoundingClientRect().width > 1)
      .flatMap((element) => {
        if (element.tagName === "BUTTON" || !element.textContent?.trim()) {
          return [element.getBoundingClientRect()];
        }
        range.selectNodeContents(element);
        return [...range.getClientRects()];
      })
      .filter((r) => r.width > 1 && r.height > 1);
    const slots = [...document.querySelectorAll("[data-slot-card]")].map((slot) =>
      slot.getBoundingClientRect(),
    );
    let gap = Number.POSITIVE_INFINITY;
    for (const a of drawn) {
      for (const b of slots) {
        const dx = Math.max(b.left - a.right, a.left - b.right, 0);
        const dy = Math.max(b.top - a.bottom, a.top - b.bottom, 0);
        gap = Math.min(gap, Math.hypot(dx, dy));
      }
    }
    return gap;
  });
}

/** The lines the words of `selector` sit on. */
function linesOf(page: Page, selector: string) {
  return page.locator(selector).evaluate((element) => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    const middles: number[] = [];
    const range = document.createRange();
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (!node.textContent?.trim()) continue;
      range.selectNodeContents(node);
      for (const r of range.getClientRects()) {
        if (r.width > 1) middles.push(r.top + r.height / 2);
      }
    }
    middles.sort((a, b) => a - b);
    return middles.filter((m, i) => i === 0 || m - (middles[i - 1] ?? m) > 4).length;
  });
}

async function textSize(page: Page, percent: 100 | 150) {
  // Through the CSSOM: the policy refuses an inline style element (#36).
  await page.evaluate((size) => {
    document.documentElement.style.fontSize = size === 100 ? "" : `${size}%`;
  }, percent);
  await page.waitForTimeout(200);
}

async function inLanguage(page: Page, language: "en" | "fr" | "de") {
  await page.evaluate((code) => localStorage.setItem("pp-language", code), language);
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("lang", language);
  await expect(page.getByTestId("room-connection")).not.toBeEmpty();
}

/**
 * The brief promises a clean table from 360 px (`layout.test.ts` proves rooms from
 * 328 px); 320 px is checked for reflow only (`reflow.spec.ts`).
 */
const WIDTHS = [390, 360] as const;

test("at 150 % text the centre stays clear of 7 slot cards, voting and revealed, at 360 and 390 px", async ({
  browser,
  baseURL,
}) => {
  test.setTimeout(180_000);
  const po = await phone(browser, { width: 390, height: 844 });
  const ben = await phone(browser, { width: 390, height: 844 });
  let guests: Guest[] = [];
  try {
    const code = await createRoom(po.page);
    await join(po.page, "Ana");
    await ben.page.goto(po.page.url());
    await join(ben.page, "Ben");
    guests = await guestsJoin(baseURL ?? "", code, ["Cleo", "Dan", "Eve", "Finn", "Gus"]);
    await po.page.getByRole("button", { name: "Start voting" }).tap();
    for (const phase of ["voting", "revealed"] as const) {
      if (phase === "revealed") {
        for (const [i, guest] of guests.entries()) {
          const card = ["3", "5", "8", "5", "13"][i];
          expect(await guest.cmd("castVote", { card, round: 1, restart: 0 })).toMatchObject({
            ok: true,
          });
        }
        await po.page.locator("[data-reveal]").tap();
        await expect(po.page.locator("[data-centre-result]")).toBeVisible();
      }
      for (const [who, page] of [
        ["PO", po.page],
        ["voter", ben.page],
      ] as const) {
        for (const language of ["en", "fr", "de"] as const) {
          await inLanguage(page, language);
          await expect(page.locator("[data-slot-card]")).toHaveCount(7);
          for (const width of WIDTHS) {
            await page.setViewportSize({ width, height: 844 });
            for (const size of [100, 150] as const) {
              await textSize(page, size);
              const where = `${phase}, ${who}, ${language}, ${width} px, ${size} % text`;
              expect.soft(await centreClearance(page), where).toBeGreaterThanOrEqual(CENTRE_GAP);
            }
            await textSize(page, 100);
          }
          if (language === "de") {
            await page.setViewportSize({ width: 390, height: 844 });
            await textSize(page, 150);
            await page.locator("[data-stage]").screenshot({
              path: `${SHOTS}text150-centre-7-${phase}-${who}-de.png`,
            });
            await textSize(page, 100);
          }
        }
      }
    }
  } finally {
    for (const guest of guests) guest.close();
    await po.context.close();
    await ben.context.close();
  }
});

test('at 150 % text "Karten aufdecken" stays on one line and clear of 11 and 16 slot cards, at 360 and 390 px', async ({
  browser,
  baseURL,
}) => {
  test.setTimeout(180_000);
  const po = await phone(browser, { width: 360, height: 780 });
  const guests: Guest[] = [];
  try {
    const code = await createRoom(po.page);
    await join(po.page, "Ana");
    await po.page.getByRole("button", { name: "Start voting" }).tap();
    // 11 people: the smallest dense phone table, where the label first keeps one line.
    for (const count of [11, 16]) {
      const names = Array.from(
        { length: count - 1 - guests.length },
        (_, i) => `P${guests.length + i + 2}`,
      );
      guests.push(...(await guestsJoin(baseURL ?? "", code, names)));
      for (const language of ["de", "fr", "en"] as const) {
        await inLanguage(po.page, language);
        await expect(po.page.locator("[data-slot-card]")).toHaveCount(count);
        for (const width of WIDTHS) {
          await po.page.setViewportSize({ width, height: 780 });
          for (const size of [100, 150] as const) {
            await textSize(po.page, size);
            const where = `${count} people, ${language}, ${width} px, ${size} % text`;
            expect.soft(await linesOf(po.page, "[data-reveal]"), `${where}: lines`).toBe(1);
            expect.soft(await centreClearance(po.page), where).toBeGreaterThanOrEqual(CENTRE_GAP);
          }
          await textSize(po.page, 100);
        }
      }
    }
    await inLanguage(po.page, "de");
    await po.page.setViewportSize({ width: 360, height: 780 });
    await textSize(po.page, 150);
    await po.page.locator("[data-stage]").screenshot({ path: `${SHOTS}text150-reveal-16-de.png` });
  } finally {
    for (const guest of guests) guest.close();
    await po.context.close();
  }
});
