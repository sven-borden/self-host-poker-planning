import type { Locator, Page } from "@playwright/test";
import { expect, test } from "./fixtures.ts";
import { type Guest, guestsJoin, hand, handCard, sameUser } from "./support.ts";

// A whole round by keyboard alone (#37): create, join, start, pick and change a card,
// reveal by R and by the button, record the final, next round, settings, history, and the
// PO role handed over from a seat's popover. No click, no tap. At every focus stop the
// ring shows (WCAG 2.4.7) and nothing sticky covers the focused control (2.4.11); dialogs
// and sheets keep the focus inside, Escape closes them and the focus goes back to the
// button that opened them.

interface Focus {
  what: string;
  ring: boolean;
  covered: boolean;
  inView: boolean;
}

/** Where the focus is, whether its ring is drawn, and whether anything covers it. */
function focusNow(page: Page): Promise<Focus> {
  return page.evaluate(async () => {
    const element = document.activeElement as HTMLElement | null;
    if (!element || element === document.body) {
      return { what: "body", ring: false, covered: false, inView: false };
    }
    // A button fades its ring in (transition-all), a sheet slides in: read the page once
    // they have. A running timer ring never ends.
    await Promise.all(
      document
        .getAnimations()
        .filter((a) => a.effect?.getComputedTiming().endTime !== Number.POSITIVE_INFINITY)
        .map((a) => a.finished),
    ).catch(() => {});
    // The ring's colours: --brass (Tailwind's ring-ring and the global outline) and --ink.
    const probe = document.createElement("i");
    document.body.append(probe);
    const colours = ["--brass", "--ink"].map((token) => {
      probe.style.color = `var(${token})`;
      return getComputedStyle(probe).color;
    });
    probe.remove();
    const draws = (e: Element) => {
      const style = getComputedStyle(e);
      const outline =
        style.outlineStyle !== "none" &&
        Number.parseFloat(style.outlineWidth) >= 2 &&
        colours.includes(style.outlineColor);
      return outline || colours.some((colour) => style.boxShadow.includes(colour));
    };
    // The control itself, or the card a hidden radio or checkbox stands for.
    let ring = false;
    for (let e: Element | null = element, i = 0; e && i < 3; e = e.parentElement, i++) {
      if (draws(e)) ring = true;
    }
    const box = element.getBoundingClientRect();
    const x = Math.min(Math.max(box.left + box.width / 2, 0), window.innerWidth - 1);
    const y = Math.min(Math.max(box.top + box.height / 2, 0), window.innerHeight - 1);
    const hit = document.elementFromPoint(x, y);
    const covered = !(
      hit &&
      (element.contains(hit) || hit.contains(element) || hit.closest("label")?.contains(element))
    );
    const inView = box.bottom > 0 && box.top < window.innerHeight;
    const what = `${element.tagName.toLowerCase()} "${(element.getAttribute("aria-label") ?? element.textContent ?? "").trim().slice(0, 40)}"`;
    return { what, ring, covered, inView };
  });
}

/** Fails unless the focused control shows its ring, on screen and uncovered. */
async function expectSeen(page: Page, where: string) {
  const focus = await focusNow(page);
  expect.soft(focus.ring, `${where}: ${focus.what} draws a focus ring`).toBe(true);
  expect.soft(focus.inView, `${where}: ${focus.what} is on screen`).toBe(true);
  expect.soft(focus.covered, `${where}: ${focus.what} is not covered`).toBe(false);
}

/** Presses Tab (or Shift+Tab) until `target` has the focus, checking every stop. */
async function tabTo(page: Page, target: Locator, where: string, back = false) {
  for (let i = 0; i < 120; i++) {
    if (await target.evaluate((element) => element === document.activeElement)) return;
    await page.keyboard.press(back ? "Shift+Tab" : "Tab");
    if ((await focusNow(page)).what !== "body") await expectSeen(page, where);
  }
  await expect(target).toBeFocused();
}

/** Tabs `presses` times inside `dialog`: the focus never leaves it, and always shows. */
async function expectTrapped(page: Page, dialog: Locator, where: string, presses = 40) {
  for (let i = 0; i < presses; i++) {
    await page.keyboard.press(i % 3 === 2 ? "Shift+Tab" : "Tab");
    const inside = await dialog.evaluate((element) => element.contains(document.activeElement));
    expect(inside, `${where}: Tab ${i + 1} stays inside`).toBe(true);
    await expectSeen(page, `${where}, Tab ${i + 1}`);
  }
}

