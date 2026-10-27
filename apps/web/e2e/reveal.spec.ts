import { type Browser, expect, type Page, test } from "@playwright/test";
import { cardLeaks } from "../../../packages/protocol/src/leak-scan.ts";
import {
  animated,
  createRoom,
  type Guest,
  join,
  newGuest,
  newPerson,
  ownAddress,
  recordAnimations,
  recordFrames,
  SHOTS,
  sameUser,
  seats,
  shoot,
  snapshotsIn,
} from "./support.ts";

// The reveal (#19) in real browsers, against the real server and Postgres: the PO's
// button and the key R, the flip in seat order from the viewer, the automatic reveal,
// the anonymous reveal showing the cards under the table without tying any to a person
// (on the frames and in the page), a voter who leaves after a named reveal keeping their
// name, and reduced motion (AC 3). Needs DATABASE_URL; skipped without it locally,
// failing without it in CI.

test.skip(
  !process.env.DATABASE_URL && !process.env.CI,
  "needs DATABASE_URL: runs against the real server",
);
test.beforeAll(() => {
  if (!process.env.DATABASE_URL) {
    throw new Error("CI must run the reveal tests: set DATABASE_URL");
  }
});
test.beforeEach(async ({ page }) => {
  await page.setExtraHTTPHeaders(ownAddress());
});

const hand = (page: Page) => page.getByRole("toolbar", { name: "Your cards" });
const handCard = (page: Page, label: string) =>
  hand(page).getByRole("button", { name: label, exact: true });
const status = (page: Page) => page.locator("[data-centre] [data-centre-status]");
const revealButton = (page: Page) => page.getByRole("button", { name: "Reveal cards" });
const tableLive = (page: Page) => page.locator("[data-table-live]");

/** The guests who fill the table, and the card each plays. */
const GUESTS = [
  ["Cleo", "3"],
  ["Dan", "5"],
  ["Eve", "8"],
  ["Finn", "13"],
  ["Gus", "?"],
  ["Hana", "2"],
] as const;

/** Six guests join as voters, over the protocol. */
async function fillTable(base: string, code: string): Promise<Guest[]> {
  const guests = await Promise.all(GUESTS.map(() => newGuest(base)));
  for (const [i, guest] of guests.entries()) {
    expect(await guest.enter(code)).toMatchObject({ ok: true });
    const name = GUESTS[i]?.[0] ?? "";
    expect(await guest.cmd("join", { name, role: "voter" })).toMatchObject({ ok: true });
  }
  return guests;
}

/** Each guest plays their card in round 1; `skip` guests at the end do not. */
async function guestsVote(guests: Guest[], skip = 0) {
  for (const [i, guest] of guests.slice(0, guests.length - skip).entries()) {
    const card = GUESTS[i]?.[1] ?? "";
    expect(await guest.cmd("castVote", { card, round: 1, restart: 0 })).toMatchObject({ ok: true });
  }
}

async function closeAll(guests: Guest[], browsers: Array<{ context: { close(): Promise<void> } }>) {
  for (const guest of guests) guest.close();
  for (const person of browsers) await person.context.close();
}

async function secondBrowser(browser: Browser, url: string, name: string) {
  const person = await newPerson(browser);
  const frames = recordFrames(person.page);
  await person.page.goto(url);
  await join(person.page, name);
  return { ...person, frames };
}

