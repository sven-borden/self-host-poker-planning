import { type Browser, expect, type Locator, type Page, test } from "@playwright/test";
import { computeResults } from "../../../packages/domain/src/results.ts";
import {
  createRoom,
  type Guest,
  guestsJoin,
  hand,
  handCard,
  join,
  newPerson,
  ownAddress,
  phone,
  SHOTS,
  seats,
  shoot,
  subjectLine,
} from "./support.ts";

// The deck field (#26) in real browsers, against the real server and Postgres: the PO
// picks a preset, builds a custom deck and generates a range, by keyboard alone on a
// desktop and on a phone; a deck change mid-vote asks first, and its restart reaches a
// voter and an observer; a custom deck with decimals gives French and German statistics,
// an emoji deck mode-based results (AC 2, AC 3); a 20-card deck with the three specials
// stays playable and legible at 360 and 1440 px. The refusals and every custom-deck code
// on the wire are in the server's `room-sync.db.test.ts`; each code's words in
// `deck-editor.test.ts` (AC 1). Needs DATABASE_URL; skipped without it locally, failing
// without it in CI.

test.skip(
  !process.env.DATABASE_URL && !process.env.CI,
  "needs DATABASE_URL: runs against the real server",
);
test.beforeAll(() => {
  if (!process.env.DATABASE_URL) {
    throw new Error("CI must run the deck tests: set DATABASE_URL");
  }
});
test.beforeEach(async ({ page }) => {
  await page.setExtraHTTPHeaders(ownAddress());
});

const tableLive = (page: Page) => page.locator("[data-table-live]");
const settings = (page: Page) => page.getByRole("dialog", { name: "Room settings" });
const deckGroup = (page: Page) => settings(page).getByRole("radiogroup", { name: "Deck" });
const customField = (page: Page) =>
  settings(page).getByRole("textbox", { name: "Cards, separated by commas" });
const results = (page: Page) => page.getByRole("region", { name: "Results" });
const stat = (scope: Locator, key: string) => scope.locator(`[data-stat='${key}'] dd`);

const percent = (value: number) =>
  new Intl.NumberFormat("en-US", { style: "percent", maximumFractionDigits: 0 }).format(value);

/** Lets every finite animation on the page end. */
async function settle(page: Page) {
  await page.evaluate(() =>
    Promise.all(
      document
        .getAnimations()
        .filter((animation) => animation.effect?.getComputedTiming().endTime !== Infinity)
        // A cancelled animation rejects its `finished`: it has ended all the same.
        .map((animation) => animation.finished.catch(() => undefined)),
    ),
  );
}

/** Opens "Room settings" from the header's button with the keyboard alone. */
async function openByKeyboard(page: Page) {
  await page.getByRole("button", { name: "Room settings" }).focus();
  await page.keyboard.press("Enter");
  await expect(settings(page)).toBeVisible();
  await settle(page);
}

/** Moves the focus forward with Tab until `target` has it. */
async function tabTo(page: Page, target: Locator, most = 12) {
  for (let i = 0; i < most; i++) {
    if (await target.evaluate((element) => element === document.activeElement)) return;
    await page.keyboard.press("Tab");
  }
  await expect(target).toBeFocused();
}

/** Replaces the focused input's text, by keyboard. */
async function retype(page: Page, text: string) {
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.press("Backspace");
  if (text !== "") await page.keyboard.type(text);
}

/**
 * The open panel with `target` in view, at 360 and 1440 px, light and dark: a bottom
 * sheet, then a side sheet.
 */
async function shootField(page: Page, name: string, target: Locator) {
  const size = page.viewportSize() ?? { width: 1280, height: 720 };
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    for (const width of [360, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      await page.waitForTimeout(150);
      await settle(page);
      await target.evaluate((element) => element.scrollIntoView({ block: "center" }));
      await page.screenshot({ path: `${SHOTS}${name}-${width}-${scheme}.png` });
    }
  }
  await page.emulateMedia({ colorScheme: "light" });
  await page.setViewportSize(size);
}

