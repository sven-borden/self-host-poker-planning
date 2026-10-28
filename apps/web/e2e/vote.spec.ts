import { cardLeaks } from "../../../packages/protocol/src/leak-scan.ts";
import { expect, type Locator, type Page, test, type WebSocketRoute } from "./fixtures.ts";
import {
  createRoom,
  join,
  newGuest,
  newPerson,
  ownAddress,
  recordFrames,
  SHOTS,
  sameUser,
  seats,
  shoot,
  snapshotsIn,
} from "./support.ts";

// Voting (#18) in real browsers, against the real server and Postgres: the cards a voter
// picks, changes and takes back never reach the others before the reveal (AC 1, named and
// anonymous), keyboard-only voting (AC 2), a vote refused after the reveal rolls back
// (AC 3), a vote in flight when the next round starts never lands in it, and the hand on
// a phone. Needs DATABASE_URL; skipped without it locally, failing without it in CI.

test.skip(
  !process.env.DATABASE_URL && !process.env.CI,
  "needs DATABASE_URL: runs against the real server",
);
test.beforeAll(() => {
  if (!process.env.DATABASE_URL) {
    throw new Error("CI must run the vote tests: set DATABASE_URL");
  }
});
test.beforeEach(async ({ page }) => {
  await page.setExtraHTTPHeaders(ownAddress());
});

const hand = (page: Page) => page.getByRole("toolbar", { name: "Your cards" });
const handCard = (page: Page, label: string) =>
  hand(page).getByRole("button", { name: label, exact: true });
const handLive = (page: Page) => page.locator("[data-hand-live]");
/** The centre's status line; the PO's buttons sit beside it (#19). */
const centre = (page: Page) => page.locator("[data-centre] [data-centre-status]");
const pressedCards = (page: Page) => hand(page).locator("button[aria-pressed='true']");

async function pick(page: Page, label: string, said: string) {
  await handCard(page, label).click();
  await expect(handLive(page)).toHaveText(said);
}

/** The card's trip to the seat is over: the slot shows again. */
async function landed(page: Page) {
  await expect(page.locator("[data-card-flight]")).toHaveCount(0);
  await expect(page.locator("[data-slot-card][data-you]")).toBeVisible();
}

for (const anonymous of [false, true]) {
  const mode = anonymous ? "anonymous" : "named";
  test(`others never receive the card before the reveal, in a ${mode} round (AC 1)`, async ({
    page,
    context,
    browser,
    baseURL,
  }) => {
    test.setTimeout(90_000);
    const base = baseURL ?? "";
    const code = await createRoom(page);
    await join(page, "Ana");
    const observer = await newPerson(browser);
    const voter = await newPerson(browser);
    const po = await sameUser(base, context);
    try {
      const observerFrames = recordFrames(observer.page);
      const voterFrames = recordFrames(voter.page);
      await observer.page.goto(page.url());
      await join(observer.page, "Obs", "Observer");
      await voter.page.goto(page.url());
      await join(voter.page, "Ben");
      await expect(seats(page).locator("[data-seat]")).toHaveCount(2);

      if (anonymous) {
        expect(await po.enter(code)).toMatchObject({ ok: true });
        expect(await po.cmd("updateSettings", { patch: { revealNames: false } })).toMatchObject({
          ok: true,
        });
      }
      // The lobby: the PO starts the round, the others wait.
      await expect(voter.page.locator("[data-centre]")).toHaveText("Waiting for the PO");
      await expect(handCard(voter.page, "5")).toHaveAttribute("aria-disabled", "true");
      if (!anonymous) await shoot(page, "vote-lobby");
      await page.getByRole("button", { name: "Start voting" }).click();
      await expect(centre(page)).toHaveText("0/2 voted so far");
      await expect(observer.page.getByRole("toolbar")).toHaveCount(0);
      if (!anonymous) await shoot(page, "vote-hand-empty");

      // Pick, change, take back, and vote again.
      await pick(page, "5", "Your vote: 5.");
      await expect(pressedCards(page)).toHaveAccessibleName("5");
      await expect(centre(voter.page)).toHaveText("1/2 voted so far");
      await pick(page, "8", "Your vote: 8.");
      await pick(page, "8", "Vote taken back.");
      await expect(pressedCards(page)).toHaveCount(0);
      await expect(centre(voter.page)).toHaveText("0/2 voted so far");
      await pick(page, "13", "Your vote: 13.");
      await expect(centre(observer.page)).toHaveText("1/2 voted so far");
      await expect(
        voter.page
          .locator("[data-seat]")
          .filter({ hasText: "Ana" })
          .locator('[data-badge="voted"]'),
      ).toHaveCount(1);
      await expect(page.locator("[data-slot-card][data-you] [data-face]")).toHaveAttribute(
        "data-face",
        "down",
      );
      await landed(page);
      if (!anonymous) await shoot(page, "vote-hand-voted");

      // Nothing the others received carries a card that was played.
      const played = ["5", "8", "13"];
      for (const frames of [observerFrames, voterFrames]) {
        const snapshots = snapshotsIn(frames);
        expect(snapshots.some((s) => s.causes.some((c) => c.type === "voteRetracted"))).toBe(true);
        for (const snapshot of snapshots) expect(cardLeaks(snapshot, played)).toEqual([]);
        for (const frame of frames) {
          for (const card of played) expect(frame).not.toContain(`"${card}"`);
        }
      }

      // The reveal (its button is #19's): the frames now hold the card, so they were read.
      if (!anonymous) expect(await po.enter(code)).toMatchObject({ ok: true });
      expect(await po.cmd("reveal")).toMatchObject({ ok: true });
      await expect(centre(voter.page)).toHaveAttribute("data-centre-status", "revealed");
      await expect.poll(() => observerFrames.some((frame) => frame.includes('"13"'))).toBe(true);
      if (anonymous) {
        // Still nobody's card: the revealed round lists cards, never who played them.
        const revealed = snapshotsIn(observerFrames).at(-1);
        expect(revealed?.room.round).toMatchObject({ phase: "revealed", cards: ["13"] });
        expect(revealed?.room.round).not.toHaveProperty("votes");
      }
      await expect(handCard(page, "13")).toHaveAttribute("aria-disabled", "true");
      await expect(page.getByRole("button", { name: "Next round" })).toBeVisible();
    } finally {
      po.close();
      await observer.context.close();
      await voter.context.close();
    }
  });
}

