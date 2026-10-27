import { type Browser, expect, type Locator, type Page, test } from "@playwright/test";
import { isPublicCardPath, stringLeaves } from "../../../packages/protocol/src/leak-scan.ts";
import {
  createRoom,
  type Guest,
  guestsJoin,
  handCard,
  join,
  newPerson,
  ownAddress,
  packetsIn,
  recordFrames,
  SHOTS,
  type Snapshot,
  seats,
  shoot,
  snapshotsIn,
} from "./support.ts";

// Reveal modes (#28) in real browsers, against the real server and Postgres: under
// "Anyone who votes" a voter reveals by the button and by R while an observer has
// neither; the PO takes the reveal back mid-round and the voter's button leaves; with
// "Reveal when everyone has voted" off the round waits for the PO; and a voter's reveal of
// an anonymous round sends no frame that maps a person to a value. Needs DATABASE_URL;
// skipped without it locally, failing without it in CI.

test.skip(
  !process.env.DATABASE_URL && !process.env.CI,
  "needs DATABASE_URL: runs against the real server",
);
test.beforeAll(() => {
  if (!process.env.DATABASE_URL) {
    throw new Error("CI must run the reveal-modes tests: set DATABASE_URL");
  }
});
test.beforeEach(async ({ page }) => {
  await page.setExtraHTTPHeaders(ownAddress());
});

const status = (page: Page) => page.locator("[data-centre] [data-centre-status]");
const revealButton = (page: Page) => page.getByRole("button", { name: "Reveal cards" });
const tableLive = (page: Page) => page.locator("[data-table-live]");
const settingsPanel = (page: Page) => page.getByRole("dialog", { name: "Room settings" });
const settingRow = (page: Page, key: string) =>
  settingsPanel(page).locator(`[data-setting="${key}"]`);

/** Opens the PO's settings panel and lets the sheet slide in. */
async function openSettings(page: Page) {
  await page.getByRole("button", { name: "Room settings" }).click();
  const dialog = settingsPanel(page);
  await expect(dialog).toBeVisible();
  await dialog.evaluate((element) =>
    Promise.all(element.getAnimations().map((animation) => animation.finished)),
  );
  return dialog;
}

/** Waits until the change of `key` is saved: the server's snapshot confirmed it. */
async function saved(page: Page, key: string) {
  await expect(settingRow(page, key)).not.toHaveAttribute("data-pending", "true");
}

/** In the open panel: who can reveal. */
async function chooseRevealer(page: Page, name: "Anyone who votes" | "The product owner") {
  const radio = settingRow(page, "whoCanReveal").getByRole("radio", { name, exact: true });
  await radio.click();
  await expect(radio).toBeChecked();
  await saved(page, "whoCanReveal");
}

async function closeSettings(page: Page) {
  await page.keyboard.press("Escape");
  await expect(settingsPanel(page)).toBeHidden();
}

async function person(browser: Browser, url: string, name: string, role?: "Observer") {
  const someone = await newPerson(browser);
  const frames = recordFrames(someone.page);
  await someone.page.goto(url);
  await join(someone.page, name, role);
  return { ...someone, frames };
}

/** Whether the element has the page's focus. */
const focused = (locator: Locator) =>
  locator.evaluate((element) => element === document.activeElement);