test("the PO reveals a named round; the cards turn over in seat order from the viewer", async ({
  page,
  browser,
  baseURL,
}) => {
  test.setTimeout(120_000);
  const code = await createRoom(page);
  await join(page, "Ana");
  const ben = await secondBrowser(browser, page.url(), "Ben");
  const guests = await fillTable(baseURL ?? "", code);
  try {
    await expect(seats(page).locator("[data-seat]")).toHaveCount(8);
    await page.getByRole("button", { name: "Start voting" }).click();
    await expect(status(page)).toHaveText("0/8 voted so far");
    // Only the PO has the button.
    await expect(revealButton(page)).toHaveAttribute("aria-keyshortcuts", "R");
    await expect(revealButton(ben.page)).toHaveCount(0);

    await handCard(page, "5").click();
    await handCard(ben.page, "8").click();
    // Hana does not vote, so the round waits for the PO.
    await guestsVote(guests, 1);
    await expect(status(page)).toHaveText("7/8 voted so far");
    await expect(page.locator("[data-card-flight]")).toHaveCount(0);
    await shoot(page, "reveal-button");
    await recordAnimations(ben.page);
    await revealButton(page).click();

    // Everyone sees the cards, the seats say them, and the PO's focus is on recording the
    // suggestion (#32).
    await expect(page.getByRole("button", { name: "Record 8" })).toBeFocused();
    await expect(status(ben.page)).toHaveAttribute("data-centre-status", "revealed");
    // The result comes with the reveal (#20): 3, 5, 5, 8, 8 and 13 average 7.
    await expect(tableLive(ben.page)).toContainText("Cards revealed. Suggested 8. Agreement 33%.");
    await expect(tableLive(page)).toContainText("Cards revealed. Suggested 8. Agreement 33%.");
    const benSeats = seats(ben.page);
    await expect(benSeats.getByRole("button", { name: "Gus, card unsure" })).toHaveCount(0);
    await expect(benSeats.getByRole("button", { name: "Gus, unsure" })).toHaveCount(1);
    await expect(benSeats.getByRole("button", { name: "Ana, product owner, card 5" })).toHaveCount(
      1,
    );
    await expect(benSeats.getByRole("button", { name: "Hana, no vote" })).toHaveCount(1);
    await expect(ben.page.locator("[data-face='up']")).toHaveCount(7);
    await expect(handCard(ben.page, "8")).toHaveAttribute("aria-disabled", "true");

    // Seven faces turned, 90 ms apart, starting with Ben's own card at the bottom.
    const turns = (await animated(ben.page)).filter((a) => a.target === "up");
    expect(turns.map((a) => a.delay).sort((x, y) => x - y)).toEqual([
      0, 90, 180, 270, 360, 450, 540,
    ]);
    expect(turns.every((a) => a.duration === 650 && a.keyframes.includes("rotateY"))).toBe(true);
    expect(turns.find((a) => a.you)?.delay).toBe(0);

    // Before the reveal Ben's frames held no card but his own.
    const played = ["3", "5", "13", "?", "2"];
    for (const snapshot of snapshotsIn(ben.frames)) {
      const round = snapshot.room.round as { phase?: string } | null;
      if (round?.phase === "revealed") continue;
      expect(cardLeaks(snapshot, played)).toEqual([]);
    }
    await shoot(page, "reveal-named");

    // Eve leaves after the reveal: her card stays under the table with her name.
    expect(await guests[2]?.cmd("leave")).toMatchObject({ ok: true });
    const left = ben.page.getByRole("list", { name: "Not at the table" });
    await expect(left).toContainText("Eve");
    await expect(left.getByRole("listitem")).toHaveText("8EveEve, card 8");
    await shoot(ben.page, "reveal-departed");

    // A reload shows the revealed table at rest: nothing turns.
    await recordAnimations(ben.page, { reload: true });
    await expect(ben.page.locator("[data-face='up']")).toHaveCount(6);
    await expect(left).toContainText("Eve");
    await ben.page.waitForTimeout(300);
    expect(await animated(ben.page)).toEqual([]);
  } finally {
    await closeAll(guests, [ben]);
  }
});

/**
 * From now on every animation on the page starts paused at its first frame, so a test
 * can look at the flip at a moment of its choosing (`window.__frozen`).
 */
