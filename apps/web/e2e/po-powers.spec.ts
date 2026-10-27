import { type Browser, expect, type Page, test } from "@playwright/test";
import {
  createRoom,
  dbQuery,
  hand,
  join,
  newGuest,
  newPerson,
  observerRow,
  ownAddress,
  phone,
  sameUser,
  seats,
  shoot,
  subjectField,
} from "./support.ts";

// The PO's powers (#30) in real browsers, against the real server and Postgres: the PO
// hands the role over and takes it back; someone claims it at once when the PO left, and
// two minutes after the PO went away (the absence is aged in Postgres, the real 15 s
// grace first); the PO removes someone, whose page shows the join form within 1 s and who
// joins again; the PO's flow by keyboard only, on a desktop and on a phone; and a PO who
// does not vote has no hand and no count, whoever holds the role. Screenshots of the
// popover, both questions, the claim banner and the removed person's notice. Needs
// DATABASE_URL; skipped without it locally, failing without it in CI.

test.skip(
  !process.env.DATABASE_URL && !process.env.CI,
  "needs DATABASE_URL: runs against the real server",
);
test.beforeAll(() => {
  if (!process.env.DATABASE_URL) {
    throw new Error("CI must run the PO's powers: set DATABASE_URL");
  }
});
test.beforeEach(async ({ page }) => {
  await page.setExtraHTTPHeaders(ownAddress());
});

const live = (page: Page) => page.locator("[data-table-live]");
const popover = (page: Page) => page.getByRole("dialog");
/** A person's button, on a seat or in the observers' row, by the name it starts with. */
const personButton = (page: Page, name: string) =>
  page.locator("[data-room-table]").getByRole("button", { name: new RegExp(`^${name}(,|$)`) });
const claimButton = (page: Page) =>
  page.getByRole("button", { name: "Claim the product owner role" });
const settingsButton = (page: Page) => page.getByRole("button", { name: "Room settings" });

async function person(browser: Browser, url: string, name: string, role?: "Observer") {
  const { context, page } = await newPerson(browser);
  await page.goto(url);
  await join(page, name, role);
  return { context, page };
}

/** The live region says `sentence` once. */
async function saidOnce(page: Page, sentence: string) {
  await expect(live(page)).toContainText(sentence);
  const text = (await live(page).textContent()) ?? "";
  expect(text.split(sentence).length - 1, `"${sentence}" in "${text}"`).toBe(1);
}

/** Opens `name`'s popover and confirms an action in it, by pointer. */
async function act(page: Page, name: string, action: string, confirm: string) {
  await personButton(page, name).click();
  await popover(page).getByRole("button", { name: action }).click();
  await popover(page).getByRole("button", { name: confirm, exact: true }).click();
}

/** Whether the PO's controls are on `page`: the settings button and the subject field. */
async function expectOwner(page: Page, owner: boolean) {
  await expect(settingsButton(page)).toHaveCount(owner ? 1 : 0);
  await expect(page.getByRole("button", { name: "Room rules" })).toHaveCount(owner ? 0 : 1);
  await expect(subjectField(page)).toHaveCount(owner ? 1 : 0);
}

/** Tabs forward until the focus is on `name`'s button. */
async function tabTo(page: Page, name: string) {
  for (let i = 0; i < 80; i++) {
    await page.keyboard.press("Tab");
    const there = await page.evaluate((who) => {
      const active = document.activeElement;
      return (
        active?.hasAttribute("data-person-trigger") === true &&
        (active.textContent ?? "").trim().startsWith(who)
      );
    }, name);
    if (there) return;
  }
  throw new Error(`Tab never reached ${name}'s button`);
}

const focusedText = (page: Page) => page.evaluate(() => document.activeElement?.textContent ?? "");

