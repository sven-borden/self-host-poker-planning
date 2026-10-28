import { type Browser, expect, type Page, test } from "@playwright/test";
import {
  animated,
  createRoom,
  handCard,
  hand as handOf,
  historyOf,
  join,
  newPerson,
  ownAddress,
  phone,
  recordAnimations,
  seats,
  shoot,
} from "./support.ts";

// A change after the reveal (#29) in real browsers, against the real server and Postgres:
// the PO allows it after a reveal, a voter changes their card, and everyone sees the
// "changed" chip and the new results while the PO's recorded final stays, with the bar's
// note; the history row follows. An anonymous round's hand stays disabled, the switch
// locked. A change by keyboard alone, on a phone too, and no turn under reduced motion.
// Needs DATABASE_URL; skipped without it locally, failing without it in CI.

test.skip(
  !process.env.DATABASE_URL && !process.env.CI,
  "needs DATABASE_URL: runs against the real server",
);
test.beforeAll(() => {
  if (!process.env.DATABASE_URL) {
    throw new Error("CI must run the change-after-reveal tests: set DATABASE_URL");
  }
});
test.beforeEach(async ({ page }) => {
  await page.setExtraHTTPHeaders(ownAddress());
});

const status = (page: Page) => page.locator("[data-centre] [data-centre-status]");
const tableLive = (page: Page) => page.locator("[data-table-live]");
const handLive = (page: Page) => page.locator("[data-hand-live]");
const hint = (page: Page) => page.locator("[data-hand-hint]");
const note = (page: Page) => page.locator("[data-decision-note]");
const chips = (page: Page) => page.locator("[data-slot-card] [data-changed-chip]");
const settingsPanel = (page: Page) => page.getByRole("dialog", { name: "Room settings" });
const changeSwitch = (page: Page) =>
  settingsPanel(page).getByRole("switch", { name: "Change a vote after the reveal" });
const settingRow = (page: Page, key: string) =>
  settingsPanel(page).locator(`[data-setting="${key}"]`);

const REVEALED_HINT = "The cards are revealed. Votes can no longer change in this round.";

async function openSettings(page: Page) {
  await page.getByRole("button", { name: "Room settings" }).click();
  const dialog = settingsPanel(page);
  await expect(dialog).toBeVisible();
  await dialog.evaluate((element) =>
    Promise.all(element.getAnimations().map((animation) => animation.finished)),
  );
}

async function closeSettings(page: Page) {
  await page.keyboard.press("Escape");
  await expect(settingsPanel(page)).toBeHidden();
}

/** In the open panel: flips a switch and waits for the server to confirm it. */
async function flip(page: Page, name: string, key: string, on: boolean) {
  const control = settingsPanel(page).getByRole("switch", { name });
  await control.click();
  await expect(control).toHaveAttribute("aria-checked", String(on));
  await expect(settingRow(page, key)).not.toHaveAttribute("data-pending", "true");
}

async function person(browser: Browser, url: string, name: string) {
  const someone = await newPerson(browser);
  await someone.page.goto(url);
  await join(someone.page, name);
  return someone;
}

