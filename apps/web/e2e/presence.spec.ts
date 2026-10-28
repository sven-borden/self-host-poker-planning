import { cardLeaks } from "../../../packages/protocol/src/leak-scan.ts";
import { expect, type Page, test } from "./fixtures.ts";
import {
  createRoom,
  join,
  newGuest,
  newPerson,
  ownAddress,
  recordFrames,
  sameUser,
  seats,
  shoot,
  snapshotsIn,
} from "./support.ts";

// The live table (#17) in real browsers, against the real server and Postgres: closing a
// tab marks the person away for the others within 20 s, with the real 15 s grace, and
// back on return (AC 1); the live region says "Ana voted." without the card, and the
// page's frames never carry it (AC 3). The layout from 1 to 16 people (AC 2) is
// table.spec.ts on the bench. Needs DATABASE_URL; skipped without it locally, failing
// without it in CI.

test.skip(
  !process.env.DATABASE_URL && !process.env.CI,
  "needs DATABASE_URL: runs against the real server",
);
test.beforeAll(() => {
  if (!process.env.DATABASE_URL) {
    throw new Error("CI must run the presence tests: set DATABASE_URL");
  }
});
test.beforeEach(async ({ page }) => {
  await page.setExtraHTTPHeaders(ownAddress());
});

const live = (page: Page) => page.locator("[data-table-live]");
const awaySeats = (page: Page) => seats(page).locator("[data-seat][data-away]");

test("closing a tab marks the person away within 20 s, and back on return (AC 1)", async ({
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
    await expect(seats(page).locator("[data-seat]")).toHaveCount(2);
    await expect(awaySeats(page)).toHaveCount(0);

    // Ben closes his tab: nothing during the 15 s grace, then away, within 20 s.
    const closedAt = Date.now();
    await ben.page.close();
    await expect(awaySeats(page)).toHaveCount(1, { timeout: 20_000 });
    const elapsed = Date.now() - closedAt;
    expect(elapsed).toBeGreaterThanOrEqual(14_000);
    expect(elapsed).toBeLessThan(20_000);
    await expect(awaySeats(page)).toContainText("Ben, away");
    await expect(awaySeats(page).locator('[data-badge="away"]')).toHaveCount(1);
    await expect(live(page)).toHaveText("Ben is away.");
    await shoot(page, "presence-away");
    await page.setViewportSize({ width: 1280, height: 900 });

    // Ben opens the room again: back at once.
    const again = await ben.context.newPage();
    await again.goto(page.url());
    await expect(again.getByRole("heading", { name: "You", exact: true })).toBeVisible();
    await expect(awaySeats(page)).toHaveCount(0, { timeout: 5_000 });
    await expect(live(page)).toHaveText("Ben is back.");
    await expect(seats(page)).toContainText("Ben");
  } finally {
    await ben.context.close();
  }
});

test("the live region says who voted, never the card (AC 3)", async ({
  page,
  context,
  baseURL,
}) => {
  const base = baseURL ?? "";
  const frames = recordFrames(page);
  const code = await createRoom(page);
  await join(page, "Ben");
  // The vote UI is #18: Ben (the PO) starts the round and Ana votes over the protocol.
  const ben = await sameUser(base, context);
  const ana = await newGuest(base);
  try {
    expect(await ana.enter(code)).toMatchObject({ ok: true });
    expect(await ana.cmd("join", { name: "Ana", role: "voter" })).toMatchObject({ ok: true });
    await expect(live(page)).toHaveText("Ana joined.");
    expect(await ben.enter(code)).toMatchObject({ ok: true });
    expect(await ben.cmd("startRound", { subject: { kind: "none" } })).toMatchObject({ ok: true });
    expect(await ana.cmd("castVote", { card: "13", round: 1, restart: 0 })).toMatchObject({
      ok: true,
    });

    // The new round (#18) and the vote, usually in one batch, the round first.
    await expect(live(page)).toHaveText(/^(Voting started: Round 1\. )?Ana voted\.$/);
    const anaSeat = seats(page).locator("[data-seat]").filter({ hasText: "Ana" });
    await expect(anaSeat).toContainText("Ana, voted");
    await expect(anaSeat.locator('[data-badge="voted"]')).toHaveCount(1);
    await expect(page.locator('[data-face="down"]')).toHaveCount(1);
    await expect(page.locator("[data-room-table]")).not.toContainText("13");

    // The page's own frames: the vote shows as "voted", never as a card.
    await expect.poll(() => snapshotsIn(frames).some((s) => s.room.round !== null)).toBe(true);
    const snapshots = snapshotsIn(frames);
    expect(snapshots.some((s) => s.causes.some((c) => c.type === "voteCast"))).toBe(true);
    for (const snapshot of snapshots) expect(cardLeaks(snapshot, ["13"])).toEqual([]);
    for (const frame of frames) expect(frame).not.toContain('"13"');
  } finally {
    ana.close();
    ben.close();
  }
});