const freezeAnimations = (page: Page) =>
  page.evaluate(() => {
    const frozen: Animation[] = [];
    Object.assign(window, { __frozen: frozen });
    const original = Element.prototype.animate;
    Element.prototype.animate = function (keyframes, options) {
      const animation = original.call(this, keyframes, options);
      animation.pause();
      frozen.push(animation);
      return animation;
    };
  });

/** Moves every frozen animation to `ms` after its start; `null` lets them finish. */
const seekAnimations = (page: Page, ms: number | null) =>
  page.evaluate((at) => {
    for (const animation of (window as unknown as { __frozen: Animation[] }).__frozen) {
      if (at === null) animation.finish();
      else animation.currentTime = at;
    }
  }, ms);

test("the last vote reveals a named round; its card turns in its place, back first", async ({
  page,
  browser,
  baseURL,
}) => {
  test.setTimeout(120_000);
  const code = await createRoom(page);
  await join(page, "Ana");
  const ben = await secondBrowser(browser, page.url(), "Ben");
  const guests = await fillTable(baseURL ?? "", code);
  try {
    await expect(seats(page).locator("[data-seat]")).toHaveCount(8);
    await page.getByRole("button", { name: "Start voting" }).click();
    await handCard(page, "5").click();
    await handCard(ben.page, "8").click();
    await guestsVote(guests, 1);
    await expect(status(ben.page)).toHaveText("7/8 voted so far");
    await expect(ben.page.locator("[data-card-flight]")).toHaveCount(0);
    // On Ben's screen Hana's slot is empty until her vote arrives with the reveal.
    await expect(ben.page.locator("[data-face='empty']")).toHaveCount(1);
    await recordAnimations(ben.page);
    await freezeAnimations(ben.page);
    expect(await guests[5]?.cmd("castVote", { card: "2", round: 1, restart: 0 })).toMatchObject({
      ok: true,
    });

    await expect(status(ben.page)).toHaveAttribute("data-centre-status", "revealed");
    await expect(ben.page.locator("[data-face='up']")).toHaveCount(8);
    // Eight cards turn, 90 ms apart, Hana's among them: none is skipped or face up early.
    const turns = (await animated(ben.page)).filter((a) => a.target === "up");
    expect(turns.map((a) => a.delay).sort((x, y) => x - y)).toEqual([
      0, 90, 180, 270, 360, 450, 540, 630,
    ]);
    // At the start every face-up card, Hana's too, still shows its back.
    await seekAnimations(ben.page, 0);
    const covers = ben.page.locator("[data-face='up'] [data-cover]");
    await expect(covers).toHaveCount(8);
    expect(
      await covers.evaluateAll((all) => all.map((cover) => getComputedStyle(cover).opacity)),
    ).toEqual(Array(8).fill("1"));
    // At 90 ms, the review's frame: Ben's card turning, every other one, Hana's too, on
    // its back.
    await seekAnimations(ben.page, 90);
    await ben.page.screenshot({ path: `${SHOTS}reveal-named-auto-90ms.png` });
    await seekAnimations(ben.page, null);
    await expect(tableLive(ben.page)).toContainText("Cards revealed.");
    await shoot(ben.page, "reveal-named-auto");
  } finally {
    await closeAll(guests, [ben]);
  }
});