test("the PO allows changes after a reveal: Ben changes his card, everyone sees the chip and the new results, the final stays", async ({
  page,
  browser,
}) => {
  test.setTimeout(150_000);
  const code = await createRoom(page);
  await join(page, "Pia");
  const ben = await person(browser, page.url(), "Ben");
  try {
    await page.getByRole("button", { name: "Start voting" }).click();
    await handCard(page, "5").click();
    await handCard(ben.page, "5").click();
    for (const viewer of [page, ben.page]) {
      await expect(status(viewer)).toHaveAttribute("data-centre-status", "revealed");
    }
    // Off by default: the hand stays disabled after the reveal.
    await expect(hint(ben.page)).toHaveText(REVEALED_HINT);
    await expect(handCard(ben.page, "13")).toHaveAttribute("aria-disabled", "true");
    // Pia records the consensus.
    await page.getByRole("button", { name: "Record 5" }).click();
    await expect(page.getByRole("button", { name: "Recorded" })).toBeVisible();

    // She allows changes: it applies at once, to the round on the table.
    await openSettings(page);
    await expect(changeSwitch(page)).toHaveAttribute("aria-checked", "false");
    await flip(page, "Change a vote after the reveal", "allowChangeAfterReveal", true);
    await closeSettings(page);
    await expect(tableLive(ben.page)).toHaveText("Votes can now change after the reveal.");
    await expect(hint(ben.page)).toHaveText("You can still change your card.");
    await expect(handCard(ben.page, "13")).not.toHaveAttribute("aria-disabled", "true");

    await recordAnimations(page);
    await handCard(ben.page, "13").click();
    await expect(handLive(ben.page)).toHaveText("You changed your card: 13.");
    await expect(handCard(ben.page, "13")).toHaveAttribute("aria-pressed", "true");
    // Everyone sees the chip, the seat says it, and the results follow: 5 and 13 suggest 8.
    for (const viewer of [page, ben.page]) {
      await expect(chips(viewer)).toHaveText(["changed"]);
      await expect(status(viewer)).toContainText("Suggested 8");
    }
    await expect(
      seats(page).getByRole("button", {
        name: "Ben, card 13, highest card, changed after the reveal",
      }),
    ).toBeVisible();
    await expect(tableLive(page)).toContainText(
      "Ben changed their card: 13. Suggested 8. Agreement 50%.",
    );
    // His card turned over to its new value.
    const turned = (await animated(page)).filter(
      (a) => a.target === "up" && a.keyframes.includes("rotateY"),
    );
    expect(turned).toHaveLength(1);

    // The final is the PO's: it stays, and her bar says the votes moved.
    await expect(page.locator("[data-centre-final]")).toContainText("Final estimate: 5.");
    await expect(note(page)).toHaveText("Votes changed since you recorded 5.");
    await expect(page.getByRole("button", { name: "Record 8" })).toHaveAccessibleDescription(
      "Votes changed since you recorded 5.",
    );
    // The history row follows the change, the final kept (AC 2).
    await expect
      .poll(async () => (await historyOf(code))[0]?.votes)
      .toMatchObject({
        kind: "named",
        votes: expect.arrayContaining([
          expect.objectContaining({ name: "Ben", card: "13", changedAfterReveal: true }),
        ]),
      });
    await shoot(page, "change-after-reveal-po");
    await shoot(ben.page, "change-after-reveal-voter");

    // Pressing his card again takes nothing back.
    await ben.page.setViewportSize({ width: 1280, height: 720 });
    await handCard(ben.page, "13").click();
    await ben.page.waitForTimeout(400);
    await expect(handCard(ben.page, "13")).toHaveAttribute("aria-pressed", "true");
    await expect(status(page)).toContainText("Suggested 8");

    // Pia records the new suggestion: the note goes.
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.getByRole("button", { name: "Record 8" }).click();
    await expect(page.locator("[data-centre-final]")).toContainText("Final estimate: 8.");
    await expect(note(page)).toHaveCount(0);

    // She turns changes off: Ben's hand stops at once, the chip stays.
    await openSettings(page);
    await flip(page, "Change a vote after the reveal", "allowChangeAfterReveal", false);
    await closeSettings(page);
    await expect(hint(ben.page)).toHaveText(REVEALED_HINT);
    await expect(chips(ben.page)).toHaveText(["changed"]);
  } finally {
    await ben.context.close();
  }
});