test("under anyone who votes, a voter reveals by the button and by R; an observer cannot", async ({
  page,
  browser,
}) => {
  test.setTimeout(120_000);
  await createRoom(page);
  await join(page, "Pia");
  const ben = await person(browser, page.url(), "Ben");
  const olga = await person(browser, page.url(), "Olga", "Observer");
  try {
    await openSettings(page);
    await chooseRevealer(page, "Anyone who votes");
    await expect(tableLive(ben.page)).toHaveText("Anyone who votes can now reveal the cards.");
    await shootControl(page);
    await closeSettings(page);

    await page.getByRole("button", { name: "Start voting" }).click();
    await expect(status(ben.page)).toHaveText("0/2 voted so far");
    // Ben's centre holds the PO's button; Olga's holds none.
    await expect(revealButton(ben.page)).toBeVisible();
    await expect(revealButton(ben.page)).toHaveAttribute("aria-keyshortcuts", "R");
    await expect(status(olga.page)).toHaveText("0/2 voted so far");
    await expect(revealButton(olga.page)).toHaveCount(0);
    await handCard(ben.page, "5").click();
    await expect(status(page)).toHaveText("1/2 voted so far");
    await shoot(ben.page, "reveal-modes-voter");

    // On a phone the button ends above Ben's hand, docked or not.
    await ben.page.setViewportSize({ width: 390, height: 844 });
    await ben.page.evaluate(() => window.scrollTo(0, 0));
    const button = await revealButton(ben.page).boundingBox();
    const hand = await ben.page.getByRole("toolbar", { name: "Your cards" }).boundingBox();
    expect(button && hand && button.y + button.height <= hand.y).toBe(true);
    await ben.page.setViewportSize({ width: 1280, height: 720 });

    // An observer's R on the table does nothing.
    await seats(olga.page).getByRole("button").first().focus();
    await olga.page.keyboard.press("r");
    await olga.page.waitForTimeout(500);
    await expect(status(page)).toHaveAttribute("data-centre-status", "voting");

    // Ben's button reveals; the focus moves to the result in his centre.
    await revealButton(ben.page).click();
    for (const viewer of [page, ben.page, olga.page]) {
      await expect(status(viewer)).toHaveAttribute("data-centre-status", "revealed");
    }
    await expect(tableLive(page)).toContainText("Ben revealed the cards. Suggested 5.");
    await expect(tableLive(olga.page)).toContainText("Ben revealed the cards.");
    await expect(tableLive(ben.page)).toContainText("Cards revealed.");
    await expect.poll(() => focused(status(ben.page))).toBe(true);
    // Voters have no decision bar.
    await expect(ben.page.getByRole("button", { name: "Next round" })).toHaveCount(0);

    // Round 2: R from Ben's hand reveals too.
    await page.getByRole("button", { name: "Next round" }).click();
    await expect(status(ben.page)).toHaveText("0/2 voted so far");
    await handCard(ben.page, "8").click();
    await handCard(ben.page, "8").focus();
    await ben.page.keyboard.press("r");
    await expect(status(page)).toHaveAttribute("data-centre-status", "revealed");
    await expect(tableLive(page)).toContainText("Ben revealed the cards.");
  } finally {
    await ben.context.close();
    await olga.context.close();
  }
});

test("the PO takes the reveal back mid-round: the voter's button leaves, the focus to the count", async ({
  page,
  browser,
}) => {
  test.setTimeout(90_000);
  await createRoom(page);
  await join(page, "Pia");
  const ben = await person(browser, page.url(), "Ben");
  try {
    await openSettings(page);
    await chooseRevealer(page, "Anyone who votes");
    await closeSettings(page);
    await page.getByRole("button", { name: "Start voting" }).click();
    await expect(revealButton(ben.page)).toBeVisible();
    await revealButton(ben.page).focus();

    await openSettings(page);
    await chooseRevealer(page, "The product owner");
    await expect(revealButton(ben.page)).toHaveCount(0);
    await expect(tableLive(ben.page)).toHaveText(
      "Only the product owner can reveal the cards now.",
    );
    // Never lost to the page's body.
    await expect.poll(() => focused(status(ben.page))).toBe(true);
    await expect(status(ben.page)).toHaveAttribute("data-centre-status", "voting");
    // The PO's own button stays.
    await closeSettings(page);
    await expect(revealButton(page)).toBeVisible();
  } finally {
    await ben.context.close();
  }
});

test("with the automatic reveal off, everyone votes and the round waits for the PO", async ({
  page,
  browser,
}) => {
  test.setTimeout(90_000);
  await createRoom(page);
  await join(page, "Pia");
  const ben = await person(browser, page.url(), "Ben");
  try {
    await openSettings(page);
    const auto = settingsPanel(page).getByRole("switch", {
      name: "Reveal when everyone has voted",
    });
    await auto.click();
    await expect(auto).toHaveAttribute("aria-checked", "false");
    await saved(page, "revealWhenAllVoted");
    await closeSettings(page);
    await expect(tableLive(ben.page)).toHaveText(
      "The cards now wait for a reveal, even once everyone has voted.",
    );

    await page.getByRole("button", { name: "Start voting" }).click();
    await handCard(page, "3").click();
    await handCard(ben.page, "5").click();
    await expect(status(ben.page)).toHaveText("2/2 voted so far");
    await page.waitForTimeout(500);
    for (const viewer of [page, ben.page]) {
      await expect(status(viewer)).toHaveAttribute("data-centre-status", "voting");
    }
    // The switch says beforehand that turning it on would reveal now.
    await openSettings(page);
    await expect(
      settingRow(page, "revealWhenAllVoted").locator("[data-setting-detail]"),
    ).toHaveText("Everyone has voted: turning this on reveals the cards.");
    await closeSettings(page);

    await revealButton(page).click();
    for (const viewer of [page, ben.page]) {
      await expect(status(viewer)).toHaveAttribute("data-centre-status", "revealed");
    }
    await expect(tableLive(ben.page)).toContainText("Cards revealed.");
  } finally {
    await ben.context.close();
  }
});

/** What these tests read of a round on the wire. */
interface WireRound {
  number: number;
  phase: string;
  anonymous: boolean;
  cards?: string[];
}