test("the PO hands the role over and takes it back; everyone hears it once", async ({
  page,
  browser,
}) => {
  test.setTimeout(90_000);
  await createRoom(page);
  await join(page, "Ana");
  const ben = await person(browser, page.url(), "Ben");
  const cleo = await person(browser, page.url(), "Cleo", "Observer");
  try {
    await expectOwner(page, true);
    await expectOwner(ben.page, false);
    // Nobody but the PO gets actions.
    await personButton(ben.page, "Ana").click();
    await expect(popover(ben.page)).toContainText("Product owner");
    await expect(popover(ben.page).getByRole("button")).toHaveCount(0);
    await ben.page.keyboard.press("Escape");

    await personButton(page, "Ben").click();
    await expect(popover(page).getByRole("button", { name: "Make product owner" })).toBeVisible();
    await expect(popover(page).getByRole("button", { name: "Remove from the room" })).toBeVisible();
    await shoot(page, "po-popover");
    await popover(page).getByRole("button", { name: "Make product owner" }).click();
    const question = popover(page).getByRole("group", {
      name: "Hand the product owner role to Ben? You become a voter.",
    });
    await expect(question).toBeFocused();
    await shoot(page, "po-hand-over-question");
    await question.getByRole("button", { name: "Hand over" }).click();
    await expect(popover(page)).toHaveCount(0);

    // The crown, the settings button, the subject field and the controls move at once.
    await expectOwner(ben.page, true);
    await expectOwner(page, false);
    await expect(personButton(page, "Ben")).toHaveAccessibleName(/product owner/);
    for (const viewer of [page, ben.page, cleo.page]) {
      await saidOnce(viewer, "Ana handed the product owner role to Ben.");
    }

    // Ben hands it back from Ana's seat.
    await act(ben.page, "Ana", "Make product owner", "Hand over");
    await expectOwner(page, true);
    await expectOwner(ben.page, false);
    for (const viewer of [page, ben.page, cleo.page]) {
      await saidOnce(viewer, "Ben handed the product owner role to Ana.");
    }
    // An observer can take the role too, from the row under the table.
    await act(page, "Cleo", "Make product owner", "Hand over");
    await expectOwner(cleo.page, true);
    await expect(observerRow(page)).toContainText("Product owner");
  } finally {
    await ben.context.close();
    await cleo.context.close();
  }
});

test("someone claims the role at once when the PO left", async ({ page, browser }) => {
  await createRoom(page);
  await join(page, "Ana");
  const ben = await person(browser, page.url(), "Ben");
  try {
    await expect(claimButton(ben.page)).toHaveCount(0);
    await page.getByRole("button", { name: "Leave the room" }).click();
    await expect(page.getByRole("button", { name: "Join the room" })).toBeVisible();
    await expect(ben.page.locator("[data-claim]")).toContainText(
      "The product owner is not in the room.",
    );
    await claimButton(ben.page).click();
    await expectOwner(ben.page, true);
    await expect(subjectField(ben.page)).toBeFocused();
    await saidOnce(ben.page, "Ben claimed the product owner role.");
    // Ana comes back as anyone else.
    await join(page, "Ana");
    await expectOwner(page, false);
    await expect(claimButton(page)).toHaveCount(0);
  } finally {
    await ben.context.close();
  }
});

test("someone claims the role two minutes after the PO went away, not before", async ({
  page,
  browser,
  baseURL,
}) => {
  test.setTimeout(90_000);
  const ana = await newPerson(browser);
  const code = await createRoom(ana.page);
  await join(ana.page, "Ana");
  await page.goto(ana.page.url());
  await join(page, "Ben");
  const cleo = await newGuest(baseURL ?? "");
  try {
    expect(await cleo.enter(code)).toMatchObject({ ok: true });
    expect(await cleo.cmd("join", { name: "Cleo", role: "voter" })).toMatchObject({ ok: true });

    // Ana closes her tab: away after the 15 s grace, and nobody may claim yet.
    await ana.context.close();
    await expect(seats(page).locator("[data-seat][data-away]")).toHaveCount(1, { timeout: 20_000 });
    await expect(claimButton(page)).toHaveCount(0);
    expect(await cleo.cmd("claimOwner")).toEqual({ ok: false, code: "owner_present" });

    // Two minutes pass: Ana's absence is aged in the room's stored state, and the next
    // change (Cleo renames) brings everyone a snapshot that says the role is free.
    await dbQuery(
      `update room set live = jsonb_set(live, array['participants', live->>'ownerId', 'awaySince'],
        to_jsonb((live->'participants'->(live->>'ownerId')->>'awaySince')::bigint - 120000))
      where code = $1`,
      [code],
    );
    expect(await cleo.cmd("rename", { name: "Cleo Two" })).toMatchObject({ ok: true });
    await expect(page.locator("[data-claim]")).toContainText("Ana, the product owner, is away.");
    await shoot(page, "po-claim-banner");
    await page.setViewportSize({ width: 1280, height: 900 });
    await claimButton(page).click();
    await expectOwner(page, true);
    // The first claim wins.
    expect(await cleo.cmd("claimOwner")).toEqual({ ok: false, code: "owner_present" });
    await saidOnce(page, "Ben claimed the product owner role.");
  } finally {
    cleo.close();
  }
});