test("an anonymous round's votes stay put: the switch is locked and the hand disabled", async ({
  page,
  browser,
}) => {
  test.setTimeout(120_000);
  await createRoom(page);
  await join(page, "Pia");
  const ben = await person(browser, page.url(), "Ben");
  try {
    await openSettings(page);
    await flip(page, "Change a vote after the reveal", "allowChangeAfterReveal", true);
    await flip(page, "Anonymous voting", "revealNames", true);
    const lock = settingRow(page, "allowChangeAfterReveal").locator("[data-setting-locked]");
    await expect(lock).toHaveText("Anonymous rounds lock their votes at the reveal.");
    await expect(changeSwitch(page)).toHaveAttribute("aria-disabled", "true");
    await changeSwitch(page).click({ force: true });
    await expect(changeSwitch(page)).toHaveAttribute("aria-checked", "true");
    await closeSettings(page);

    await page.getByRole("button", { name: "Start voting" }).click();
    await handCard(page, "5").click();
    await handCard(ben.page, "8").click();
    await expect(status(ben.page)).toHaveAttribute("data-centre-status", "revealed");
    await expect(hint(ben.page)).toHaveText(REVEALED_HINT);
    await expect(handCard(ben.page, "13")).toHaveAttribute("aria-disabled", "true");
    await handCard(ben.page, "13").click({ force: true });
    await ben.page.waitForTimeout(400);
    await expect(handCard(ben.page, "8")).toHaveAttribute("aria-pressed", "true");
    await expect(handLive(ben.page)).not.toContainText("changed");
    await expect(chips(page)).toHaveCount(0);
  } finally {
    await ben.context.close();
  }
});

test("a change by keyboard alone, on a phone too, with no turn under reduced motion", async ({
  page,
  browser,
}) => {
  test.setTimeout(120_000);
  await createRoom(page);
  await join(page, "Pia");
  // A phone as tall as an iPhone 13's screen: the browser's own bars leave an emulated
  // iPhone 13 too short for the hand to dock under two seats and the result.
  const ana = await phone(browser, { width: 390, height: 844 });
  try {
    await ana.page.emulateMedia({ reducedMotion: "reduce" });
    await ana.page.goto(page.url());
    await join(ana.page, "Ana");
    await openSettings(page);
    await flip(page, "Change a vote after the reveal", "allowChangeAfterReveal", true);
    await closeSettings(page);
    await page.getByRole("button", { name: "Start voting" }).click();
    await handCard(page, "3").click();
    await handCard(ana.page, "5").tap();
    await expect(status(ana.page)).toHaveAttribute("data-centre-status", "revealed");
    await expect(hint(ana.page)).toHaveText("You can still change your card.");
    // Her hand docks on the phone after the reveal while she may change, as while voting.
    await ana.page.evaluate(() => window.scrollTo(0, 0));
    await expect(ana.page.locator("[data-room-hand]")).toHaveAttribute("data-hand-dock", "true");

    // Keyboard only, Ana on her phone: to her card, an arrow, Enter.
    await recordAnimations(ana.page);
    await handCard(ana.page, "5").focus();
    await ana.page.keyboard.press("ArrowRight");
    await expect(handCard(ana.page, "8")).toBeFocused();
    // The page put the focus there: Enter waits out the guard.
    await ana.page.waitForTimeout(400);
    await ana.page.keyboard.press("Enter");
    await expect(handLive(ana.page)).toHaveText("You changed your card: 8.");
    await expect(chips(ana.page)).toHaveText(["changed"]);
    await expect(tableLive(page)).toContainText("Ana changed their card: 8.");
    // Under reduced motion the new value replaces the old without a turn.
    await expect(ana.page.locator("[data-slot-card][data-you] [data-face='up']")).toHaveText("8");
    expect((await animated(ana.page)).filter((a) => a.keyframes.includes("rotateY"))).toEqual([]);

    // Pia, keyboard only on her desktop: to her card, an arrow, Space.
    await handCard(page, "3").focus();
    await page.keyboard.press("ArrowLeft");
    await expect(handCard(page, "2")).toBeFocused();
    await page.waitForTimeout(400);
    await page.keyboard.press("Space");
    await expect(handLive(page)).toHaveText("You changed your card: 2.");
    await expect(handOf(page).getByRole("button", { pressed: true })).toHaveAccessibleName("2");
    await expect(tableLive(ana.page)).toContainText("Pia changed their card: 2.");
    await expect(chips(page)).toHaveCount(2);
  } finally {
    await ana.context.close();
  }
});