async function vote(guests: readonly Guest[], cards: readonly string[], round = 1, restart = 0) {
  for (const [i, guest] of guests.entries()) {
    const card = cards[i];
    if (card === undefined) continue;
    expect(await guest.cmd("castVote", { card, round, restart })).toMatchObject({ ok: true });
  }
}

/** A second person in their own browser, joined at the table (or watching). */
async function another(
  browser: Browser,
  url: string,
  name: string,
  role: "Voter" | "Observer" = "Voter",
) {
  const person = await newPerson(browser);
  await person.page.goto(url);
  await join(person.page, name, role);
  return person;
}

/** Applies a custom deck in the open panel: picks "Custom deck", types, uses it. */
async function applyCustomDeck(page: Page, cards: string) {
  await deckGroup(page).getByRole("radio", { name: "Custom deck" }).check();
  await customField(page).fill(cards);
  await settings(page).getByRole("button", { name: "Use these cards" }).click();
  await expect(deckGroup(page).locator("[data-deck='custom'] [data-deck-in-use]")).toBeVisible();
}

test("the PO picks a preset, builds a custom deck and generates a range by keyboard; a voter hears each change", async ({
  page,
  browser,
}) => {
  test.setTimeout(120_000);
  await createRoom(page);
  await join(page, "Ana");
  const ben = await another(browser, page.url(), "Ben");
  try {
    await expect(seats(page).locator("[data-seat]")).toHaveCount(2);
    await openByKeyboard(page);
    // The PO lands on the deck in use; an arrow key only moves the choice.
    const radio = (name: string) => deckGroup(page).getByRole("radio", { name, exact: true });
    await expect(radio("Fibonacci")).toBeFocused();
    await expect(settings(page).getByText("New cards apply from round 1.")).toBeVisible();
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowDown");
    await expect(radio("T-shirt sizes")).toBeChecked();
    const use = settings(page).getByRole("button", { name: "Use “T-shirt sizes”" });
    await expect(use).toBeVisible();
    await page.waitForTimeout(300);
    await expect(tableLive(ben.page)).not.toContainText("changed the deck");
    await shootField(page, "deck-presets", deckGroup(page));
    await tabTo(page, use, 2);
    await page.keyboard.press("Enter");
    await expect(radio("T-shirt sizes")).toBeFocused();
    await expect(deckGroup(page).locator("[data-deck='tshirt'] [data-deck-in-use]")).toBeVisible();
    await expect(tableLive(ben.page)).toContainText(
      "The product owner changed the deck to “T-shirt sizes” from the next round.",
    );

    // A custom deck: the field explains a fault and names the card.
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowDown");
    await expect(radio("Custom deck")).toBeChecked();
    await page.keyboard.press("Tab");
    await expect(customField(page)).toBeFocused();
    await page.keyboard.type("1, Large, 3");
    const problem = settings(page).locator("[data-deck-problem]");
    await expect(problem).toHaveText("“Large” is too long: a card holds at most 4 characters.");
    await expect(customField(page)).toHaveAttribute("aria-invalid", "true");
    await expect(settings(page).locator("[data-fault]")).toHaveText("Large");
    await page.keyboard.press("Enter");
    await expect(tableLive(ben.page)).not.toContainText("Custom deck");
    await shootField(page, "deck-custom-error", settings(page).locator("[data-custom-deck]"));

    // The range generator fills the field, with a comma as the decimal mark.
    await customField(page).focus();
    await retype(page, "");
    const toggle = settings(page).getByRole("button", { name: "Generate a range" });
    await tabTo(page, toggle, 2);
    await page.keyboard.press("Enter");
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    for (const [name, text] of [
      ["Start", "0"],
      ["End", "2"],
      ["Step", "0,5"],
    ] as const) {
      await page.keyboard.press("Tab");
      await expect(settings(page).getByRole("textbox", { name, exact: true })).toBeFocused();
      await retype(page, text);
    }
    const fill = settings(page).getByRole("button", { name: "Fill in the cards" });
    await tabTo(page, fill, 2);
    await page.keyboard.press("Enter");
    await expect(customField(page)).toHaveValue("0, 0.5, 1, 1.5, 2");
    await expect(settings(page).locator("[data-range-filled]")).toHaveText(
      "5 cards filled in. Check them, then use them.",
    );
    await expect(settings(page).locator("[data-deck-preview] [data-mini-card]")).toHaveText([
      "0",
      "0.5",
      "1",
      "1.5",
      "2",
    ]);
    await shootField(page, "deck-range", settings(page).locator("[data-range]"));
    // A range the deck cannot hold says why.
    await settings(page).getByRole("textbox", { name: "Step", exact: true }).focus();
    await retype(page, "0.01");
    await tabTo(page, fill, 2);
    await page.keyboard.press("Enter");
    await expect(settings(page).locator("[data-range-problem]")).toHaveText(
      "That range gives more than 20 cards. Take a larger step or a shorter range.",
    );
    await expect(customField(page)).toHaveValue("0, 0.5, 1, 1.5, 2");
    const useCustom = settings(page).getByRole("button", { name: "Use these cards" });
    await tabTo(page, useCustom, 4);
    await page.keyboard.press("Enter");
    await expect(useCustom).toBeFocused();
    await expect(tableLive(ben.page)).toContainText(
      "The product owner changed the deck to a custom deck from the next round.",
    );

    // The special cards: a switch each, by keyboard.
    const unsure = settings(page).getByRole("switch", { name: "Not sure" });
    await tabTo(page, unsure, 4);
    await page.keyboard.press("Space");
    await expect(unsure).toHaveAttribute("aria-checked", "false");
    await expect(tableLive(ben.page)).toContainText(
      "The product owner changed the special cards from the next round.",
    );
    await page.keyboard.press("Escape");
    await expect(settings(page)).toBeHidden();

    // The next round plays the new cards.
    await page.getByRole("button", { name: "Start voting" }).click();
    await expect(hand(ben.page).getByRole("button")).toHaveCount(6);
    for (const label of ["0", "0.5", "1", "1.5", "2", "needs a break"]) {
      await expect(handCard(ben.page, label)).toBeVisible();
    }
    await expect(handCard(ben.page, "unsure")).toHaveCount(0);
  } finally {
    await ben.context.close();
  }
});