/** Presses Tab until `target` has the focus, which must then be visible. */
async function tabTo(page: Page, target: Locator, max = 60) {
  for (let i = 0; i < max; i++) {
    await page.keyboard.press("Tab");
    if (await target.evaluate((element) => element === document.activeElement)) {
      expect(await target.evaluate((element) => element.matches(":focus-visible"))).toBe(true);
      return;
    }
  }
  throw new Error(`Tab never reached ${target}`);
}

test("a person votes and takes the vote back with the keyboard only (AC 2)", async ({
  page,
  baseURL,
}) => {
  const code = await createRoom(page);
  // From the room's first tab stop: name, voter (the default), Enter joins.
  await page.reload();
  await tabTo(page, page.getByRole("textbox", { name: "Your name" }));
  await page.keyboard.type("Kay");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: "You", exact: true })).toBeFocused();
  // A second voter, so Kay's vote does not complete the round (automatic reveal).
  const ben = await newGuest(baseURL ?? "");
  try {
    expect(await ben.enter(code)).toMatchObject({ ok: true });
    expect(await ben.cmd("join", { name: "Ben", role: "voter" })).toMatchObject({ ok: true });
    await expect(seats(page).locator("[data-seat]")).toHaveCount(2);

    // Kay is the PO: she starts the round, from the first tab stop again.
    await page.reload();
    await tabTo(page, page.getByRole("button", { name: "Start voting" }));
    await page.keyboard.press("Enter");
    await expect(centre(page)).toHaveText("0/2 voted so far");
    // The button is gone; the focus went to the hand, not to the page's body.
    await expect(handCard(page, "0")).toBeFocused();

    // Every vote command the page sends, to count a held Enter's.
    const votes: string[] = [];
    page.on("websocket", (socket) =>
      socket.on("framesent", ({ payload }) => {
        const frame = String(payload);
        if (frame.includes('"castVote"') || frame.includes('"retractVote"')) votes.push(frame);
      }),
    );

    // One tab stop into the hand, arrows through it, Enter votes, Space takes it back.
    await page.reload();
    await tabTo(page, handCard(page, "0"));
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowRight");
    await expect(handCard(page, "2")).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(handLive(page)).toHaveText("Your vote: 2.");
    await expect(handCard(page, "2")).toHaveAttribute("aria-pressed", "true");
    await expect(centre(page)).toHaveText("1/2 voted so far");
    await page.keyboard.press("Space");
    await expect(handLive(page)).toHaveText("Vote taken back.");
    await expect(handCard(page, "2")).toHaveAttribute("aria-pressed", "false");
    await expect(handCard(page, "2")).toBeFocused();
    await expect(centre(page)).toHaveText("0/2 voted so far");

    // A held Enter votes once: its repeated keydowns press nothing.
    for (let i = 0; i < 6; i++) await page.keyboard.down("Enter");
    await page.keyboard.up("Enter");
    await expect(handLive(page)).toHaveText("Your vote: 2.");
    await page.waitForTimeout(300);
    await expect(handCard(page, "2")).toHaveAttribute("aria-pressed", "true");
    expect(votes).toHaveLength(3);
  } finally {
    ben.close();
  }
});

