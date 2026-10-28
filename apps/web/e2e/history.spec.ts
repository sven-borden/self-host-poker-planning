import { expect, type Locator, type Page, test } from "./fixtures.ts";
import {
  createRoom,
  type Guest,
  guestsJoin,
  handCard,
  historyOf,
  join,
  newPerson,
  ownAddress,
  phone,
  SHOTS,
  sameUser,
  subjectField,
} from "./support.ts";

// The history panel (#33) in real browsers, against the real server and Postgres: three
// rounds (a title with a vote changed after the reveal and a final, its re-vote, and an
// anonymous Jira round), each in the panel with its subject, final, distribution, voting
// time and votes, names only where the round was named; a reload keeps them (AC 1); a
// round appears in an open panel once the next round starts; nobody on the join form gets
// the button; the panel by keyboard on a desktop and on a phone, with "Show earlier
// rounds"; and screenshots of the panel with rows, an open named and anonymous row, and
// the empty state. Needs DATABASE_URL; skipped without it locally, failing without it in CI.

test.skip(
  !process.env.DATABASE_URL && !process.env.CI,
  "needs DATABASE_URL: runs against the real server",
);
test.beforeAll(() => {
  if (!process.env.DATABASE_URL) {
    throw new Error("CI must run the history tests: set DATABASE_URL");
  }
});
test.beforeEach(async ({ page }) => {
  await page.setExtraHTTPHeaders(ownAddress());
});

const JIRA = "https://acme.atlassian.net/browse/PAY-482";

const historyButton = (page: Page) => page.getByRole("button", { name: "History" });
const panelOf = (page: Page) => page.getByRole("dialog", { name: "History" });
const rowsOf = (panel: Locator) => panel.locator("[data-history-round]");
const rowOf = (panel: Locator, number: number) => panel.locator(`[data-history-round="${number}"]`);
const numbersIn = (panel: Locator) =>
  rowsOf(panel).evaluateAll((rows) => rows.map((row) => Number(row.dataset.historyRound)));

async function openHistory(page: Page) {
  await historyButton(page).click();
  const panel = panelOf(page);
  await expect(panel.getByRole("heading", { name: "History" })).toBeFocused();
  return panel;
}

/** Waits until no finite animation runs on the page (the sheet sliding in). */
async function settle(page: Page) {
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          document
            .getAnimations()
            .filter(
              (a) => a.playState === "running" && a.effect?.getTiming().iterations !== Infinity,
            ).length,
      ),
    )
    .toBe(0);
}

/**
 * `shoot`'s four screenshots (360 and 1440 px, light and dark), each once the sheet has
 * settled: at 360 px it turns into a bottom sheet and slides in again.
 */
async function shootPanel(page: Page, name: string) {
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    for (const width of [360, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      await page.waitForTimeout(150);
      await settle(page);
      await page.screenshot({ path: `${SHOTS}${name}-${width}-${scheme}.png`, fullPage: true });
    }
  }
  await page.emulateMedia({ colorScheme: "light" });
  await page.setViewportSize({ width: 1280, height: 900 });
}

async function vote(guests: readonly Guest[], cards: readonly string[], round: number) {
  for (const [i, guest] of guests.entries()) {
    const card = cards[i];
    if (card === undefined) continue;
    expect(await guest.cmd("castVote", { card, round })).toMatchObject({ ok: true });
  }
}