/** The snapshot a packet carries: a `snapshot` event, or an `enter` ack. */
function snapshotOf(packet: unknown): Snapshot | undefined {
  if (!Array.isArray(packet)) return undefined;
  const [first, second] = packet as unknown[];
  if (first === "snapshot") return second as Snapshot;
  if (typeof first === "object" && first !== null && "snapshot" in first) {
    return (first as { snapshot: Snapshot }).snapshot;
  }
  return undefined;
}

/** The strings of a packet equal to one of `cards` outside the paths that may hold one. */
function leaksIn(packet: unknown, cards: readonly string[], allowed = isPublicCardPath) {
  return stringLeaves(packet)
    .map(({ path, value }) => ({ path: path.replace(/^\d+\.(snapshot\.)?/, ""), value }))
    .filter((leaf) => cards.includes(leaf.value) && !allowed(leaf.path));
}

test("under anyone who votes, a voter reveals an anonymous round and no frame maps a person to a value", async ({
  page,
  browser,
  baseURL,
}) => {
  test.setTimeout(120_000);
  const code = await createRoom(page);
  await join(page, "Pia");
  const ben = await person(browser, page.url(), "Ben");
  const olga = await person(browser, page.url(), "Olga", "Observer");
  let guests: Guest[] = [];
  try {
    guests = await guestsJoin(baseURL ?? "", code, ["Cleo", "Dan"]);
    await openSettings(page);
    await chooseRevealer(page, "Anyone who votes");
    const anonymous = settingsPanel(page).getByRole("switch", { name: "Anonymous voting" });
    await anonymous.click();
    await expect(anonymous).toHaveAttribute("aria-checked", "true");
    await saved(page, "revealNames");
    await closeSettings(page);

    await page.getByRole("button", { name: "Start voting" }).click();
    await expect(status(ben.page)).toHaveText("0/4 voted so far");
    await handCard(page, "5").click();
    await handCard(ben.page, "8").click();
    const [cleo] = guests;
    expect(await cleo?.cmd("castVote", { card: "3", round: 1, restart: 0 })).toMatchObject({
      ok: true,
    });
    // Dan does not vote: Ben's reveal, not the last vote, turns the cards.
    await expect(status(ben.page)).toHaveText("3/4 voted so far");
    await revealButton(ben.page).click();
    for (const viewer of [page, ben.page, olga.page]) {
      await expect(status(viewer)).toHaveAttribute("data-centre-status", "revealed");
    }
    await expect(tableLive(page)).toContainText("Ben revealed the cards.");
    await expect(tableLive(olga.page)).toContainText("Ben revealed the cards.");

    const played = ["3", "5", "8"];
    const benId = snapshotsIn(ben.frames)
      .map((s) => (s.room as { you?: string | null }).you)
      .find((id) => typeof id === "string");
    expect(benId).toBeTruthy();
    for (const [who, frames, own] of [
      ["Ben", ben.frames, ["8"]],
      ["Olga", olga.frames, []],
    ] as const) {
      let revealed = 0;
      for (const frame of frames) expect(frame, who).not.toContain('"votes"');
      for (const packet of packetsIn(frames)) {
        const snapshot = snapshotOf(packet);
        const round = snapshot?.room.round as WireRound | null | undefined;
        if (round?.phase !== "revealed") {
          // While voting, no card but the viewer's own anywhere.
          const others = played.filter((card) => !own.includes(card as never));
          expect(leaksIn(packet, others), who).toEqual([]);
          continue;
        }
        revealed += 1;
        expect(round.anonymous, who).toBe(true);
        expect(round.cards, who).toEqual(played);
        for (const cause of snapshot?.causes ?? []) {
          const named = cause as { type: string; who?: string };
          if (named.type.startsWith("vote")) expect(named, who).not.toHaveProperty("who");
          // Who revealed travels, and ties nobody to a card.
          if (named.type === "revealed") expect(named, who).toEqual({ ...named, who: benId });
        }
        expect(
          leaksIn(
            packet,
            played,
            (path) =>
              isPublicCardPath(path) ||
              path.startsWith("room.round.cards.") ||
              path.startsWith("room.round.results."),
          ),
          who,
        ).toEqual([]);
      }
      expect(revealed, `${who} saw the round revealed`).toBeGreaterThan(0);
    }
  } finally {
    for (const guest of guests) guest.close();
    await ben.context.close();
    await olga.context.close();
  }
});

/** The panel's "Who can reveal" at 360 and 1440 px, light and dark, scrolled into view. */
async function shootControl(page: Page) {
  const row = settingRow(page, "whoCanReveal");
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    for (const width of [360, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      await page.waitForTimeout(150);
      await settingsPanel(page).evaluate((element) =>
        Promise.all(element.getAnimations().map((animation) => animation.finished)),
      );
      await row.scrollIntoViewIfNeeded();
      await page.screenshot({ path: `${SHOTS}reveal-modes-panel-${width}-${scheme}.png` });
    }
  }
  await page.emulateMedia({ colorScheme: "light" });
  await page.setViewportSize({ width: 1280, height: 720 });
}
