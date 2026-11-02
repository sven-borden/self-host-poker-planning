import { expect, type Page, test } from "./fixtures.ts";
import {
  createRoom,
  handCard,
  join,
  newPerson,
  ownAddress,
  phone,
  shoot,
  subjectField,
  subjectLine,
} from "./support.ts";

// The backlog queue (#52) in real browsers, against the real server and Postgres: a pasted
// table becomes a queue, "Next item" walks through it, a typed subject and "Vote again"
// leave it alone, the keyboard and the grip reorder it, and auto-advance counts down for
// everyone. No request ever leaves for a pasted link. Needs DATABASE_URL.

test.skip(
  !process.env.DATABASE_URL && !process.env.CI,
  "needs DATABASE_URL: runs against the real server",
);
test.beforeEach(async ({ page }) => {
  await page.setExtraHTTPHeaders(ownAddress());
});

const JIRA_TABLE = [
  "T\tKey\tSummary\tAssignee\tStatus",
  "\tPAY-1\tCheckout fails on expired card\tAna\tTo Do",
  "\tPAY-2\tRefund email shows the wrong currency\tBen\tTo Do",
  "\tPAY-3\tLogin keeps the language\tBen\tTo Do",
].join("\n");

const sheet = (page: Page) => page.getByRole("dialog", { name: "Queue" });
const nextUp = (page: Page) => page.locator("[data-next-up]");

async function openQueue(page: Page) {
  await page.locator("[data-queue-open]").click();
  await expect(sheet(page)).toBeVisible();
}

async function paste(page: Page, text: string) {
  await sheet(page).getByRole("textbox", { name: "Paste your tickets" }).fill(text);
  await sheet(page).getByRole("button", { name: "Add to the queue" }).click();
}

async function closeQueue(page: Page) {
  await page.keyboard.press("Escape");
  await expect(sheet(page)).toBeHidden();
}

const rows = (page: Page) => sheet(page).locator("[data-queue-item]");

/** Two people with cards down: the last vote reveals the round. */
async function voteAll(ana: Page, ben: Page) {
  await handCard(ana, "5").click();
  await handCard(ben, "5").click();
  await expect(ana.getByRole("button", { name: "Record 5" })).toBeVisible();
}

test("a pasted table, next items, a typed subject and vote again", async ({ page, browser }) => {
  test.setTimeout(120_000);
  await createRoom(page);
  await join(page, "Ana");
  const ben = await newPerson(browser);
  const asked: string[] = [];
  for (const person of [page, ben.page]) {
    person.on("request", (request) => asked.push(request.url()));
  }
  try {
    await ben.page.goto(page.url());
    await join(ben.page, "Ben");
    // Only the PO has the queue, and an empty one shows nothing to anyone else.
    await expect(ben.page.locator("[data-queue-open]")).toHaveCount(0);

    await openQueue(page);
    await expect(sheet(page).getByText("Nothing in the queue yet.")).toBeVisible();
    await paste(page, `${JIRA_TABLE}\nhttps://acme.atlassian.net/browse/PAY-3`);
    await expect(sheet(page).locator("[data-queue-report]")).toHaveText(
      "3 items added. 1 duplicate dropped.",
    );
    await expect(rows(page)).toHaveCount(3);
    await expect(rows(page).first()).toContainText("PAY-1");
    await expect(rows(page).first()).toContainText("Checkout fails on expired card");
    await closeQueue(page);
    await expect(page.locator("[data-queue-count]")).toHaveText("3");
    await expect(ben.page.locator("[data-table-live]")).toContainText(
      "3 items added to the queue. Next: PAY-1.",
    );

    // The empty field means the next item.
    await page.getByRole("button", { name: "Start voting" }).click();
    await expect(subjectLine(ben.page)).toContainText("PAY-1 Checkout fails on expired card");
    await expect(page.locator("[data-queue-count]")).toHaveText("2");
    await expect(nextUp(ben.page)).toHaveCount(0);

    await voteAll(page, ben.page);
    await expect(nextUp(ben.page)).toHaveText("Next: PAY-2");

    // Vote again keeps the subject and takes no item.
    await page.getByRole("button", { name: "Vote again" }).click();
    await expect(subjectLine(ben.page)).toContainText("PAY-1");
    await expect(page.locator("[data-queue-count]")).toHaveText("2");
    await voteAll(page, ben.page);

    // A typed subject goes first and takes no item either.
    await subjectField(page).fill("By hand");
    await expect(page.getByRole("button", { name: "Next round" })).toBeVisible();
    await page.getByRole("button", { name: "Next round" }).click();
    await expect(subjectLine(ben.page)).toContainText("By hand");
    await expect(page.locator("[data-queue-count]")).toHaveText("2");
    await voteAll(page, ben.page);

    await page.getByRole("button", { name: "Record 5" }).click();
    await page.getByRole("button", { name: "Next item" }).click();
    await expect(subjectLine(ben.page)).toContainText("PAY-2");
    await expect(page.locator("[data-queue-count]")).toHaveText("1");

    // Nothing ever asked for a pasted link.
    expect(asked.filter((url) => url.includes("atlassian"))).toEqual([]);
  } finally {
    await ben.context.close();
  }
});