test("three rounds in the panel, names only where named; a reload keeps them; a new round reaches the open panel", async ({
  page,
  context,
  browser,
  baseURL,
}) => {
  test.setTimeout(150_000);
  const base = baseURL ?? "";
  const code = await createRoom(page);
  await join(page, "Ana");
  const po = await sameUser(base, context);
  const guests = await guestsJoin(base, code, ["Ben", "Cleo"]);
  const [ben] = guests;
  const olga = await newPerson(browser);
  try {
    expect(await po.enter(code)).toMatchObject({ ok: true });
    expect(
      await po.cmd("updateSettings", { patch: { allowChangeAfterReveal: true } }),
    ).toMatchObject({ ok: true });

    // Someone on the join form has no History button; the server refuses them too.
    await olga.page.goto(page.url());
    await expect(olga.page.getByRole("textbox", { name: "Your name" })).toBeVisible();
    await expect(historyButton(olga.page)).toHaveCount(0);
    const onForm = await sameUser(base, olga.context);
    expect(await onForm.enter(code)).toMatchObject({ ok: true });
    expect(await onForm.history()).toEqual({ ok: false, code: "not_participant" });
    onForm.close();

    // Empty at first.
    const empty = await openHistory(page);
    await expect(empty.locator("[data-history-empty]")).toHaveText(
      "No rounds yet. A round appears here once the next round starts.",
    );
    await shootPanel(page, "history-empty");
    await page.keyboard.press("Escape");
    await expect(empty).toBeHidden();

    // Round 1: a title; Ana 5, Ben 3 then 8 after the reveal, Cleo 8; the PO records 8.
    await subjectField(page).fill("Login page");
    await page.getByRole("button", { name: "Start voting" }).click();
    await vote(guests, ["3", "8"], 1);
    await handCard(page, "5").click();
    await expect(page.getByRole("button", { name: "Next round" })).toBeVisible();
    expect(await ben?.cmd("castVote", { card: "8", round: 1 })).toMatchObject({ ok: true });
    await page
      .getByRole("group", { name: "Final estimate" })
      .getByRole("radio", { name: /^8(, suggested)?$/ })
      .check();
    await page.getByRole("button", { name: "Record 8" }).click();
    await expect(page.locator("[data-centre-final]")).toHaveAttribute("data-centre-final", "8");
    // The round on the table is not listed, not even decided: the panel stays empty.
    const decided = await openHistory(page);
    await expect(decided.locator("[data-history-empty]")).toBeVisible();
    await expect(rowsOf(decided)).toHaveCount(0);
    expect(await historyOf(po)).toEqual([]);
    await page.keyboard.press("Escape");
    await expect(decided).toBeHidden();
    // Round 2: the same subject again, voted 5, 5, 8.
    await page.getByRole("button", { name: "Vote again" }).click();
    await vote(guests, ["5", "8"], 2);
    await handCard(page, "5").click();
    // Round 3: anonymous, a Jira link; Ana 13, Ben 2, Cleo 3.
    expect(await po.cmd("updateSettings", { patch: { revealNames: false } })).toMatchObject({
      ok: true,
    });
    await subjectField(page).fill(JIRA);
    await page.getByRole("button", { name: "Next round" }).click();
    await vote(guests, ["2", "3"], 3);

    // The panel open during round 3 shows rounds 2 and 1.
    const panel = await openHistory(page);
    await expect(rowsOf(panel)).toHaveCount(2);
    expect(await numbersIn(panel)).toEqual([2, 1]);
    // Ana votes and the PO starts round 4 from her other socket: round 3 arrives in the
    // open panel without a reload.
    expect(await po.cmd("castVote", { card: "13", round: 3 })).toMatchObject({ ok: true });
    expect(await po.cmd("startRound", { subject: { kind: "none" } })).toMatchObject({ ok: true });
    await expect(rowsOf(panel)).toHaveCount(3);
    expect(await numbersIn(panel)).toEqual([3, 2, 1]);
    // Round 4, on the table, is not.
    await expect(rowOf(panel, 4)).toHaveCount(0);

    const first = rowOf(panel, 1);
    await expect(first.getByRole("heading", { name: "Round 1" })).toBeVisible();
    await expect(first.locator("[data-history-subject='title']")).toHaveText("Login page");
    await expect(first.locator("[data-history-final]")).toHaveAttribute("data-history-final", "8");
    await expect(
      first.getByRole("list", { name: "Votes per card" }).locator(".sr-only"),
    ).toHaveText(["5: 1 vote", "8: 2 votes"]);
    await expect(first.locator("[data-history-duration]")).toContainText(/^\d+\u{a0}s|min/u);
    await expect(first.locator("time")).toHaveAttribute("datetime", /^\d{4}-\d\d-\d\dT/);
    await expect(rowOf(panel, 2).locator("[data-history-final]")).toContainText("None");
    const third = rowOf(panel, 3);
    await expect(third).toHaveAttribute("data-history-kind", "anonymous");
    await expect(third.getByRole("link", { name: "PAY-482 (opens in a new tab)" })).toHaveAttribute(
      "href",
      JIRA,
    );
    await shootPanel(page, "history-rows");

    // A named round's votes: names and cards, Ben's marked changed.
    const toggle1 = panel.getByRole("button", { name: "Votes of round 1" });
    await toggle1.click();
    await expect(toggle1).toHaveAttribute("aria-expanded", "true");
    await expect(first.locator("[data-history-vote] .sr-only")).toHaveText([
      "Ana: 5",
      "Ben: 8, changed after the reveal",
      "Cleo: 8",
    ]);
    await expect(first.locator("[data-history-changed]")).toHaveText("changed");
    await shootPanel(page, "history-named-open");
    await toggle1.click();

    // The anonymous round: its cards in the deck's order, said once, and no name.
    await panel.getByRole("button", { name: "Votes of round 3" }).click();
    const cards = third.locator("[data-history-votes]");
    await expect(cards).toContainText("Anonymous round");
    await expect(cards.getByRole("listitem")).toHaveText(["22", "33", "1313"]);
    for (const name of ["Ana", "Ben", "Cleo"]) await expect(third).not.toContainText(name);
    await third.scrollIntoViewIfNeeded();
    await shootPanel(page, "history-anonymous-open");

    // AC 1: a reload keeps every round.
    await page.reload();
    await expect(page.getByRole("heading", { name: "You", exact: true })).toBeVisible();
    const again = await openHistory(page);
    await expect(rowsOf(again)).toHaveCount(3);
    expect(await numbersIn(again)).toEqual([3, 2, 1]);
    expect((await historyOf(po)).map((row) => [row.number, row.final])).toEqual([
      [1, "8"],
      [2, null],
      [3, null],
    ]);
  } finally {
    po.close();
    for (const guest of guests) guest.close();
    await olga.context.close();
  }
});

