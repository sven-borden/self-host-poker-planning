import { type Browser, expect, type Locator, type Page, test } from "@playwright/test";
import { createRoom, join, newPerson, ownAddress, phone, SHOTS, shoot } from "./support.ts";

// The room password (#31) in real browsers, against the real server and Postgres: the PO
// sets it and someone already in the room stays; a newcomer types a wrong one, then the
// right one; the PO changes it and a device that had entered must type the new one; the
// PO removes someone, who must type it again; the PO removes it; and both sides by
// keyboard only, on a desktop and on a phone. Screenshots of the panel's row in both
// states, the join screen with its field and its error, and the header's lock. Needs
// DATABASE_URL; skipped without it locally, failing without it in CI.

test.skip(
  !process.env.DATABASE_URL && !process.env.CI,
  "needs DATABASE_URL: runs against the real server",
);
test.beforeAll(() => {
  if (!process.env.DATABASE_URL) throw new Error("CI must run the room password: set DATABASE_URL");
});
test.beforeEach(async ({ page }) => {
  await page.setExtraHTTPHeaders(ownAddress());
});

const live = (page: Page) => page.locator("[data-table-live]");
const lock = (page: Page) => page.getByRole("img", { name: "This room has a password." });
const passwordField = (page: Page) => page.getByLabel("Password", { exact: true });
const panel = (page: Page) => page.getByRole("dialog", { name: "Room settings" });
const passwordRow = (page: Page) => panel(page).locator('[data-setting="hasPassword"]');
const seated = (page: Page) => page.getByRole("heading", { name: "You", exact: true });

/** The live region says `sentence` once. */
async function saidOnce(page: Page, sentence: string) {
  await expect(live(page)).toContainText(sentence);
  const text = (await live(page).textContent()) ?? "";
  expect(text.split(sentence).length - 1, `"${sentence}" in "${text}"`).toBe(1);
}

