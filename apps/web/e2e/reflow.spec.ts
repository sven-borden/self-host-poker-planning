import type { Page } from "@playwright/test";
import { settle } from "./a11y.ts";
import { expect, test } from "./fixtures.ts";
import { createRoom, type Guest, guestsJoin, handCard, join, SHOTS } from "./support.ts";

// Reflow (#37, WCAG 1.4.10): at 320 CSS px (a 1280 px window at 400 %) and at 640 × 400
// (a 1280 × 800 window at 200 %) every screen reads without scrolling sideways: the
// landing page, the join form, the room while voting and revealed with the PO's decision,
// and the settings and history sheets.

const SIZES = [
  { name: "320 px (400 %)", width: 320, height: 568 },
  { name: "640 × 400 (200 %)", width: 640, height: 400 },
] as const;

/** What scrolls sideways: the page, or an open dialog's own content. */
function sideways(page: Page) {
  return page.evaluate(() => {
    const over: string[] = [];
    const root = document.documentElement;
    if (root.scrollWidth > root.clientWidth) over.push(`page ${root.scrollWidth}`);
    for (const dialog of document.querySelectorAll("[role='dialog']")) {
      for (const part of [dialog, ...dialog.querySelectorAll("*")]) {
        const style = getComputedStyle(part);
        if (!/(auto|scroll)/.test(style.overflowX)) continue;
        // A list that scrolls on purpose (the hand, a deck's cards) is not a page.
        if (part.closest("[role='toolbar'], [role='radiogroup']")) continue;
        if (part.scrollWidth > part.clientWidth + 1) {
          over.push(`${part.tagName.toLowerCase()} in a dialog ${part.scrollWidth}`);
        }
      }
    }
    return over;
  });
}

async function check(page: Page, screen: string) {
  for (const size of SIZES) {
    await page.setViewportSize({ width: size.width, height: size.height });
    await settle(page);
    expect.soft(await sideways(page), `${screen} at ${size.name}`).toEqual([]);
    await page.screenshot({
      path: `${SHOTS}reflow-${screen.replaceAll(" ", "-")}-${size.width}.png`,
    });
  }
  await page.setViewportSize({ width: 1280, height: 800 });
}

test("every screen reflows at 320 px and at 200 % zoom without a sideways scroll", async ({
  page,
  baseURL,
}) => {
  test.setTimeout(120_000);
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Create the room" })).toBeVisible();
  await check(page, "landing");

  const code = await createRoom(page);
  await check(page, "join form");
  await join(page, "Ana");
  let guests: Guest[] = [];
  try {
    guests = await guestsJoin(baseURL ?? "", code, ["Ben", "Cleo Novak-Lindqvist", "Dan"]);
    await page.getByRole("button", { name: "Start voting" }).click();
    await handCard(page, "8").click();
    await check(page, "voting");

    for (const [i, card] of ["5", "13"].entries()) {
      expect(await guests[i]?.cmd("castVote", { card, round: 1, restart: 0 })).toMatchObject({
        ok: true,
      });
    }
    await page.getByRole("button", { name: "Reveal cards" }).click();
    await expect(page.getByRole("region", { name: "Results" })).toBeVisible();
    await check(page, "revealed");

    await page.getByRole("button", { name: "Room settings" }).click();
    await expect(page.getByRole("dialog", { name: "Room settings" })).toBeVisible();
    await check(page, "settings");
    await page.keyboard.press("Escape");

    await page.getByRole("button", { name: "Record 8" }).click();
    await page.getByRole("button", { name: "Next round" }).click();
    await page.getByRole("button", { name: "History" }).click();
    const history = page.getByRole("dialog", { name: "History" });
    await history.getByRole("button", { name: "Votes of round 1" }).click();
    await expect(history.locator("[data-history-vote]").first()).toBeVisible();
    await check(page, "history");
  } finally {
    for (const guest of guests) guest.close();
  }
});