test("a deck change mid-vote asks first; Cancel keeps the votes, the restart clears them for a voter and an observer", async ({
  page,
  browser,
  baseURL,
}) => {
  test.setTimeout(120_000);
  const code = await createRoom(page);
  await join(page, "Ana");
  const ben = await another(browser, page.url(), "Ben");
  const oda = await another(browser, page.url(), "Oda", "Observer");
  const [cy] = await guestsJoin(baseURL ?? "", code, ["Cy"]);
  try {
    await expect(seats(page).locator("[data-seat]")).toHaveCount(3);
    await page.getByRole("button", { name: "Start voting" }).click();
    await handCard(ben.page, "5").click();
    await expect(page.locator("[data-centre-status='voting']")).toHaveText("1/3 voted so far");

    await page.getByRole("button", { name: "Room settings" }).click();
    await expect(
      settings(page).getByText(
        "New cards restart round 1: its votes are cleared, its subject stays.",
      ),
    ).toBeVisible();
    await deckGroup(page).getByRole("radio", { name: "T-shirt sizes" }).check();
    await settings(page).getByRole("button", { name: "Use “T-shirt sizes”" }).click();
    const question = settings(page).getByRole("group", {
      name: "Changing the deck restarts round 1. The vote cast so far is cleared; the subject stays.",
    });
    await expect(question).toBeFocused();
    await shootField(page, "deck-restart-question", question);
    await question.getByRole("button", { name: "Cancel" }).click();
    await expect(question).toBeHidden();
    await expect(settings(page).getByRole("button", { name: "Use “T-shirt sizes”" })).toBeFocused();
    // Nothing changed: Ben's card is still his.
    await page.waitForTimeout(300);
    await expect(handCard(ben.page, "5")).toHaveAttribute("aria-pressed", "true");
    await expect(tableLive(ben.page)).not.toContainText("restarted");

    await settings(page).getByRole("button", { name: "Use “T-shirt sizes”" }).click();
    await settings(page).getByRole("button", { name: "Restart with “T-shirt sizes”" }).click();
    await expect(deckGroup(page).getByRole("radio", { name: "T-shirt sizes" })).toBeFocused();
    await expect(tableLive(ben.page)).toContainText(
      "The product owner restarted round 1 with “T-shirt sizes”. Vote again.",
    );
    await expect(tableLive(oda.page)).toContainText(
      "The product owner restarted round 1 with “T-shirt sizes”.",
    );
    await expect(tableLive(oda.page)).not.toContainText("Vote again");
    for (const viewer of [ben.page, oda.page]) {
      await expect(tableLive(viewer)).not.toContainText("Voting started");
      await expect(subjectLine(viewer)).toContainText("Round 1");
    }
    // Ben's hand empties into the new deck; the round counts no vote.
    await expect(hand(ben.page).getByRole("button")).toHaveCount(8);
    await expect(handCard(ben.page, "XS")).toBeVisible();
    await expect(hand(ben.page).locator("[aria-pressed='true']")).toHaveCount(0);
    await expect(page.locator("[data-centre-status='voting']")).toHaveText("0/3 voted so far");

    // A vote sent for the round before its restart is refused, even for a card in both
    // decks; one for the restarted round lands.
    expect(await cy?.cmd("castVote", { card: "?", round: 1, restart: 0 })).toEqual({
      ok: false,
      code: "round_changed",
    });
    expect(await cy?.cmd("castVote", { card: "M", round: 1, restart: 1 })).toMatchObject({
      ok: true,
    });
    await expect(page.locator("[data-centre-status='voting']")).toHaveText("1/3 voted so far");
  } finally {
    cy?.close();
    await ben.context.close();
    await oda.context.close();
  }
});