/**
 * 21 rounds played by Ana alone through her own socket; round 22 is on the table. Past the
 * server's message limit (10 a second, bursts of 20), a command waits and goes again.
 */
async function manyRounds(po: Guest) {
  const send = async (type: string, payload: Record<string, unknown>) => {
    for (;;) {
      const ack = await po.cmd(type, payload);
      if (ack.ok || ack.code !== "rate_limited") return ack;
      await new Promise((wake) => setTimeout(wake, 250));
    }
  };
  for (let round = 1; round <= 21; round++) {
    const subject = { kind: "title", text: `Story ${round}` };
    expect(await send("startRound", { subject })).toMatchObject({ ok: true });
    expect(await send("castVote", { card: "5", round })).toMatchObject({ ok: true });
  }
  expect(await send("startRound", { subject: { kind: "none" } })).toMatchObject({ ok: true });
}

test("the panel by keyboard on a desktop: focus trapped, disclosures, Show earlier rounds, Esc back to History", async ({
  page,
  context,
  baseURL,
}) => {
  test.setTimeout(120_000);
  const base = baseURL ?? "";
  const code = await createRoom(page);
  await join(page, "Ana");
  const po = await sameUser(base, context);
  try {
    expect(await po.enter(code)).toMatchObject({ ok: true });
    await manyRounds(po);
    await expect(page.locator("[data-round-subject]")).toContainText("Round 22");

    await historyButton(page).focus();
    await page.keyboard.press("Enter");
    const panel = panelOf(page);
    await expect(panel.getByRole("heading", { name: "History" })).toBeFocused();
    await expect(rowsOf(panel)).toHaveCount(20);
    expect((await numbersIn(panel))[0]).toBe(21);
    // Tab: "Close", then round 21's votes.
    await page.keyboard.press("Tab");
    await expect(panel.getByRole("button", { name: "Close" })).toBeFocused();
    await page.keyboard.press("Tab");
    const toggle21 = panel.getByRole("button", { name: "Votes of round 21" });
    await expect(toggle21).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(toggle21).toHaveAttribute("aria-expanded", "true");
    await expect(rowOf(panel, 21).locator("[data-history-vote] .sr-only")).toHaveText(["Ana: 5"]);
    await page.keyboard.press(" ");
    await expect(toggle21).toHaveAttribute("aria-expanded", "false");
    // Shift+Tab twice wraps from "Close" to the last control: the focus stays inside.
    await page.keyboard.press("Shift+Tab");
    await page.keyboard.press("Shift+Tab");
    const more = panel.getByRole("button", { name: "Show earlier rounds" });
    await expect(more).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(
      panel.getByRole("button", { name: "Votes of round 1", exact: true }),
    ).toBeFocused();
    await expect(rowsOf(panel)).toHaveCount(21);
    await expect(more).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(panel).toBeHidden();
    await expect(historyButton(page)).toBeFocused();
  } finally {
    po.close();
  }
});

test("the panel on a phone: a bottom sheet the width of the screen, by keyboard too", async ({
  browser,
  baseURL,
}) => {
  test.setTimeout(120_000);
  const base = baseURL ?? "";
  const ana = await phone(browser, "Pixel 7");
  try {
    const code = await createRoom(ana.page);
    await join(ana.page, "Ana");
    const po = await sameUser(base, ana.context);
    try {
      expect(await po.enter(code)).toMatchObject({ ok: true });
      await manyRounds(po);
    } finally {
      po.close();
    }
    await expect(ana.page.locator("[data-round-subject]")).toContainText("Round 22");
    // The icon alone in the header, named "History".
    const button = historyButton(ana.page);
    expect((await button.boundingBox())?.width).toBeLessThanOrEqual(45);
    await button.tap();
    const panel = panelOf(ana.page);
    await expect(panel.getByRole("heading", { name: "History" })).toBeFocused();
    await settle(ana.page);
    const box = await panel.boundingBox();
    const viewport = ana.page.viewportSize();
    expect(box && viewport && Math.round(box.x + box.width)).toBe(viewport?.width);
    expect(box && viewport && Math.round(box.y + box.height)).toBe(viewport?.height);
    expect(box?.x).toBe(0);
    await expect(rowsOf(panel)).toHaveCount(20);
    // No sideways scroll inside the sheet.
    expect(
      await panel.evaluate((sheet) => sheet.scrollWidth - sheet.clientWidth),
    ).toBeLessThanOrEqual(0);
    await ana.page.keyboard.press("Tab");
    await ana.page.keyboard.press("Tab");
    await expect(panel.getByRole("button", { name: "Votes of round 21" })).toBeFocused();
    await ana.page.keyboard.press("Enter");
    await expect(panel.getByRole("button", { name: "Votes of round 21" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    await settle(ana.page);
    await ana.page.screenshot({ path: `${SHOTS}history-phone-open.png` });
    await ana.page.keyboard.press("Escape");
    await expect(panel).toBeHidden();
    await expect(button).toBeFocused();
    expect(ana.errors).toEqual([]);
  } finally {
    await ana.context.close();
  }
});