test("a vote the server refuses after the reveal rolls back (AC 3)", async ({
  page,
  context,
  browser,
  baseURL,
}) => {
  const base = baseURL ?? "";
  const code = await createRoom(page);
  await join(page, "Ana");
  const other = await newPerson(browser);
  // The page's own socket, proxied: its castVote is held until the PO has revealed.
  let upgraded = false;
  let holding = false;
  const held: Array<() => void> = [];
  await page.routeWebSocket(/\/socket\.io\//, (ws: WebSocketRoute) => {
    const server = ws.connectToServer();
    ws.onMessage((message) => {
      if (message === "5") upgraded = true;
      if (holding && String(message).includes('"castVote"')) {
        held.push(() => server.send(message));
        return;
      }
      server.send(message);
    });
    server.onMessage((message) => ws.send(message));
  });
  const po = await sameUser(base, context);
  try {
    await page.reload();
    await expect(page.getByRole("heading", { name: "You", exact: true })).toBeVisible();
    await other.page.goto(page.url());
    await join(other.page, "Ben");
    await page.getByRole("button", { name: "Start voting" }).click();
    await expect(centre(page)).toHaveText("0/2 voted so far");
    await expect.poll(() => upgraded, { message: "the socket upgraded" }).toBe(true);

    await pick(page, "3", "Your vote: 3.");
    holding = true;
    await handCard(page, "8").click();
    // Shown at once, before the server has it.
    await expect(pressedCards(page)).toHaveAccessibleName("8");
    await expect.poll(() => held.length).toBe(1);

    // The PO reveals (the button is #19's), then the held vote reaches the server.
    expect(await po.enter(code)).toMatchObject({ ok: true });
    expect(await po.cmd("reveal")).toMatchObject({ ok: true });
    await expect(centre(other.page)).toHaveAttribute("data-centre-status", "revealed");
    for (const send of held) send();

    await expect(page.getByRole("alert")).toHaveText(
      "The cards are already revealed, so votes can no longer change.",
    );
    await expect(pressedCards(page)).toHaveAccessibleName("3");
    await expect(handCard(page, "8")).toHaveAttribute("aria-disabled", "true");
    // The seat and the others agree: Ana's card is 3.
    await expect(other.page.locator("[data-seat]").filter({ hasText: "Ana" })).toContainText(
      "Ana, product owner, card 3",
    );
  } finally {
    po.close();
    await other.context.close();
  }
});