/** Opens "Room settings" and sets (or changes to) `password` with the pointer. */
async function setPassword(page: Page, password: string) {
  await page.getByRole("button", { name: "Room settings" }).click();
  const row = passwordRow(page);
  const change = row.getByRole("button", { name: "Change password" });
  const changing = await change.isVisible();
  if (changing) await change.click();
  await row.getByLabel("Password", { exact: true }).fill(password);
  // A change is saved, a first password set.
  await row.getByRole("button", { name: changing ? "Save password" : "Set password" }).click();
  await expect(row.getByText("This room has a password.")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(panel(page)).toHaveCount(0);
}

/** A newcomer's page on the room's link, joining with `password`. */
async function joinWithPassword(page: Page, name: string, password: string) {
  await expect(passwordField(page)).toBeVisible();
  await passwordField(page).fill(password);
  await page.getByRole("textbox", { name: "Your name" }).fill(name);
  await page.getByRole("button", { name: "Join the room" }).click();
  await expect(seated(page)).toBeVisible();
}

async function person(browser: Browser, url: string) {
  const { context, page } = await newPerson(browser);
  await page.goto(url);
  return { context, page };
}

/**
 * The panel's password row at 360 and 1440 px, light and dark: the sheet scrolls on its
 * own, so each shot scrolls the row into view and takes the viewport, not the full page.
 */
async function shootRow(page: Page, name: string) {
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    for (const width of [360, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      await passwordRow(page).scrollIntoViewIfNeeded();
      // No shot mid-transition: every finite animation has ended (the sheet, the colours).
      await page.waitForFunction(() =>
        document
          .getAnimations()
          .every(
            (animation) =>
              animation.playState !== "running" ||
              animation.effect?.getComputedTiming().endTime === Infinity,
          ),
      );
      await page.screenshot({ path: `${SHOTS}${name}-${width}-${scheme}.png` });
    }
  }
  await page.emulateMedia({ colorScheme: "light" });
}

/** Presses Tab until `target` has the focus. */
async function tabTo(page: Page, target: Locator) {
  for (let i = 0; i < 80; i++) {
    await page.keyboard.press("Tab");
    if (await target.evaluate((el) => el === document.activeElement)) return;
  }
  throw new Error("Tab never reached the target");
}

test("the PO sets a password; people in the room stay; a newcomer types a wrong one, then the right one", async ({
  page,
  browser,
}) => {
  test.setTimeout(90_000);
  await createRoom(page);
  await join(page, "Ana");
  const url = page.url();
  const ben = await person(browser, url);
  await join(ben.page, "Ben");
  try {
    await expect(lock(page)).toHaveCount(0);
    await page.getByRole("button", { name: "Room settings" }).click();
    await expect(passwordRow(page).getByRole("button", { name: "Set password" })).toBeVisible();
    await shootRow(page, "password-row-none");
    await passwordRow(page).getByLabel("Password", { exact: true }).fill("blue harbour");
    await passwordRow(page).getByRole("button", { name: "Set password" }).click();
    await expect(passwordRow(page).getByText("This room has a password.")).toBeVisible();
    await expect(passwordRow(page).getByRole("button", { name: "Change password" })).toBeFocused();
    await shootRow(page, "password-row-set");
    await page.keyboard.press("Escape");

    // Ben stays at the table and hears it once; both headers show the lock.
    await saidOnce(ben.page, "The product owner set a password for this room.");
    await expect(seated(ben.page)).toBeVisible();
    await expect(lock(page)).toBeVisible();
    await expect(lock(ben.page)).toBeVisible();
    await shoot(page, "password-header-lock");
    await ben.page.getByRole("button", { name: "Room rules" }).click();
    await expect(
      ben.page.getByRole("dialog", { name: "Room rules" }).locator('[data-setting="hasPassword"]'),
    ).toContainText("On");
    await ben.page.keyboard.press("Escape");
    // A reload: still in the room, no password asked.
    await ben.page.reload();
    await expect(seated(ben.page)).toBeVisible();

    // Cleo comes with the link alone.
    const cleo = await person(browser, url);
    try {
      await expect(passwordField(cleo.page)).toBeFocused();
      await expect(
        cleo.page.getByText("This room has a password. Enter it to join."),
      ).toBeVisible();
      await expect(lock(cleo.page)).toBeVisible();
      await shoot(cleo.page, "password-join");
      await passwordField(cleo.page).fill("red harbour");
      await cleo.page.getByRole("textbox", { name: "Your name" }).fill("Cleo");
      await cleo.page.getByRole("button", { name: "Join the room" }).click();
      await expect(cleo.page.getByRole("alert")).toHaveText("That password is not right.");
      await expect(passwordField(cleo.page)).toBeFocused();
      const selected = await passwordField(cleo.page).evaluate((el) => [
        (el as HTMLInputElement).selectionStart,
        (el as HTMLInputElement).selectionEnd,
      ]);
      expect(selected).toEqual([0, "red harbour".length]);
      await shoot(cleo.page, "password-join-wrong");
      await passwordField(cleo.page).fill("blue harbour");
      await cleo.page.getByRole("button", { name: "Join the room" }).click();
      await expect(seated(cleo.page)).toBeVisible();
      // A second visit from the same device asks nothing.
      await cleo.page.reload();
      await expect(seated(cleo.page)).toBeVisible();
    } finally {
      await cleo.context.close();
    }
  } finally {
    await ben.context.close();
  }
});

test("the PO changes it; a device that had entered must type the new one", async ({
  page,
  browser,
}) => {
  test.setTimeout(90_000);
  await createRoom(page);
  await join(page, "Ana");
  await setPassword(page, "first secret");
  const dan = await person(browser, page.url());
  try {
    await joinWithPassword(dan.page, "Dan", "first secret");
    // Dan leaves the room but keeps the page: his device may come back without typing.
    await dan.page.getByRole("button", { name: "Leave the room" }).click();
    await expect(dan.page.getByRole("textbox", { name: "Your name" })).toBeVisible();
    await expect(passwordField(dan.page)).toHaveCount(0);

    await setPassword(page, "second secret");
    await expect(dan.page.getByText("The product owner changed the password.")).toBeVisible();
    await passwordField(dan.page).fill("first secret");
    await dan.page.getByRole("button", { name: "Join the room" }).click();
    await expect(dan.page.getByRole("alert")).toHaveText("That password is not right.");
    await passwordField(dan.page).fill("second secret");
    await dan.page.getByRole("button", { name: "Join the room" }).click();
    await expect(seated(dan.page)).toBeVisible();
  } finally {
    await dan.context.close();
  }
});

test("the PO removes someone, who must type the password again (AC 3)", async ({
  page,
  browser,
}) => {
  test.setTimeout(90_000);
  await createRoom(page);
  await join(page, "Ana");
  await setPassword(page, "kick me out");
  const eve = await person(browser, page.url());
  try {
    await joinWithPassword(eve.page, "Eve", "kick me out");
    await page
      .locator("[data-room-table]")
      .getByRole("button", { name: /^Eve(,|$)/ })
      .click();
    await page.getByRole("dialog").getByRole("button", { name: "Remove from the room" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Remove", exact: true }).click();

    await expect(eve.page.getByText("The product owner removed you from this room.")).toBeVisible();
    await expect(passwordField(eve.page)).toBeVisible();
    await joinWithPassword(eve.page, "Eve", "kick me out");
    await expect(eve.page.getByText("The product owner removed you from this room.")).toHaveCount(
      0,
    );
  } finally {
    await eve.context.close();
  }
});

test("the PO removes the password: no lock, no field, and everyone hears it", async ({
  page,
  browser,
}) => {
  test.setTimeout(90_000);
  await createRoom(page);
  await join(page, "Ana");
  await setPassword(page, "short lived");
  const ben = await person(browser, page.url());
  try {
    await joinWithPassword(ben.page, "Ben", "short lived");
    await page.getByRole("button", { name: "Room settings" }).click();
    await passwordRow(page).getByRole("button", { name: "Remove password" }).click();
    await expect(passwordRow(page).getByLabel("Password", { exact: true })).toBeFocused();
    await page.keyboard.press("Escape");
    await saidOnce(ben.page, "The product owner removed the room’s password.");
    await expect(lock(page)).toHaveCount(0);
    await expect(lock(ben.page)).toHaveCount(0);

    const fay = await person(browser, page.url());
    try {
      await expect(fay.page.getByRole("textbox", { name: "Your name" })).toBeVisible();
      await expect(passwordField(fay.page)).toHaveCount(0);
      await join(fay.page, "Fay");
    } finally {
      await fay.context.close();
    }
  } finally {
    await ben.context.close();
  }
});

test("keyboard only: the PO sets it on a desktop, a newcomer joins with it on a phone", async ({
  page,
  browser,
}) => {
  test.setTimeout(90_000);
  await createRoom(page);
  await join(page, "Ana");
  await tabTo(page, page.getByRole("button", { name: "Room settings" }));
  await page.keyboard.press("Enter");
  const field = passwordRow(page).getByLabel("Password", { exact: true });
  await tabTo(page, field);
  await page.keyboard.type("by keys only");
  await page.keyboard.press("Enter");
  await expect(passwordRow(page).getByRole("button", { name: "Change password" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "Room settings" })).toBeFocused();

  const mobile = await phone(browser, "Pixel 7");
  try {
    await mobile.page.goto(page.url());
    await expect(passwordField(mobile.page)).toBeFocused();
    await mobile.page.keyboard.type("by keys only");
    await tabTo(mobile.page, mobile.page.getByRole("textbox", { name: "Your name" }));
    await mobile.page.keyboard.type("Gus");
    await mobile.page.keyboard.press("Enter");
    await expect(seated(mobile.page)).toBeVisible();
    expect(mobile.errors).toEqual([]);
  } finally {
    await mobile.context.close();
  }
});

test("one tab gets in with the password: the other tabs of that browser enter too (N5)", async ({
  page,
  browser,
}) => {
  test.setTimeout(90_000);
  await createRoom(page);
  await join(page, "Ana");
  await setPassword(page, "two tabs here");
  const eve = await person(browser, page.url());
  try {
    const second = await eve.context.newPage();
    await second.goto(page.url());
    await expect(passwordField(second)).toBeVisible();
    await expect(passwordField(eve.page)).toBeVisible();
    await joinWithPassword(eve.page, "Eve", "two tabs here");
    // The other tab was told: it entered again, and now sees Eve at the table.
    await expect(passwordField(second)).toHaveCount(0);
    await expect(seated(second)).toBeVisible();
  } finally {
    await eve.context.close();
  }
});
