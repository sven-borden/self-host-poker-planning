import { audit, reportFindings } from "./a11y.ts";
import { expect, test } from "./fixtures.ts";
import {
  createRoom,
  type Guest,
  guestsJoin,
  handCard,
  join,
  newGuest,
  newPerson,
  sameUser,
} from "./support.ts";

// axe over every screen a person meets (#37): WCAG 2.2 A and AA, light and dark, a
// desktop and a phone (`audit` in a11y.ts). The gate is zero serious or critical
// violations; lesser ones are printed and attached to the report.

reportFindings();

/** Well-formed, and absent from a fresh database. */
const UNKNOWN = "Unknown123";
/** The room route's split chunk, which a test breaks to reach the error page. */
const ROOM_CHUNK = /\/assets\/_code-[\w-]+\.js$/;

const results = (page: import("@playwright/test").Page) =>
  page.getByRole("region", { name: "Results" });

test("the landing page, the not-found page and the error page", async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Create the room" })).toBeVisible();
  await audit(page, "landing");

  await page.goto(`/r/${UNKNOWN}`);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Room not found");
  await audit(page, "not found");

  await page.route(ROOM_CHUNK, (route) => route.abort());
  await page.goto(`/r/${UNKNOWN}`);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Something went wrong", {
    timeout: 15_000,
  });
  await audit(page, "error");
});

test("the room: join screen, voting, revealed, the decision bar, settings, rules and history", async ({
  page,
  browser,
  baseURL,
}) => {
  test.setTimeout(300_000);
  const base = baseURL ?? "";
  const code = await createRoom(page);
  const ben = await newPerson(browser);
  let guests: Guest[] = [];
  try {
    await ben.page.goto(page.url());
    await expect(ben.page.getByRole("textbox", { name: "Your name" })).toBeVisible();
    await audit(ben.page, "join screen");
    await ben.page.getByRole("button", { name: "Choose an avatar" }).click();
    await expect(ben.page.getByRole("radio", { name: "Tiger" })).toBeAttached();
    await audit(ben.page, "avatar picker");
    await ben.page.getByRole("button", { name: "Choose an avatar" }).click();

    await join(page, "Ana");
    await join(ben.page, "Ben");
    guests = await guestsJoin(base, code, ["Cleo"]);
    await page.getByRole("button", { name: "Start voting" }).click();
    await expect(handCard(ben.page, "8")).toBeVisible();
    await handCard(page, "5").click();
    await handCard(ben.page, "5").click();
    await expect(page.locator("[data-table-live]")).toContainText("voted");
    await audit(page, "voting, PO");
    await audit(ben.page, "voting, voter");

    // Cleo has not voted, so the reveal is the PO's (a third vote would reveal by itself).
    await page.getByRole("button", { name: "Reveal cards" }).click();
    await expect(results(page)).toBeVisible();
    await expect(page.getByRole("button", { name: "Record 5" })).toBeVisible();
    await audit(page, "revealed, PO with the decision bar");
    await audit(ben.page, "revealed, voter");

    await page.getByRole("button", { name: "Room settings" }).click();
    await expect(page.getByRole("dialog", { name: "Room settings" })).toBeVisible();
    await audit(page, "settings panel, PO");
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog", { name: "Room settings" })).toBeHidden();

    await ben.page.getByRole("button", { name: "Room rules" }).click();
    await expect(ben.page.getByRole("dialog", { name: "Room rules" })).toBeVisible();
    await audit(ben.page, "room rules, voter");
    await ben.page.keyboard.press("Escape");

    await page.locator("[data-sound]").click();
    await page.getByRole("switch", { name: "Play sound effects" }).click();
    await audit(page, "sound panel, on");
    await page.getByRole("switch", { name: "Play background music" }).click();
    await expect(page.getByRole("radio", { name: "Tide" })).toBeEnabled();
    await audit(page, "sound panel, music on");
    await page.getByRole("switch", { name: "Play background music" }).click();
    await page.getByRole("switch", { name: "Play sound effects" }).click();
    await audit(page, "sound panel, off");
    await page.keyboard.press("Escape");

    await page.getByRole("button", { name: "Record 5" }).click();
    await expect(page.getByRole("button", { name: "Recorded" })).toBeVisible();
    await page.getByRole("button", { name: "Next round" }).click();
    await expect(page.locator("[data-centre] [data-centre-status]")).toHaveText("0/3 voted so far");

    await page.getByRole("button", { name: "History" }).click();
    const panel = page.getByRole("dialog", { name: "History" });
    await panel.getByRole("button", { name: "Votes of round 1" }).click();
    await expect(panel.locator("[data-history-vote]").first()).toBeVisible();
    await audit(page, "history with a round opened");
  } finally {
    for (const guest of guests) guest.close();
    await ben.context.close();
  }
});