test("a vote in flight when the next round starts never lands in it", async ({
  page,
  context,
  browser,
  baseURL,
}) => {
  const base = baseURL ?? "";
  const code = await createRoom(page);
  await join(page, "Ana");
  const other = await newPerson(browser);
  let upgraded = false;
  let holding = false;
  const held: Array<() => void> = [];
  await page.routeWebSocket(/\/socket\.io\//, (ws: WebSocketRoute) => {
    const server = ws.connectToServer();
    ws.onMessage((message) => {
      if (message === "5") upgraded = true;
      if (holding && String(message).includes('"castVote"')) {
        held.push(() => server.send(message));
        return;
      }
      server.send(message);
    });
    server.onMessage((message) => ws.send(message));
  });
  const po = await sameUser(base, context);
  try {
    await page.reload();
    await expect(page.getByRole("heading", { name: "You", exact: true })).toBeVisible();
    await other.page.goto(page.url());
    await join(other.page, "Ben");
    await page.getByRole("button", { name: "Start voting" }).click();
    await expect(centre(page)).toHaveText("0/2 voted so far");
    await expect.poll(() => upgraded, { message: "the socket upgraded" }).toBe(true);

    // A double click votes once rather than voting and taking the vote back.
    await handCard(page, "5").dblclick();
    await expect(handLive(page)).toHaveText("Your vote: 5.");
    await expect(pressedCards(page)).toHaveAccessibleName("5");

    holding = true;
    await handCard(page, "8").click();
    await expect(pressedCards(page)).toHaveAccessibleName("8");
    await expect.poll(() => held.length).toBe(1);

    // The PO reveals and starts the next round, then the change made for round 1 arrives.
    expect(await po.enter(code)).toMatchObject({ ok: true });
    expect(await po.cmd("reveal")).toMatchObject({ ok: true });
    expect(await po.cmd("startRound", { subject: { kind: "none" } })).toMatchObject({ ok: true });
    await expect(centre(other.page)).toHaveText("0/2 voted so far");
    for (const send of held) send();

    // Refused with round_changed: the new round's hand stays empty, without a message.
    await page.waitForTimeout(500);
    await expect(pressedCards(page)).toHaveCount(0);
    await expect(handLive(page)).not.toHaveText("Your vote: 8.");
    await expect(page.getByRole("alert")).toHaveCount(0);
    await expect(centre(page)).toHaveText("0/2 voted so far");
    await expect(
      other.page.locator("[data-seat]").filter({ hasText: "Ana" }).locator('[data-badge="voted"]'),
    ).toHaveCount(0);
  } finally {
    po.close();
    await other.context.close();
  }
});

/** The page at 360 px, in both schemes. */
async function shootPhone(page: Page, name: string) {
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.waitForTimeout(150);
    await page.screenshot({ path: `${SHOTS}${name}-360-${scheme}.png`, fullPage: true });
  }
  await page.emulateMedia({ colorScheme: "light" });
}

test("on a phone the hand keeps the vote in view and shows more cards lie aside", async ({
  page,
  context,
  baseURL,
}) => {
  const base = baseURL ?? "";
  const code = await createRoom(page);
  await join(page, "Ana");
  const ben = await newGuest(base);
  const po = await sameUser(base, context);
  try {
    expect(await ben.enter(code)).toMatchObject({ ok: true });
    expect(await ben.cmd("join", { name: "Ben", role: "voter" })).toMatchObject({ ok: true });
    await page.setViewportSize({ width: 360, height: 800 });
    await page.getByRole("button", { name: "Start voting" }).click();
    await expect(centre(page)).toHaveText("0/2 voted so far");
    await expect(page.locator('[data-hand-fade="end"]')).toBeVisible();
    await pick(page, "21", "Your vote: 21.");

    // After a reload the hand scrolls itself to the vote.
    await page.reload();
    await expect(pressedCards(page)).toHaveAccessibleName("21");
    await landed(page);
    const inView = await hand(page).evaluate((bar) => {
      const card = bar.querySelector("[data-hand-card='21']");
      const box = bar.getBoundingClientRect();
      const at = card?.getBoundingClientRect();
      return {
        scrolled: bar.scrollLeft > 0,
        visible: at !== undefined && at.left >= box.left && at.right <= box.right,
      };
    });
    expect(inView).toEqual({ scrolled: true, visible: true });
    await expect(page.locator('[data-hand-fade="start"]')).toBeVisible();
    await shootPhone(page, "vote-hand-reload-21");

    // The T-shirt deck overflows too; a deck change restarts the round.
    expect(await po.enter(code)).toMatchObject({ ok: true });
    expect(
      await po.cmd("updateSettings", { patch: { deck: { kind: "preset", id: "tshirt" } } }),
    ).toMatchObject({ ok: true });
    await expect(handCard(page, "XL")).toBeVisible();
    // The hand kept its scroll through the change: more cards lie at its start.
    await expect(page.locator('[data-hand-fade="start"]')).toBeVisible();
    await page.reload();
    await expect(handCard(page, "XS")).toBeVisible();
    await expect(page.locator('[data-hand-fade="end"]')).toBeVisible();
    await expect(page.locator('[data-hand-fade="start"]')).toHaveCount(0);
    await shootPhone(page, "vote-hand-tshirt");
  } finally {
    po.close();
    ben.close();
  }
});