test("a custom deck with decimals gives an average and median in French and German, its labels as typed (AC 2)", async ({
  page,
  browser,
  baseURL,
}) => {
  test.setTimeout(120_000);
  const code = await createRoom(page);
  await join(page, "Ana");
  const readers: { context: Awaited<ReturnType<typeof newPerson>>["context"]; page: Page }[] = [];
  const guests = await guestsJoin(baseURL ?? "", code, ["Cy", "Dan"]);
  try {
    // A French and a German observer, each joining in their language.
    for (const [locale, name, watch, submit] of [
      ["fr-FR", "Votre nom", /^Observateur/, "Rejoindre la salle"],
      ["de-DE", "Ihr Name", /^Beobachten/, "Raum betreten"],
    ] as const) {
      const context = await browser.newContext({ locale, extraHTTPHeaders: ownAddress() });
      const reader = await context.newPage();
      await reader.goto(page.url());
      await reader.getByRole("textbox", { name }).fill(locale === "fr-FR" ? "Fleur" : "Dora");
      await reader.getByRole("radio", { name: watch }).check();
      await reader.getByRole("button", { name: submit }).click();
      await expect(reader.getByRole("textbox", { name })).toBeHidden();
      readers.push({ context, page: reader });
    }
    await page.getByRole("button", { name: "Room settings" }).click();
    await applyCustomDeck(page, "0.5, 1, 1.5, 2.5");
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Start voting" }).click();
    await vote(guests, ["0.5", "2.5"]);
    await handCard(page, "1.5").click();
    // Ana, Cy and Dan voted: the round reveals.
    const expected = computeResults(["0.5", "1.5", "2.5"], {
      kind: "custom",
      cards: ["0.5", "1", "1.5", "2.5"],
    });
    expect([expected.average, expected.median]).toEqual([1.5, 1.5]);
    await expect(stat(results(page), "average")).toHaveText("1.5");
    const [fr, de] = readers;
    const fresh = fr?.page.getByRole("region", { name: "Résultats" });
    const deResults = de?.page.getByRole("region", { name: "Ergebnisse" });
    if (!fresh || !deResults || !fr || !de) throw new Error("no readers");
    await expect(stat(fresh, "average")).toHaveText("1,5");
    await expect(stat(fresh, "median")).toHaveText("1,5");
    await expect(stat(deResults, "average")).toHaveText("1,5");
    await expect(stat(deResults, "median")).toHaveText("1,5");
    // The cards keep their labels as typed, in every language.
    for (const reader of [fr.page, de.page]) {
      const faces = reader.locator("[data-room-table] [data-face='up'] [data-card-value]");
      await expect(faces).toHaveCount(3);
      expect((await faces.allTextContents()).sort()).toEqual(["0.5", "1.5", "2.5"]);
    }
    await fr.page.waitForTimeout(1_200);
    await shoot(fr.page, "deck-decimals-fr");
  } finally {
    for (const guest of guests) guest.close();
    for (const reader of readers) await reader.context.close();
  }
});

