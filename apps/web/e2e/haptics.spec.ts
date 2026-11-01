import { AxeBuilder } from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { WCAG_TAGS } from "./a11y.ts";
import { expect, test } from "./fixtures.ts";
import {
  createRoom,
  guestsJoin,
  handCard,
  join,
  newPerson,
  phone,
  ROOM_PATH,
  sameUser,
} from "./support.ts";

// Vibration in a real browser (#22, #46): a real page on a phone's profile, with
// `navigator.vibrate` written down, as a test machine has nothing to feel it with.

/** Writes down every pattern the page asks for, from its next load on. */
const record = (page: Page) =>
  page.addInitScript(() => {
    const asked: unknown[] = [];
    Object.assign(window, { __vibrated: asked });
    Object.defineProperty(navigator, "vibrate", {
      configurable: true,
      value: (pattern: unknown) => {
        asked.push(pattern);
        return true;
      },
    });
  });

const vibrated = (page: Page) =>
  page.evaluate(() => (window as unknown as { __vibrated: unknown[] }).__vibrated);

const speaker = (page: Page) => page.locator("[data-sound]");
const theSwitch = (page: Page) => page.getByRole("switch", { name: "Vibrate" });

test("a person's vote ticks and the reveal beats once, for voter and watcher", async ({
  browser,
  baseURL,
}) => {
  const ana = await phone(browser, { width: 390, height: 844 });
  const watcher = await phone(browser, { width: 390, height: 844 });
  await record(ana.page);
  await record(watcher.page);
  const code = await createRoom(ana.page);
  await join(ana.page, "Ana");
  const owner = await sameUser(baseURL ?? "", ana.context);
  const [ben] = await guestsJoin(baseURL ?? "", code, ["Ben"]);
  try {
    expect(await owner.enter(code)).toMatchObject({ ok: true });
    await watcher.page.goto(`/r/${code}`);
    await join(watcher.page, "Cleo", "Observer");
    expect(
      await owner.cmd("updateSettings", { patch: { revealWhenAllVoted: false } }),
    ).toMatchObject({ ok: true });
    await ana.page.getByRole("button", { name: "Start voting" }).click();
    await handCard(ana.page, "5").click();
    await expect.poll(() => vibrated(ana.page)).toEqual([12]);
    expect(await ben?.cmd("castVote", { card: "5", round: 1, restart: 0 })).toMatchObject({
      ok: true,
    });
    expect(await owner.cmd("reveal")).toMatchObject({ ok: true });
    await expect.poll(() => vibrated(ana.page)).toEqual([12, [20, 70, 35]]);
    await expect.poll(() => vibrated(watcher.page)).toEqual([[20, 70, 35]]);

    // A later snapshot of the same reveal, and a page that opens on it, feel nothing.
    await ana.page.reload();
    await expect(ana.page.locator("[data-centre-result]")).toContainText("Suggested 5");
    expect(await vibrated(ana.page)).toEqual([]);
  } finally {
    owner.close();
    ben?.close();
    await ana.context.close();
    await watcher.context.close();
  }
});

test("the switch in the speaker's popover stops it, on this device, and comes back", async ({
  browser,
}) => {
  const ana = await phone(browser, { width: 390, height: 844 });
  await record(ana.page);
  await createRoom(ana.page);
  await join(ana.page, "Ana");
  try {
    await speaker(ana.page).click();
    await expect(theSwitch(ana.page)).toBeChecked();
    const { violations } = await new AxeBuilder({ page: ana.page }).withTags(WCAG_TAGS).analyze();
    expect(violations).toEqual([]);
    await theSwitch(ana.page).click();
    await expect(theSwitch(ana.page)).not.toBeChecked();
    await ana.page.keyboard.press("Escape");
    expect(await ana.page.evaluate(() => localStorage.getItem("pp-haptics"))).toBe("off");

    await ana.page.getByRole("button", { name: "Start voting" }).click();
    await handCard(ana.page, "5").click();
    await expect(ana.page.locator("[data-centre-result]")).toContainText("Suggested 5");
    expect(await vibrated(ana.page)).toEqual([]);

    await ana.page.reload();
    await speaker(ana.page).click();
    await expect(theSwitch(ana.page)).not.toBeChecked();
  } finally {
    await ana.context.close();
  }
});

test("a screen with a mouse has no switch", async ({ browser }) => {
  const { page, context } = await newPerson(browser);
  await createRoom(page);
  await join(page, "Ana");
  await expect(page).toHaveURL(ROOM_PATH);
  try {
    await speaker(page).click();
    await expect(page.getByRole("switch", { name: "Play sound effects" })).toBeVisible();
    await expect(theSwitch(page)).toHaveCount(0);
  } finally {
    await context.close();
  }
});

test("under reduced motion nothing vibrates and the switch is gone", async ({ browser }) => {
  const ana = await phone(browser, { width: 390, height: 844 });
  await ana.page.emulateMedia({ reducedMotion: "reduce" });
  await record(ana.page);
  await createRoom(ana.page);
  await join(ana.page, "Ana");
  try {
    await ana.page.getByRole("button", { name: "Start voting" }).click();
    await handCard(ana.page, "5").click();
    await expect(ana.page.locator("[data-centre-result]")).toContainText("Suggested 5");
    expect(await vibrated(ana.page)).toEqual([]);
    await speaker(ana.page).click();
    await expect(theSwitch(ana.page)).toHaveCount(0);
  } finally {
    await ana.context.close();
  }
});
