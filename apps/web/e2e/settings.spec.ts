import { expect, type Locator, type Page, test } from "@playwright/test";
import {
  createRoom,
  type Guest,
  handCard,
  join,
  newGuest,
  newPerson,
  ownAddress,
  phone,
  recordFrames,
  SHOTS,
  snapshotsIn,
} from "./support.ts";

// The room settings (#25) in real browsers, against the real server and Postgres: the PO
// changes settings by keyboard alone, on a desktop and on a phone; another person reads
// the same panel as "Room rules", sees a new room's defaults (AC 3), and gets each change
// in one snapshot (AC 1) and in the table's live region; turning observers back on past
// 16 people is refused and rolled back. The refusals for a voter and an observer are on
// the wire in the server's `room-sync.db.test.ts` (AC 2).
// Needs DATABASE_URL; skipped without it locally, failing without it in CI.

test.skip(
  !process.env.DATABASE_URL && !process.env.CI,
  "needs DATABASE_URL: runs against the real server",
);
test.beforeAll(() => {
  if (!process.env.DATABASE_URL) {
    throw new Error("CI must run the settings tests: set DATABASE_URL");
  }
});
test.beforeEach(async ({ page }) => {
  await page.setExtraHTTPHeaders(ownAddress());
});

const tableLive = (page: Page) => page.locator("[data-table-live]");
const panel = (page: Page, name: "Room settings" | "Room rules") =>
  page.getByRole("dialog", { name });
const value = (dialog: Locator, key: string) =>
  dialog.locator(`[data-setting="${key}"] [data-setting-value]`);

/** Opens the panel from the header's button with the keyboard alone. */
async function openByKeyboard(page: Page, name: "Room settings" | "Room rules") {
  const button = page.getByRole("button", { name });
  await button.focus();
  await page.keyboard.press("Enter");
  const dialog = panel(page, name);
  await expect(dialog).toBeVisible();
  // Let the sheet slide in before measuring it.
  await dialog.evaluate((element) =>
    Promise.all(element.getAnimations().map((animation) => animation.finished)),
  );
  return { button, dialog };
}

/** Lets every finite animation on the page end (the sheet slides in again when it changes side). */
async function settle(page: Page) {
  await page.evaluate(() =>
    Promise.all(
      document
        .getAnimations()
        .filter((animation) => animation.effect?.getComputedTiming().endTime !== Infinity)
        .map((animation) => animation.finished),
    ),
  );
}

/**
 * The open panel at 360 and 1440 px, light, dark and in forced colours: a bottom sheet,
 * then a side sheet.
 */