test("an emoji deck shows the most voted card, the agreement and the spread, no average (AC 3)", async ({
  page,
  baseURL,
}) => {
  test.setTimeout(120_000);
  const code = await createRoom(page);
  await join(page, "Ana");
  const guests = await guestsJoin(baseURL ?? "", code, ["Cy", "Dan", "Eve"]);
  try {
    await page.getByRole("button", { name: "Room settings" }).click();
    await applyCustomDeck(page, "🐜, 🐈, 🐘");
    await expect(settings(page).locator("[data-deck-preview] [data-mini-card]")).toHaveText([
      "🐜",
      "🐈",
      "🐘",
    ]);
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Start voting" }).click();
    await vote(guests, ["🐈", "🐘", "🐜"]);
    await handCard(page, "🐈").click();
    const deck = { kind: "custom" as const, cards: ["🐜", "🐈", "🐘"] };
    const expected = computeResults(["🐈", "🐈", "🐘", "🐜"], deck);
    expect(expected.mode).toBe("🐈");
    await expect(results(page).locator("dt")).toHaveText(["Most voted", "Agreement", "Spread"]);
    await expect(stat(results(page), "mostVoted")).toHaveText("🐈");
    await expect(stat(results(page), "agreement")).toHaveText(percent(expected.agreement));
    await expect(stat(results(page), "spread").locator("[aria-hidden]")).toHaveText("🐜–🐘");
    await expect(results(page)).not.toContainText("Average");
    await expect(results(page)).not.toContainText("Median");
    await page.waitForTimeout(1_200);
    await shoot(page, "deck-emoji-results");
  } finally {
    for (const guest of guests) guest.close();
  }
});