test("a named vote without a seat shows under the table: an observer now, or back as one", async ({
  page,
  browser,
  baseURL,
}) => {
  test.setTimeout(120_000);
  const code = await createRoom(page);
  await join(page, "Ana");
  const ben = await secondBrowser(browser, page.url(), "Ben");
  const [cy] = await Promise.all([newGuest(baseURL ?? "")]);
  try {
    if (!cy) throw new Error("no guest");
    expect(await cy.enter(code)).toMatchObject({ ok: true });
    expect(
      await cy.cmd("join", { name: "Cyrielle Montgomery-Fairweather", role: "voter" }),
    ).toMatchObject({ ok: true });
    await expect(seats(page).locator("[data-seat]")).toHaveCount(3);
    await page.getByRole("button", { name: "Start voting" }).click();
    await handCard(page, "5").click();
    await handCard(ben.page, "8").click();
    await expect(status(page)).toHaveText("2/3 voted so far");
    await revealButton(page).click();
    // The PO's focus goes on to recording the suggestion (#32).
    await expect(page.getByRole("button", { name: /^Record [0-9]+$/ })).toBeFocused();

    // Ben switches to observer after the reveal: his card leaves the table, not the round.
    await ben.page.getByRole("button", { name: "Switch to observer" }).click();
    const row = page.getByRole("list", { name: "Not at the table" });
    // His 8 is the round's highest card: the row wears the seats' arrow and says so (#20).
    await expect(row.getByRole("listitem")).toHaveText(["8BenBen, card 8, highest card"]);
    await expect(row.locator("[data-badge='highest']")).toHaveCount(1);
    await expect(page.locator("[data-face='up']")).toHaveCount(1);
    await shoot(page, "reveal-off-table-observer");
  } finally {
    cy?.close();
    await ben.context.close();
  }
});

test("a voter who left after a named reveal and came back as an observer keeps their card on screen", async ({
  page,
  baseURL,
}) => {
  const code = await createRoom(page);
  await join(page, "Ana");
  const [cy] = await Promise.all([newGuest(baseURL ?? "")]);
  try {
    if (!cy) throw new Error("no guest");
    expect(await cy.enter(code)).toMatchObject({ ok: true });
    const name = "Cyrielle Montgomery-Fairweather";
    expect(await cy.cmd("join", { name, role: "voter" })).toMatchObject({ ok: true });
    await expect(seats(page).locator("[data-seat]")).toHaveCount(2);
    await page.getByRole("button", { name: "Start voting" }).click();
    expect(await cy.cmd("castVote", { card: "13", round: 1, restart: 0 })).toMatchObject({
      ok: true,
    });
    await expect(status(page)).toHaveText("1/2 voted so far");
    await revealButton(page).click();
    await expect(page.getByRole("button", { name: "Next round" })).toBeVisible();
    expect(await cy.cmd("leave")).toMatchObject({ ok: true });
    const row = page.getByRole("list", { name: "Not at the table" });
    await expect(row.getByRole("listitem")).toHaveText([`13${name}${name}, card 13`]);
    expect(await cy.cmd("join", { name, role: "observer" })).toMatchObject({ ok: true });
    await expect(page.locator("[data-observer]")).toHaveCount(1);
    await expect(row.getByRole("listitem")).toHaveText([`13${name}${name}, card 13`]);
    // The long name wraps instead of being cut, and is whole in the title.
    const visible = row.locator("[aria-hidden='true'][title]");
    await expect(visible).toHaveAttribute("title", name);
    await shoot(page, "reveal-off-table-rejoined");
  } finally {
    cy?.close();
  }
});