test("the PO removes someone, whose page leaves the room within 1 s, and who joins again", async ({
  page,
  browser,
}) => {
  test.setTimeout(90_000);
  await createRoom(page);
  await join(page, "Ana");
  const ben = await person(browser, page.url(), "Ben");
  try {
    await personButton(page, "Ben").click();
    await popover(page).getByRole("button", { name: "Remove from the room" }).click();
    const question = popover(page).getByRole("group", {
      name: "Remove Ben from the room? They can join again with the link.",
    });
    await expect(question).toBeFocused();
    await shoot(page, "po-remove-question");
    await page.setViewportSize({ width: 1280, height: 900 });
    const removed = ben.page.getByRole("alert").filter({
      hasText: "The product owner removed you from this room.",
    });
    await question.getByRole("button", { name: "Remove", exact: true }).click();
    const sent = Date.now();
    await expect(removed).toBeVisible({ timeout: 1000 });
    expect(Date.now() - sent).toBeLessThan(1000);
    await expect(ben.page.getByRole("textbox", { name: "Your name" })).toBeFocused();
    await saidOnce(page, "The product owner removed Ben from the room.");
    await expect(personButton(page, "Ben")).toHaveCount(0);
    // The page stays connected: no error, the room live.
    await expect(ben.page.getByTestId("room-connection")).toHaveText("Connected");
    await shoot(ben.page, "po-removed-notice");

    // No ban: Ben joins again, and the notice goes.
    await ben.page.setViewportSize({ width: 1280, height: 900 });
    await join(ben.page, "Ben");
    await expect(removed).toHaveCount(0);
    await expect(personButton(page, "Ben")).toHaveCount(1);
  } finally {
    await ben.context.close();
  }
});

for (const where of ["desktop", "phone"] as const) {
  test(`the PO hands over and removes by keyboard only, on a ${where}`, async ({
    page,
    browser,
  }) => {
    test.setTimeout(90_000);
    const ana =
      where === "phone" ? await phone(browser, "Pixel 7") : { ...(await newPerson(browser)) };
    await createRoom(ana.page);
    await join(ana.page, "Ana");
    await page.goto(ana.page.url());
    await join(page, "Ben");
    try {
      // Ana hands the role to Ben: Tab to his seat, Enter, Enter, Tab, Enter.
      await ana.page.locator("body").focus();
      await tabTo(ana.page, "Ben");
      await ana.page.keyboard.press("Enter");
      await expect(
        popover(ana.page).getByRole("button", { name: "Make product owner" }),
      ).toBeFocused();
      await ana.page.keyboard.press("Enter");
      await expect(popover(ana.page).getByRole("group")).toBeFocused();
      await ana.page.keyboard.press("Tab");
      expect(await focusedText(ana.page)).toBe("Hand over");
      await ana.page.keyboard.press("Enter");
      await expectOwner(page, true);
      // The popover closed and the focus is back on Ben's seat.
      await expect(popover(ana.page)).toHaveCount(0);
      expect((await focusedText(ana.page)).trim().startsWith("Ben")).toBe(true);

      // Ben removes Ana: Tab to her seat, Enter, Tab to the action, Enter, Tab, Enter.
      await page.locator("body").focus();
      await tabTo(page, "Ana");
      await page.keyboard.press("Enter");
      await page.keyboard.press("Tab");
      await expect(
        popover(page).getByRole("button", { name: "Remove from the room" }),
      ).toBeFocused();
      await page.keyboard.press("Enter");
      await page.keyboard.press("Tab");
      expect(await focusedText(page)).toBe("Remove");
      await page.keyboard.press("Enter");
      await expect(ana.page.getByRole("textbox", { name: "Your name" })).toBeFocused();
      // Ben's focus went to the seat that took Ana's place: his own.
      await expect
        .poll(() => focusedText(page).then((text) => text.trim().startsWith("Ben")))
        .toBe(true);
    } finally {
      await ana.context.close();
    }
  });
}

test("a PO who does not vote has no hand and no count, and the hand follows a hand-over", async ({
  page,
  browser,
  baseURL,
  context,
}) => {
  const code = await createRoom(page);
  await join(page, "Ana");
  const ben = await person(browser, page.url(), "Ben");
  const anaSocket = await sameUser(baseURL ?? "", context);
  try {
    expect(await anaSocket.enter(code)).toMatchObject({ ok: true });
    expect(await anaSocket.cmd("updateSettings", { patch: { poVotes: false } })).toMatchObject({
      ok: true,
    });
    expect(await anaSocket.cmd("startRound", { subject: { kind: "none" } })).toMatchObject({
      ok: true,
    });
    const status = (p: Page) => p.locator("[data-centre] [data-centre-status]");
    await expect(
      page.getByText("As the product owner, you do not vote in this room."),
    ).toBeVisible();
    await expect(hand(page)).toHaveCount(0);
    await expect(status(ben.page)).toContainText("0/1 voted so far");
    await expect(personButton(ben.page, "Ana")).toHaveAccessibleName(/^Ana, product owner$/);

    await act(page, "Ben", "Make product owner", "Hand over");
    // Ben puts his cards down; Ana picks hers up; the count still holds one voter.
    await expect(hand(ben.page)).toHaveCount(0);
    await expect(
      ben.page.getByText("As the product owner, you do not vote in this room."),
    ).toBeVisible();
    await expect(hand(page)).toBeVisible();
    await expect(status(ben.page)).toContainText("0/1 voted so far");
    await expect(personButton(page, "Ana")).toHaveAccessibleName(/^Ana, you, thinking$/);
  } finally {
    anaSocket.close();
    await ben.context.close();
  }
});