test("on a phone the PO picks a preset and turns a special card on by keyboard", async ({
  browser,
}) => {
  test.setTimeout(90_000);
  const po = await phone(browser, { width: 360, height: 780 });
  try {
    const { page } = po;
    await createRoom(page);
    await join(page, "Ana");
    await openByKeyboard(page);
    const box = await settings(page).boundingBox();
    expect(box?.width).toBe(360);
    const radio = (name: string) => deckGroup(page).getByRole("radio", { name, exact: true });
    // On a short screen the title may take the focus first; Tab reaches the deck.
    await tabTo(page, radio("Fibonacci"), 3);
    await page.keyboard.press("ArrowDown");
    await expect(radio("Modified Fibonacci")).toBeChecked();
    const use = settings(page).getByRole("button", { name: "Use “Modified Fibonacci”" });
    await tabTo(page, use, 2);
    await page.keyboard.press("Enter");
    await expect(radio("Modified Fibonacci")).toBeFocused();
    await expect(deckGroup(page).locator("[data-deck='mfib'] [data-deck-in-use]")).toBeVisible();
    const infinite = settings(page).getByRole("switch", { name: "Too big to estimate" });
    await tabTo(page, infinite, 6);
    // The focused switch shows clear of the sticky title, on screen.
    const head = await settings(page).locator("[data-panel-head]").boundingBox();
    const at = await infinite.boundingBox();
    expect((at?.y ?? 0) + 1).toBeGreaterThan((head?.y ?? 0) + (head?.height ?? 0));
    expect((at?.y ?? 0) + (at?.height ?? 0)).toBeLessThanOrEqual(780);
    await page.keyboard.press("Space");
    await expect(infinite).toHaveAttribute("aria-checked", "true");
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Start voting" }).click();
    await expect(handCard(page, "100")).toBeVisible();
    await expect(handCard(page, "too big to estimate")).toBeVisible();
    expect(po.errors).toEqual([]);
  } finally {
    await po.context.close();
  }
});

/** The labels drawn on the cards in `scope`, with their font size in pixels. */
const labelSizes = (scope: Locator) =>
  scope.locator("span[data-card-value]").evaluateAll((values) =>
    values.map((value) => ({
      card: value.textContent,
      px: Number.parseFloat(getComputedStyle(value).fontSize),
    })),
  );

/** The cards whose label leaves its card or wraps (as `table.spec.ts` checks the bench). */
const spills = (page: Page) =>
  page.evaluate(() =>
    [...document.querySelectorAll("[data-hand-card], [data-face='up'], [data-mini-card]")].flatMap(
      (card) => {
        const c = card.getBoundingClientRect();
        return [...card.querySelectorAll("[data-card-value]")].flatMap((value) => {
          const v = value.getBoundingClientRect();
          const size = Number.parseFloat(getComputedStyle(value).fontSize);
          const inside =
            v.left >= c.left + 0.5 &&
            v.right <= c.right - 0.5 &&
            v.top >= c.top + 0.5 &&
            v.bottom <= c.bottom - 0.5;
          return inside && v.height < size * 1.6 ? [] : [`${value.textContent} spills`];
        });
      },
    ),
  );

const TWENTY = [
  "0",
  "0.5",
  "1",
  "2",
  "3",
  "5",
  "8",
  "13",
  "20",
  "40",
  "100",
  "1000",
  "9999",
  "XXL",
  "Huge",
  "Big",
  "🐜",
  "🐈",
  "🐘",
  "👍🏽",
];