test("an anonymous round reveals itself when everyone voted, and ties no card to anyone", async ({
  page,
  context,
  browser,
  baseURL,
}) => {
  test.setTimeout(120_000);
  const base = baseURL ?? "";
  const code = await createRoom(page);
  await join(page, "Ana");
  const ben = await secondBrowser(browser, page.url(), "Ben");
  const guests = await fillTable(base, code);
  // The PO's own user over the protocol: the settings panel comes in W2.
  const po = await sameUser(base, context);
  try {
    await expect(seats(page).locator("[data-seat]")).toHaveCount(8);
    expect(await po.enter(code)).toMatchObject({ ok: true });
    expect(await po.cmd("updateSettings", { patch: { revealNames: false } })).toMatchObject({
      ok: true,
    });
    await page.getByRole("button", { name: "Start voting" }).click();
    await expect(status(ben.page)).toHaveText("0/8 voted so far");
    await handCard(page, "5").click();
    await handCard(ben.page, "8").click();
    await expect(status(ben.page)).toHaveText("2/8 voted so far");
    await expect(ben.page.locator("[data-card-flight]")).toHaveCount(0);
    await recordAnimations(ben.page);
    // The last vote reveals the round by itself, shown as the PO's reveal would be.
    await guestsVote(guests);

    await expect(status(ben.page)).toHaveAttribute("data-centre-status", "revealed");
    // 2, 3, 5, 5, 8, 8 and 13 average 6.3, nearest 5: two votes in seven.
    await expect(tableLive(ben.page)).toContainText("Cards revealed. Suggested 5. Agreement 29%.");
    // The cards show in the results' columns (#20), which replace #19's row.
    const row = ben.page.getByRole("list", { name: "Votes per card" });
    await expect(row.locator(".sr-only")).toHaveText([
      "2: 1 vote",
      "3: 1 vote",
      "5: 2 votes",
      "8: 2 votes",
      "13: 1 vote",
    ]);
    await expect(ben.page.getByRole("list", { name: "Not counted" })).toContainText(
      "unsure: 1 vote",
    );
    // The seats keep only who voted; their cards left for the columns.
    await expect(ben.page.locator("[data-face='up']")).toHaveCount(0);
    await expect(ben.page.locator("[data-face='gone']")).toHaveCount(8);
    await expect(seats(ben.page).getByRole("button", { name: "Cleo, voted" })).toHaveCount(1);
    // Nothing in the results names or points at a person, and nobody is lowest or highest.
    const rowHtml = await ben.page.locator("[data-results-panel]").innerHTML();
    for (const name of ["Ana", "Ben", ...GUESTS.map(([guest]) => guest)]) {
      expect(rowHtml).not.toContain(name);
    }
    expect(rowHtml).not.toMatch(/data-(you|seat|who|extreme|badge)/);
    await expect(ben.page.locator("[data-badge='lowest'], [data-badge='highest']")).toHaveCount(0);
    await expect(ben.page.locator("[data-results]")).toHaveCount(0);

    // The seats' cards faded, then the columns rose 60 ms apart. The last vote and the
    // reveal came in one snapshot: that card never lay face down on a seat.
    const motion = await animated(ben.page);
    const fades = motion.filter((a) => a.target === "cover");
    expect(fades).toHaveLength(7);
    expect(fades.every((a) => a.duration === 350 && a.keyframes.includes("scale(0.6)"))).toBe(true);
    const risen = motion.filter((a) => a.target === "bar");
    expect(risen.map((a) => a.delay)).toEqual([350, 410, 470, 530, 590]);
    expect(risen.every((a) => a.duration === 500 && a.keyframes.includes("scaleY(0)"))).toBe(true);

    // On the wire: before the reveal no card but Ben's own; after it, cards in the deck's
    // order with no voter, and no vote cause that names anyone.
    const others = ["2", "3", "5", "13", "?"];
    for (const snapshot of snapshotsIn(ben.frames)) {
      const round = snapshot.room.round as { phase?: string; cards?: string[] } | null;
      if (round?.phase !== "revealed") {
        expect(cardLeaks(snapshot, others)).toEqual([]);
        continue;
      }
      expect(round).not.toHaveProperty("votes");
      expect(round.cards).toEqual(["2", "3", "5", "5", "8", "8", "13", "?"]);
      for (const cause of snapshot.causes as Array<{ type: string; who?: string }>) {
        if (cause.type === "voteCast" || cause.type === "voteRetracted") {
          expect(cause).not.toHaveProperty("who");
        }
      }
    }
    for (const frame of ben.frames) expect(frame).not.toContain('"votes"');
    expect(snapshotsIn(ben.frames).some((s) => s.room.round !== null)).toBe(true);
    await shoot(page, "reveal-anonymous");
    await shoot(ben.page, "results-anonymous");

    // A late look (a reload) shows the columns and the seats at rest.
    await recordAnimations(ben.page, { reload: true });
    await expect(row.getByRole("listitem")).toHaveCount(5);
    await expect(ben.page.locator("[data-face='gone']")).toHaveCount(8);
    await ben.page.waitForTimeout(300);
    expect(await animated(ben.page)).toEqual([]);
  } finally {
    po.close();
    await closeAll(guests, [ben]);
  }
});

