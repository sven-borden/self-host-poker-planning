import { expect, test } from "./fixtures.ts";
import { createRoom, join, newPerson, ROOM_PATH, recordFrames, seats } from "./support.ts";

// Avatars (#42): picked by keyboard on the join screen, shown on everyone's table, changed
// from the room, carried to the next room, and still under reduced motion.

const art = '[data-avatar-art="idle"]';

/** How many gestures the page has made since it loaded. */
const gestures = (page: import("@playwright/test").Page) =>
  page.evaluate(() => Reflect.get(window, "ppGestures") as number);

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    Reflect.set(window, "ppGestures", 0);
    const original = Element.prototype.animate;
    Element.prototype.animate = function animate(...args) {
      if (this.matches("[data-avatar-art], [data-avatar-eyes]")) {
        Reflect.set(window, "ppGestures", (Reflect.get(window, "ppGestures") as number) + 1);
      }
      return original.apply(this, args);
    };
  });
});

test("a pick by keyboard reaches the table, everyone's page and the next room", async ({
  page,
  browser,
}) => {
  test.setTimeout(60_000);
  await createRoom(page);
  const name = page.getByRole("textbox", { name: "Your name" });
  await name.fill("Ana Lima");

  // Keyboard only: open the picker, walk the radios, join with Enter.
  const open = page.getByRole("button", { name: "Choose an avatar" });
  await open.focus();
  await page.keyboard.press("Enter");
  await expect(open).toHaveAttribute("aria-expanded", "true");
  await page.keyboard.press("Tab");
  await expect(page.getByRole("radio", { name: "Initials" })).toBeFocused();
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("radio", { name: "Cat" })).toBeChecked();
  await expect(page.getByRole("radio", { name: "Cat" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: "You", exact: true })).toBeVisible();

  await expect(seats(page).locator(`[data-seat][data-you] ${art}`)).toBeVisible();
  await expect(page.locator("section[data-you] [data-avatar] svg")).toBeVisible();

  // Someone else sees the drawing; a person without one keeps their initials.
  const ben = await newPerson(browser);
  try {
    const frames = recordFrames(ben.page);
    await ben.page.goto(page.url());
    await join(ben.page, "Ben Oka");
    await expect(seats(ben.page).locator(art)).toHaveCount(1);
    await expect(seats(ben.page).locator("[data-seat][data-you] [data-avatar]")).toHaveText("BO");
    expect(frames.join("")).toContain('"avatar":"cat"');

    // Changed from the room: the arrows send nothing, Save does, and Ben sees it.
    const change = page.getByRole("button", { name: "Change your avatar" });
    await change.click();
    await expect(page.getByRole("radio", { name: "Cat" })).toBeFocused();
    await page.keyboard.press("ArrowRight");
    await expect(page.getByRole("radio", { name: "Chick" })).toBeChecked();
    expect(frames.join("")).not.toContain('"avatar":"chick"');
    await page.getByRole("button", { name: "Save" }).click();
    await expect(change).toBeFocused();
    await expect.poll(() => frames.join("").includes('"avatar":"chick"')).toBe(true);

    // Back to initials.
    await change.click();
    await page.getByRole("radio", { name: "Initials" }).check({ force: true });
    await page.keyboard.press("Escape");
    await expect(change).toBeFocused();
    await expect(seats(page).locator(`[data-seat][data-you] ${art}`)).toBeVisible();
  } finally {
    await ben.context.close();
  }

  // The next room starts with the pick.
  await page.goto("/");
  await page.getByRole("button", { name: "Create the room" }).click();
  await expect(page).toHaveURL(ROOM_PATH);
  await expect(page.getByRole("button", { name: "Change your avatar" })).toBeVisible();
  await expect(name).toHaveValue("Ana Lima");
  await page.getByRole("button", { name: "Join the room" }).click();
  await expect(seats(page).locator(`[data-seat][data-you] ${art}`)).toBeVisible();
});

test("the table's avatars blink and bob", async ({ page }) => {
  await createRoom(page);
  await page.getByRole("button", { name: "Choose an avatar" }).click();
  await page.getByRole("radio", { name: "Fox" }).check({ force: true });
  await join(page, "Ana");
  await expect.poll(() => gestures(page), { timeout: 15_000 }).toBeGreaterThan(0);
});

test("under reduced motion they stay still", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await createRoom(page);
  await page.getByRole("button", { name: "Choose an avatar" }).click();
  await page.getByRole("radio", { name: "Fox" }).check({ force: true });
  await join(page, "Ana");
  await expect(seats(page).locator(art)).toBeVisible();
  // Longer than the longest wait between two gestures, twice over.
  await page.waitForTimeout(7_500);
  expect(await gestures(page)).toBe(0);
});

test("the picker fits a 320 px screen, without sideways scroll", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 640 });
  await createRoom(page);
  await page.getByRole("button", { name: "Choose an avatar" }).click();
  await expect(page.getByRole("radio", { name: "Tiger" })).toBeAttached();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBe(0);
});