test("the queue: the sheet, the line under the table and the countdown", async ({
  page,
  browser,
}) => {
  test.setTimeout(240_000);
  await createRoom(page);
  await join(page, "Ana");
  const ben = await newPerson(browser);
  try {
    await ben.page.goto(page.url());
    await join(ben.page, "Ben");
    await page.locator("[data-queue-open]").click();
    const sheet = page.getByRole("dialog", { name: "Queue" });
    await expect(sheet.getByText("Nothing in the queue yet.")).toBeVisible();
    await audit(page, "queue sheet, empty");
    await sheet
      .getByRole("textbox", { name: "Paste your tickets" })
      .fill(
        "PAY-1 Checkout fails on expired card\nhttps://acme.atlassian.net/browse/PAY-2 Refund\nA plain line\nPAY-1 Again",
      );
    await sheet.getByRole("button", { name: "Add to the queue" }).click();
    await expect(sheet.locator("[data-queue-item]")).toHaveCount(3);
    await audit(page, "queue sheet, with items");
    await sheet.getByRole("button", { name: "Clear the queue" }).click();
    await expect(sheet.getByRole("button", { name: "Keep them" })).toBeVisible();
    await audit(page, "queue sheet, asking to clear");
    await sheet.getByRole("button", { name: "Keep them" }).click();
    await page.keyboard.press("Escape");

    await page.getByRole("button", { name: "Room settings" }).click();
    await page.getByRole("switch", { name: "Start the next item by itself" }).click();
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Start voting" }).click();
    await handCard(page, "5").click();
    await handCard(ben.page, "5").click();
    await expect(page.getByRole("button", { name: "Record 5" })).toBeVisible();
    await expect(page.locator("[data-next-up]")).toBeVisible();
    await audit(page, "next up, PO");
    await audit(ben.page, "next up, voter");
    await page.getByRole("button", { name: "Record 5" }).click();
    await page.getByRole("button", { name: "Stay on this round" }).focus();
    await page.getByRole("button", { name: "Stay on this round" }).click();
    await expect(page.getByRole("button", { name: "Stay on this round" })).toHaveCount(0);
    await audit(page, "next up, held");
  } finally {
    await ben.context.close();
  }
});

test("the room-full page", async ({ page, browser, baseURL }) => {
  test.setTimeout(120_000);
  const base = baseURL ?? "";
  const code = await createRoom(page);
  await join(page, "Ana");
  const owner = await sameUser(base, page.context());
  const guests: Guest[] = [];
  const late = await newPerson(browser);
  try {
    expect(await owner.enter(code)).toMatchObject({ ok: true });
    for (let i = 2; i <= 16; i++) {
      const guest = await newGuest(base);
      guests.push(guest);
      expect(await guest.enter(code)).toMatchObject({ ok: true });
      expect(await guest.cmd("join", { name: `Person ${i}`, role: "voter" })).toMatchObject({
        ok: true,
      });
    }
    await late.page.goto(page.url());
    await expect(late.page.getByRole("heading", { name: "This room is full" })).toBeVisible();
    await audit(late.page, "room full");
  } finally {
    owner.close();
    for (const guest of guests) guest.close();
    await late.context.close();
  }
});