test("R reveals for the PO on the table or the hand only, and reduced motion only cross-fades (AC 3)", async ({
  page,
  baseURL,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  const code = await createRoom(page);
  await join(page, "Ana");
  const [ben] = await Promise.all([newGuest(baseURL ?? "")]);
  try {
    if (!ben) throw new Error("no guest");
    expect(await ben.enter(code)).toMatchObject({ ok: true });
    expect(await ben.cmd("join", { name: "Ben", role: "voter" })).toMatchObject({ ok: true });
    await expect(seats(page).locator("[data-seat]")).toHaveCount(2);
    await page.getByRole("button", { name: "Start voting" }).click();
    await expect(status(page)).toHaveText("0/2 voted so far");
    await handCard(page, "5").click();
    await expect(status(page)).toHaveText("1/2 voted so far");
    await expect(page.locator("[data-card-flight]")).toHaveCount(0);

    // In the PO's subject field (#21) R is a letter too.
    const subject = page.getByRole("textbox", { name: "Subject of the next round" });
    await subject.click();
    await page.keyboard.press("r");
    await expect(subject).toHaveValue("r");
    await page.waitForTimeout(300);
    await expect(status(page)).toHaveText("1/2 voted so far");
    await subject.fill("");

    // In the name field R is a letter.
    await page.getByRole("button", { name: "Change your name" }).click();
    const field = page.getByRole("textbox", { name: "Your name" });
    await expect(field).toBeFocused();
    await page.keyboard.press("r");
    await expect(field).toHaveValue(/r$/);
    await page.waitForTimeout(300);
    await expect(status(page)).toHaveText("1/2 voted so far");
    await page.getByRole("button", { name: "Cancel" }).click();
    await expect(page.getByRole("button", { name: "Change your name" })).toBeFocused();

    // R acts only where the focus is on the table or the hand (WCAG 2.1.4): not on the
    // page itself, nor in the header's open Language menu.
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await expect
      .poll(() => page.evaluate(() => document.activeElement === document.body))
      .toBe(true);
    await page.keyboard.press("r");
    await page.getByRole("button", { name: /^Language: English$/ }).click();
    await expect(page.getByRole("menu")).toBeVisible();
    await page.keyboard.press("r");
    await page.waitForTimeout(300);
    await expect(status(page)).toHaveText("1/2 voted so far");
    await page.keyboard.press("Escape");
    await expect(page.getByRole("menu")).toHaveCount(0);

    // On a card of the hand, R reveals; Ctrl+R would reload, so not that.
    await expect(revealButton(page)).toHaveAttribute("title", /table or your cards/);
    await handCard(page, "5").focus();
    await recordAnimations(page);
    await page.keyboard.press("r");
    await expect(page.locator("[data-face='up']")).toHaveCount(1);
    await expect(page.getByRole("button", { name: "Next round" })).toBeVisible();
    // The focus was on a card, which stays: only a focus the reveal took away moves.
    await expect(handCard(page, "5")).toBeFocused();
    await expect(tableLive(page)).toContainText("Cards revealed.");

    // Reduced motion: the back fades off the face in 120 ms, nothing turns.
    const motion = await animated(page);
    expect(motion.some((a) => a.target === "cover" && a.duration === 120)).toBe(true);
    expect(motion.filter((a) => a.keyframes.includes("rotate"))).toEqual([]);
    expect(motion.filter((a) => a.keyframes.includes("transform"))).toEqual([]);
  } finally {
    ben?.close();
  }
});