test("reordering by keyboard and by the grip, removing, clearing", async ({ page }) => {
  test.setTimeout(60_000);
  await createRoom(page);
  await join(page, "Ana");
  await openQueue(page);
  await paste(page, "AB-1 One\nAB-2 Two\nAB-3 Three\nAB-4 Four");
  await expect(rows(page)).toHaveCount(4);

  const down = sheet(page).getByRole("button", { name: "Move AB-1 down" });
  await down.focus();
  await page.keyboard.press("Enter");
  await expect(rows(page).first()).toContainText("AB-2");
  await expect(down).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(rows(page).nth(2)).toContainText("AB-1");
  await expect(sheet(page).locator("[data-queue-live]")).toHaveText("AB-1 is now number 3 of 4.");

  const grip = rows(page).nth(3).locator("[data-queue-grip]");
  const target = await rows(page).first().boundingBox();
  const from = await grip.boundingBox();
  if (!target || !from) throw new Error("no layout");
  await page.mouse.move(from.x + 8, from.y + 8);
  await page.mouse.down();
  await page.mouse.move(from.x + 8, target.y + 10, { steps: 6 });
  await page.mouse.up();
  await expect(rows(page).first()).toContainText("AB-4");

  await page.reload();
  await expect(page.locator("[data-queue-count]")).toHaveText("4");
  await openQueue(page);
  await expect(rows(page).first()).toContainText("AB-4");

  await sheet(page).getByRole("button", { name: "Remove AB-4" }).click();
  await expect(rows(page)).toHaveCount(3);
  await sheet(page).getByRole("button", { name: "Clear the queue" }).click();
  await sheet(page).getByRole("button", { name: "Remove all" }).click();
  await expect(sheet(page).getByText("Nothing in the queue yet.")).toBeVisible();
  await closeQueue(page);
  await expect(page.locator("[data-queue-count]")).toHaveCount(0);
});

test("auto-advance counts down for everyone, the PO can stay, and the next item starts once", async ({
  page,
  browser,
}) => {
  test.setTimeout(90_000);
  await createRoom(page);
  await join(page, "Ana");
  const ben = await newPerson(browser);
  try {
    await ben.page.goto(page.url());
    await join(ben.page, "Ben");
    await openQueue(page);
    await paste(page, "AB-1\nAB-2");
    await expect(rows(page)).toHaveCount(2);
    await closeQueue(page);
    await page.getByRole("button", { name: "Room settings" }).click();
    await page.getByRole("switch", { name: "Start the next item by itself" }).click();
    await expect(ben.page.locator("[data-table-live]")).toContainText(
      "The next item now starts by itself",
    );
    await page.keyboard.press("Escape");

    await page.getByRole("button", { name: "Start voting" }).click();
    await voteAll(page, ben.page);
    // Nothing runs before a final.
    await expect(nextUp(ben.page)).toHaveText("Next: AB-2");
    await page.getByRole("button", { name: "Record 5" }).click();
    await expect(nextUp(ben.page)).toContainText(/Next: AB-2, in \d+ s/);
    await expect(ben.page.locator("[data-table-live]")).toContainText("Next in 10 seconds: AB-2.");
    await expect(ben.page.locator("[data-hold-advance]")).toHaveCount(0);

    // The PO stays: the countdown is gone, for everyone, and nothing starts.
    await page.getByRole("button", { name: "Stay on this round" }).click();
    await expect(nextUp(ben.page)).toHaveText("Next: AB-2");
    await expect(ben.page.locator("[data-table-live]")).toContainText(
      "The room stays on this round.",
    );

    // A new final starts it again, and at its end the round starts, with no press.
    await page.locator("[data-final-card='8'] input").check();
    await page.getByRole("button", { name: "Record 8" }).click();
    await expect(nextUp(ben.page)).toContainText("in");
    await expect(subjectLine(ben.page)).toContainText("AB-2", { timeout: 14_000 });
    await expect(page.locator("[data-queue-count]")).toHaveCount(0);
    await expect(page.locator("[data-centre-status='voting']")).toBeVisible();
    await expect(handCard(ben.page, "5")).toBeEnabled();
  } finally {
    await ben.context.close();
  }
});

test("the sheet at 320 px: no sideways scroll, and every action within reach", async ({
  browser,
}) => {
  test.setTimeout(60_000);
  const person = await phone(browser, { width: 320, height: 640 });
  const { page } = person;
  try {
    await createRoom(page);
    await join(page, "Ana");
    await openQueue(page);
    const long = "A title long enough to wrap around in a narrow sheet, twice or more over";
    await paste(
      page,
      `AB-1 ${long}\nAB-2 ${long}\nhttps://example.com/a/very/long/link/${"x".repeat(80)}`,
    );
    await expect(rows(page)).toHaveCount(3);
    const overflow = await sheet(page).evaluate((box) => box.scrollWidth - box.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    const remove = sheet(page).getByRole("button", { name: "Remove AB-1" });
    const box = await remove.boundingBox();
    expect(box?.height).toBeGreaterThanOrEqual(44);
    expect(box?.width).toBeGreaterThanOrEqual(44);
    await shoot(page, "queue-320");
    await sheet(page).getByRole("button", { name: "Move AB-1 down" }).click();
    await expect(rows(page).first()).toContainText("AB-2");
  } finally {
    await person.context.close();
  }
});