for (const viewport of [
  { name: "desktop", width: 1280, height: 800 },
  { name: "phone-sized window", width: 390, height: 844 },
]) {
  test(`a whole round by keyboard alone, with the focus always seen, on a ${viewport.name}`, async ({
    page,
    baseURL,
  }) => {
    test.setTimeout(180_000);
    const base = baseURL ?? "";
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.goto("/");
    await tabTo(page, page.getByRole("button", { name: "Create the room" }), "landing");
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/r\//);
    const code = page.url().split("/r/")[1] ?? "";

    const name = page.getByRole("textbox", { name: "Your name" });
    await tabTo(page, name, "join form");
    await page.keyboard.type("Ana");
    await tabTo(page, page.getByRole("button", { name: "Join the room" }), "join form");
    await page.keyboard.press("Enter");
    await expect(page.getByRole("heading", { name: "You", exact: true })).toBeVisible();
    let guests: Guest[] = [];
    const owner = await sameUser(base, page.context());
    try {
      expect(await owner.enter(code)).toMatchObject({ ok: true });
      guests = await guestsJoin(base, code, ["Ben", "Cleo"]);
      const [ben, cleo] = guests;

      // Start voting: the focus moves to the hand.
      await tabTo(page, page.getByRole("button", { name: "Start voting" }), "lobby");
      await page.keyboard.press("Enter");
      await expect(hand(page).locator(":focus")).toHaveCount(1);
      await expectSeen(page, "the hand after Start voting");

      // Pick 5 with the arrows and Enter, then change to 8. The hand ignores Enter for
      // 300 ms after the page placed the focus (PLACED_FOCUS_GUARD_MS in hand.tsx): the
      // Enter that started the round must not vote too.
      await page.waitForTimeout(350);
      await page.keyboard.press("Home");
      for (let i = 0; i < 4; i++) await page.keyboard.press("ArrowRight");
      await expect(handCard(page, "5")).toBeFocused();
      await expectSeen(page, "card 5");
      await page.keyboard.press("Enter");
      await expect(handCard(page, "5")).toHaveAttribute("aria-pressed", "true");
      await page.keyboard.press("ArrowRight");
      await page.keyboard.press("Enter");
      await expect(handCard(page, "8")).toHaveAttribute("aria-pressed", "true");
      await expect(handCard(page, "5")).toHaveAttribute("aria-pressed", "false");
      await expectSeen(page, "card 8");

      // R reveals while the focus is in the hand, where it stays (only a focus the reveal
      // took away moves); Tab reaches the PO's decision.
      expect(await ben?.cmd("castVote", { card: "8", round: 1, restart: 0 })).toMatchObject({
        ok: true,
      });
      await page.keyboard.press("r");
      await expect(page.locator("[data-face='up']")).toHaveCount(2);
      await expect(handCard(page, "8")).toBeFocused();
      await expectSeen(page, "card 8 after R");
      const record = page.getByRole("button", { name: "Record 8" });
      await tabTo(page, record, "to the decision");
      await page.keyboard.press("Enter");
      await expect(page.getByRole("button", { name: "Recorded" })).toBeVisible();

      // Next round, then the reveal by the button.
      await tabTo(page, page.getByRole("button", { name: "Next round" }), "decision bar");
      await page.keyboard.press("Enter");
      await expect(page.locator("[data-centre] [data-centre-status]")).toHaveText(
        "0/3 voted so far",
      );
      expect(await cleo?.cmd("castVote", { card: "3", round: 2, restart: 0 })).toMatchObject({
        ok: true,
      });
      const reveal = page.getByRole("button", { name: "Reveal cards" });
      await tabTo(page, reveal, "round 2");
      await page.keyboard.press("Enter");
      await expect(page.getByRole("button", { name: "Record 3" })).toBeFocused();
      await expectSeen(page, "Record 3 after the button");

      // The settings sheet: the focus stays inside, Escape gives it back to its button.
      const settingsButton = page.getByRole("button", { name: "Room settings" });
      await tabTo(page, settingsButton, "to the settings", true);
      await page.keyboard.press("Enter");
      const settings = page.getByRole("dialog", { name: "Room settings" });
      await expect(settings).toBeVisible();
      await expect(settings.locator(":focus")).toHaveCount(1);
      await expectTrapped(page, settings, "settings");
      await page.keyboard.press("Escape");
      await expect(settings).toBeHidden();
      await expect(settingsButton).toBeFocused();
      await expectSeen(page, "settings button after Escape");

      // History: open round 1's votes by keyboard, then Escape.
      const historyButton = page.getByRole("button", { name: "History" });
      await tabTo(page, historyButton, "to the history");
      await page.keyboard.press("Enter");
      const history = page.getByRole("dialog", { name: "History" });
      await expect(history.getByRole("heading", { name: "History" })).toBeFocused();
      const votes = history.getByRole("button", { name: "Votes of round 1" });
      await tabTo(page, votes, "history");
      await page.keyboard.press("Enter");
      await expect(votes).toHaveAttribute("aria-expanded", "true");
      await expectTrapped(page, history, "history");
      await page.keyboard.press("Escape");
      await expect(history).toBeHidden();
      await expect(historyButton).toBeFocused();

      // Ben's popover: Escape closes it and the focus is back on his seat; then the PO
      // role goes to him.
      const benSeat = page.getByRole("button", { name: /^Ben, / });
      await tabTo(page, benSeat, "to Ben's seat");
      await page.keyboard.press("Enter");
      const make = page.getByRole("button", { name: "Make product owner" });
      await expect(make).toBeFocused();
      await expectSeen(page, "Ben's popover");
      await page.keyboard.press("Escape");
      await expect(make).toBeHidden();
      await expect(benSeat).toBeFocused();
      await page.keyboard.press("Enter");
      await expect(make).toBeFocused();
      await page.keyboard.press("Enter");
      const handOver = page.getByRole("button", { name: "Hand over" });
      await tabTo(page, handOver, "the hand-over question");
      await page.keyboard.press("Enter");
      await expect(page.getByRole("button", { name: "Room rules" })).toBeVisible();
      await expect(benSeat).toBeFocused();
      await expectSeen(page, "Ben's seat after the hand-over");
    } finally {
      owner.close();
      for (const guest of guests) guest.close();
    }
  });
}