test("a 20-card deck with the three specials stays playable and legible at 360 and 1440 px", async ({
  page,
  browser,
  baseURL,
}) => {
  test.setTimeout(150_000);
  const code = await createRoom(page);
  await join(page, "Ana");
  const guests = await guestsJoin(baseURL ?? "", code, ["Cy", "Dan", "Eve", "Fay", "Gus"]);
  const ben = await phone(browser, { width: 360, height: 780 });
  try {
    await ben.page.goto(page.url());
    await join(ben.page, "Ben");
    await page.getByRole("button", { name: "Room settings" }).click();
    await applyCustomDeck(page, TWENTY.join(", "));
    await settings(page).getByRole("switch", { name: "Too big to estimate" }).click();
    await expect(
      settings(page).getByRole("switch", { name: "Too big to estimate" }),
    ).toHaveAttribute("aria-checked", "true");
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Start voting" }).click();

    // Every card is in the hand, which scrolls sideways where it does not fit.
    for (const viewer of [page, ben.page]) {
      await expect(hand(viewer).getByRole("button")).toHaveCount(23);
    }
    const scroll = await hand(ben.page).evaluate((bar) => ({
      overflow: getComputedStyle(bar).overflowX,
      wider: bar.scrollWidth > bar.clientWidth,
    }));
    expect(scroll).toEqual({ overflow: "auto", wider: true });
    // The page itself never scrolls sideways.
    expect(
      await ben.page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      ),
    ).toBeLessThanOrEqual(0);
    // The last card scrolls into reach and plays.
    await handCard(ben.page, "too big to estimate").scrollIntoViewIfNeeded();
    await handCard(ben.page, "👍🏽").tap();
    await expect(handCard(ben.page, "👍🏽")).toHaveAttribute("aria-pressed", "true");
    // The docked hand's rule (#22): when it docks, nothing that matters lies under it.
    const docked = await ben.page.evaluate(() => {
      window.scrollTo(0, 0);
      const dock = document.querySelector("[data-hand-dock]");
      const you = document.querySelector("[data-room-table] [data-seat][data-you]");
      return {
        dock: dock?.getBoundingClientRect().top ?? null,
        you: you?.getBoundingClientRect().bottom ?? null,
      };
    });
    if (docked.dock !== null && docked.you !== null) {
      expect(docked.you).toBeLessThanOrEqual(docked.dock + 0.5);
    }
    for (const label of TWENTY.slice(0, 10)) expect(label.length).toBeLessThanOrEqual(4);
    for (const size of await labelSizes(hand(page))) expect(size.px).toBeGreaterThanOrEqual(7);
    for (const size of await labelSizes(hand(ben.page))) expect(size.px).toBeGreaterThanOrEqual(7);
    expect(await spills(page)).toEqual([]);
    expect(await spills(ben.page)).toEqual([]);
    await shoot(ben.page, "deck-20-hand-phone");
    await shoot(page, "deck-20-hand");

    // The results: columns and seats stay readable with long and emoji labels.
    await vote(guests, ["1000", "9999", "Huge", "🐘", "∞"]);
    await handCard(page, "XXL").click();
    await expect(results(page)).toBeVisible();
    for (const viewer of [page, ben.page]) {
      for (const width of [360, 1440]) {
        await viewer.setViewportSize({ width, height: 900 });
        await viewer.waitForTimeout(2_600);
        const small = [
          ...(await labelSizes(viewer.locator("[data-room-table] [data-face='up']"))),
          ...(await labelSizes(results(viewer))),
        ].filter(({ px }) => px < 7);
        expect(small, `${width} px`).toEqual([]);
        expect(await spills(viewer), `${width} px`).toEqual([]);
        // A six-card tie for most voted wraps inside the panel, clear of its neighbours.
        const boxes = await results(viewer)
          .locator("[data-stat] dd")
          .evaluateAll((values) =>
            values.map((value) => {
              const { left, right, top, bottom } = value.getBoundingClientRect();
              const panel = value.closest("[data-stats]")?.getBoundingClientRect();
              return { left, right, top, bottom, min: panel?.left ?? 0, max: panel?.right ?? 0 };
            }),
          );
        for (const box of boxes) {
          expect(box.left, `${width} px`).toBeGreaterThanOrEqual(box.min - 0.5);
          expect(box.right, `${width} px`).toBeLessThanOrEqual(box.max + 0.5);
        }
        for (const [i, box] of boxes.entries()) {
          for (const other of boxes.slice(i + 1)) {
            const apart =
              box.right <= other.left + 0.5 ||
              other.right <= box.left + 0.5 ||
              box.bottom <= other.top + 0.5 ||
              other.bottom <= box.top + 0.5;
            expect(apart, `${width} px: the statistics overlap`).toBe(true);
          }
        }
      }
    }
    await shoot(page, "deck-20-results");
  } finally {
    for (const guest of guests) guest.close();
    await ben.context.close();
  }
});