async function shootPanel(page: Page, name: string) {
  for (const scheme of ["light", "dark", "forced"] as const) {
    await page.emulateMedia(
      scheme === "forced"
        ? { colorScheme: "dark", forcedColors: "active" }
        : { colorScheme: scheme, forcedColors: "none" },
    );
    for (const width of [360, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      await page.waitForTimeout(150);
      await settle(page);
      await page.screenshot({ path: `${SHOTS}${name}-${width}-${scheme}.png` });
    }
  }
  await page.emulateMedia({ colorScheme: "light", forcedColors: "none" });
  await page.setViewportSize({ width: 1280, height: 720 });
}

/** A switch as forced colours paint it: its track and its thumb. */
const painted = (control: Locator) =>
  control.evaluate((element) => ({
    track: getComputedStyle(element).backgroundColor,
    thumb: getComputedStyle(element.firstElementChild ?? element).backgroundColor,
  }));

/** Whether a screen reader skips `locator`: inside what a modal dialog hides. */
const hidden = (locator: Locator) =>
  locator.evaluate((element) => element.closest("[aria-hidden='true']") !== null);

/** Moves the focus forward with Tab until `target` has it. */
async function tabTo(page: Page, target: Locator) {
  for (let i = 0; i < 16; i++) {
    if (await target.evaluate((element) => element === document.activeElement)) return;
    await page.keyboard.press("Tab");
  }
  await expect(target).toBeFocused();
}

test("the PO changes settings by keyboard; another person reads them and hears each change in one snapshot (AC 1, AC 3)", async ({
  page,
  browser,
}) => {
  test.setTimeout(120_000);
  const code = await createRoom(page);
  await join(page, "Pia");
  const ben = await newPerson(browser);
  const frames = recordFrames(ben.page);
  await ben.page.goto(`/r/${code}`);
  await join(ben.page, "Ben");

  // Ben reads a new room's rules: exactly ADR-011's defaults, and no control.
  const rules = (await openByKeyboard(ben.page, "Room rules")).dialog;
  await expect(rules.getByRole("switch")).toHaveCount(0);
  const defaults = {
    deck: "Fibonacci",
    specials: "? and ☕",
    timer: "Off",
    revealWhenAllVoted: "On",
    whoCanReveal: "The product owner",
    revealNames: "Off",
    allowChangeAfterReveal: "Not allowed",
    poVotes: "On",
    observersCount: "On",
  };
  for (const [key, text] of Object.entries(defaults)) {
    await expect(value(rules, key)).toHaveText(text);
  }

  // The PO opens the settings with Enter; the focus lands on the first control, the deck
  // in use (#26).
  const { button, dialog } = await openByKeyboard(page, "Room settings");
  await expect(dialog.getByRole("radio", { name: "Fibonacci", exact: true })).toBeFocused();
  const anonymous = dialog.getByRole("switch", { name: "Anonymous voting" });
  await tabTo(page, anonymous);
  await page.keyboard.press("Space");
  await expect(anonymous).toHaveAttribute("aria-checked", "true");
  await expect(anonymous).not.toHaveAttribute("aria-busy", "true");
  // Ben's open panel follows at once, and says it: his panel hides the table's region.
  await expect(value(rules, "revealNames")).toHaveText("On");
  await expect(rules.locator("[data-panel-live]")).toHaveText(
    "Anonymous voting starts with round 1.",
  );
  expect(await hidden(tableLive(ben.page))).toBe(true);
  // One snapshot carried the change to Ben (AC 1).
  const changes = snapshotsIn(frames).filter((s) =>
    s.causes.some((cause) => cause.type === "settingsUpdated"),
  );
  expect(changes).toHaveLength(1);
  const changed = changes[0]?.room as unknown as { settings: { revealNames: boolean } } | undefined;
  expect(changed?.settings.revealNames).toBe(false);

  await shootPanel(page, "settings-owner");
  await shootPanel(ben.page, "settings-rules");

  // Ben closes the rules; the PO stops voting, and Ben hears it.
  await ben.page.keyboard.press("Escape");
  await expect(rules).toBeHidden();
  const poVotes = dialog.getByRole("switch", { name: "The product owner votes too" });
  await tabTo(page, poVotes);
  await page.keyboard.press("Space");
  await expect(poVotes).toHaveAttribute("aria-checked", "false");
  // Closed, Ben hears the table's region again.
  await expect(tableLive(ben.page)).toHaveText("The product owner no longer votes.");
  expect(await hidden(tableLive(ben.page))).toBe(false);

  // In forced colours an on switch still looks other than an off one.
  await page.emulateMedia({ forcedColors: "active" });
  const on = await painted(anonymous);
  const off = await painted(poVotes);
  expect(on.track).not.toBe(off.track);
  expect(on.thumb).not.toBe(off.thumb);
  expect(on.track).not.toBe(on.thumb);
  expect(off.track).not.toBe(off.thumb);
  await page.emulateMedia({ forcedColors: "none" });

  // Esc closes the panel and gives the focus back to the header's button.
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(button).toBeFocused();
  await expect(page.locator("[data-room-hand='owner']")).toHaveText(
    "As the product owner, you do not vote in this room.",
  );
  await ben.context.close();
});

test("turning observers back on past 16 people is refused, said and rolled back", async ({
  page,
}) => {
  test.setTimeout(180_000);
  const code = await createRoom(page);
  await join(page, "Pia");
  const { dialog } = await openByKeyboard(page, "Room settings");
  const observers = dialog.getByRole("switch", { name: "Observers take one of the 16 places" });
  await tabTo(page, observers);
  await page.keyboard.press("Space");
  await expect(observers).toHaveAttribute("aria-checked", "false");

  // 15 more voters and an observer: 17 people, 16 counted without the observer.
  const base = new URL(page.url()).origin;
  const guests: Guest[] = [];
  for (let i = 0; i < 16; i++) {
    const guest = await newGuest(base);
    guests.push(guest);
    expect(await guest.enter(code)).toMatchObject({ ok: true });
    const role = i === 15 ? "observer" : "voter";
    expect(await guest.cmd("join", { name: `Guest ${i + 1}`, role })).toMatchObject({ ok: true });
  }
  await expect(page.getByTestId("room-people")).toHaveText("17 people in the room");

  await page.keyboard.press("Space");
  await expect(dialog.getByRole("alert")).toHaveText(
    "More than 16 people are here with the observers. Observers can count again once there are 16 or fewer.",
  );
  await expect(observers).toHaveAttribute("aria-checked", "false");
  await expect(observers).toBeFocused();
  for (const guest of guests) guest.close();
});

test("on a phone the PO changes a setting by keyboard in a bottom sheet", async ({ browser }) => {
  test.setTimeout(120_000);
  const { context, page, errors } = await phone(browser, "iPhone 13");
  await createRoom(page);
  await join(page, "Pia");
  const { button, dialog } = await openByKeyboard(page, "Room settings");
  // A bottom sheet: the screen's whole width, on its bottom edge.
  const box = await dialog.boundingBox();
  const viewport = page.viewportSize();
  expect(box && viewport).toBeTruthy();
  if (box && viewport) {
    expect(Math.round(box.width)).toBe(viewport.width);
    expect(Math.round(box.y + box.height)).toBe(viewport.height);
  }
  const poVotes = dialog.getByRole("switch", { name: "The product owner votes too" });
  await tabTo(page, poVotes);
  await page.keyboard.press("Space");
  await expect(poVotes).toHaveAttribute("aria-checked", "false");
  await expect(poVotes).not.toHaveAttribute("aria-busy", "true");
  await page.screenshot({ path: `${SHOTS}phone-settings-390-light.png` });
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(button).toBeFocused();
  await expect(page.locator("[data-room-hand='owner']")).toBeVisible();
  await page.screenshot({ path: `${SHOTS}phone-settings-closed-390-light.png` });
  // Nothing scrolls sideways with the header's two buttons.
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(viewport?.width);
  expect(errors).toEqual([]);
  await context.close();
});

test("an anonymous round is marked for everyone, and an open panel still says the table's news", async ({
  page,
  browser,
}) => {
  test.setTimeout(120_000);
  const code = await createRoom(page);
  await join(page, "Pia");
  const ben = await newPerson(browser);
  await ben.page.goto(`/r/${code}`);
  await join(ben.page, "Ben");
  const cleo = await newPerson(browser);
  await cleo.page.goto(`/r/${code}`);
  await join(cleo.page, "Cleo", "Observer");

  // The PO turns anonymity on in the panel, then starts the round.
  const { dialog } = await openByKeyboard(page, "Room settings");
  const anonymous = dialog.getByRole("switch", { name: "Anonymous voting" });
  await tabTo(page, anonymous);
  await page.keyboard.press("Space");
  await expect(anonymous).not.toHaveAttribute("aria-busy", "true");
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await page.getByRole("button", { name: "Start voting" }).click();

  // The PO, a voter and an observer read it before anyone votes.
  for (const viewer of [page, ben.page, cleo.page]) {
    const line = viewer.locator("[data-round-subject]");
    const chip = line.locator("[data-round-anonymous]");
    await expect(chip).toBeVisible();
    await expect(chip.locator("[title]")).toHaveText("Anonymous");
    await expect(chip.locator("[title]")).toHaveAttribute(
      "title",
      "Cards are shown without names.",
    );
    await expect(chip.locator(".sr-only")).toHaveText(
      "Anonymous round: cards are shown without names.",
    );
  }
  await expect(tableLive(ben.page)).toContainText("Voting started: Round 1, anonymous.");
  await page.locator("[data-round-subject]").screenshot({
    path: `${SHOTS}round-anonymous-1440-light.png`,
  });

  // Ben reads the rules while Pia votes and reveals: his panel says the reveal.
  const rules = (await openByKeyboard(ben.page, "Room rules")).dialog;
  await handCard(page, "5").click();
  await page.getByRole("button", { name: "Reveal cards" }).click();
  await expect(rules.locator("[data-panel-live]")).toContainText("Cards revealed.");
  expect(await hidden(tableLive(ben.page))).toBe(true);
  // The chip stays once the round is revealed.
  await expect(ben.page.locator("[data-round-anonymous]")).toBeVisible();
  await ben.page.keyboard.press("Escape");
  await expect(rules).toBeHidden();

  // On a phone the chip shares the round's line.
  await cleo.page.setViewportSize({ width: 360, height: 780 });
  await expect(cleo.page.locator("[data-round-anonymous]")).toBeVisible();
  await cleo.page
    .locator("[data-round-subject]")
    .evaluate((line) => line.scrollIntoView({ block: "start" }));
  await cleo.page.screenshot({ path: `${SHOTS}round-anonymous-360-light.png` });
  await ben.context.close();
  await cleo.context.close();
});

test("the panel opens at its top and no focused control hides under its title", async ({
  browser,
}) => {
  test.setTimeout(120_000);
  // An iPhone SE on its side, and a short desktop window.
  for (const size of [
    { width: 667, height: 375 },
    { width: 1024, height: 400 },
  ]) {
    const { context, page, errors } = await phone(browser, size);
    await createRoom(page);
    await join(page, "Pia");
    const { dialog } = await openByKeyboard(page, "Room settings");
    expect(await dialog.evaluate((element) => element.scrollTop)).toBe(0);
    await expect(dialog.locator("[data-settings-group='cards']")).toBeInViewport();
    const focusables = await dialog
      .locator("button, [role=switch], [tabindex]:not([tabindex='-1'])")
      .count();
    for (const key of ["Shift+Tab", "Tab"]) {
      for (let i = 0; i <= focusables; i++) {
        const place = await page.evaluate(() => {
          const focused = document.activeElement;
          const sheet = document.querySelector("[role=dialog]");
          const head = sheet?.querySelector("[data-panel-head]");
          if (!(focused instanceof HTMLElement) || !sheet || !head) return null;
          const box = focused.getBoundingClientRect();
          return {
            inHead: head.contains(focused),
            top: box.top,
            bottom: box.bottom,
            headBottom: head.getBoundingClientRect().bottom,
            sheetBottom: sheet.getBoundingClientRect().bottom,
            name: `${focused.tagName} ${focused.getAttribute("aria-label") ?? focused.textContent}`,
          };
        });
        expect(place, `${size.width} x ${size.height}, ${key} ${i}`).not.toBeNull();
        if (place && !place.inHead) {
          expect(
            place.top,
            `${place.name} at ${size.width} x ${size.height}`,
          ).toBeGreaterThanOrEqual(place.headBottom - 1);
          expect(
            place.bottom,
            `${place.name} at ${size.width} x ${size.height}`,
          ).toBeLessThanOrEqual(place.sheetBottom + 1);
        }
        await page.keyboard.press(key);
        await page.waitForTimeout(50);
      }
    }
    expect(errors).toEqual([]);
    await context.close();
  }
});

test("the settings button is an icon below 900 px, and the sheet fades in place with reduced motion", async ({
  page,
}) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 800, height: 700 });
  await createRoom(page);
  await join(page, "Pia");
  const button = page.getByRole("button", { name: "Room settings" });
  const box = await button.boundingBox();
  expect(box && Math.round(box.width)).toBe(44);
  expect(box && Math.round(box.height)).toBe(44);
  await expect(button.getByText("Room settings")).toHaveClass(/sr-only/);
  // Still labelled at 901 px.
  await page.setViewportSize({ width: 901, height: 700 });
  expect((await button.boundingBox())?.width).toBeGreaterThan(44);

  await page.emulateMedia({ reducedMotion: "reduce" });
  const { dialog } = await openByKeyboard(page, "Room settings");
  const travel = await dialog.evaluate((element) => {
    const style = getComputedStyle(element);
    return [
      style.getPropertyValue("--tw-enter-translate-x").trim(),
      style.getPropertyValue("--tw-enter-opacity").trim(),
    ];
  });
  expect(travel).toEqual(["0", "0"]);
});
