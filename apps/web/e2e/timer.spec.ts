import { expect, type Page, test } from "@playwright/test";
import { createRoom, guestsJoin, join, SHOTS } from "./support.ts";

test.skip(
  !process.env.DATABASE_URL && !process.env.CI,
  "needs DATABASE_URL: runs against the real server",
);

const chip = (page: Page) => page.locator("[data-timer-button], [role='timer']");

test("look", async ({ page, baseURL }) => {
  test.setTimeout(120_000);
  const code = await createRoom(page);
  await join(page, "Ana");
  const guests = await guestsJoin(baseURL ?? "", code, ["Ben", "Cleo", "Dan", "Eve", "Finn", "Gus", "Hana"]);
  try {
    await page.getByRole("button", { name: "Start voting" }).click();
    for (const width of [1440, 360]) {
      await page.setViewportSize({ width, height: 900 });
      await page.waitForTimeout(300);
      await page.screenshot({ path: `${SHOTS}explore-idle-${width}.png` });
    }
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.locator("[data-timer-button]").click();
    await page.screenshot({ path: `${SHOTS}explore-menu-1440.png` });
    await page.locator("[data-timer-preset='30']").click();
    await expect(chip(page)).toHaveAttribute("data-timer", "running");
    for (const width of [1440, 360]) {
      await page.setViewportSize({ width, height: 900 });
      await page.waitForTimeout(300);
      await page.screenshot({ path: `${SHOTS}explore-running-${width}.png` });
    }
    await page.waitForTimeout(21_000);
    await page.screenshot({ path: `${SHOTS}explore-warn-360.png` });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.screenshot({ path: `${SHOTS}explore-warn-1440.png` });
  } finally {
    for (const guest of guests) guest.close();
  }
});
