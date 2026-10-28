import { expect, test } from "@playwright/test";
import {
  type Ack,
  dbQuery,
  guestsJoin,
  join,
  ownAddress,
  packetsIn,
  ROOM_PATH,
  recordFrames,
  sameUser,
} from "./support.ts";

// The summary (#34) over a long history, against the real server and Postgres: 1,050
// finished rounds (one played, the rest copied from it in the database). Review found the
// first summary re-reading every page on each open and going on after the panel closed:
// opened and closed three times, then a vote every 100 ms, it sent 111 history requests,
// 27 were refused and so were 4 of the 20 votes, which the client does not send again.
// Here the panel opens and closes three times, opens again, and the same person votes
// every 100 ms on a socket of their own while the summary reads: every vote counts, no
// request of any kind is refused, and the summary reads each page once. Last, a page
// without a clipboard: the text to copy gets the focus, selected. Needs DATABASE_URL.

test.skip(
  !process.env.DATABASE_URL && !process.env.CI,
  "needs DATABASE_URL: runs against the real server",
);
test.beforeAll(() => {
  if (!process.env.DATABASE_URL) {
    throw new Error("CI must run the summary load test: set DATABASE_URL");
  }
});
test.beforeEach(async ({ page }) => {
  await page.setExtraHTTPHeaders(ownAddress());
});

const ROUNDS = 1050;

async function ok(ack: Promise<Ack>, what: string) {
  expect(await ack, what).toMatchObject({ ok: true });
}

test("a long history never costs a vote: the summary paces its pages and keeps them", async ({
  page,
  context,
  baseURL,
}) => {
  test.setTimeout(120_000);
  const base = baseURL ?? "";
  const frames = recordFrames(page);
  await page.goto("/");
  await page.getByRole("textbox", { name: /^Room name/ }).fill("Long history");
  await page.getByRole("button", { name: "Create the room" }).click();
  await expect(page).toHaveURL(ROOM_PATH);
  const code = ROOM_PATH.exec(page.url())?.[1] ?? "";
  await join(page, "Ana");
  // Ana's own second socket: the server's message budget is one per person.
  const ana = await sameUser(base, context);
  const [ben] = await guestsJoin(base, code, ["Ben"]);
  if (!ben) throw new Error("Ben did not join");
  try {
    await ok(ana.enter(code), "enter");
    await ok(ana.cmd("updateSettings", { patch: { revealWhenAllVoted: false } }), "settings");
    await ok(ana.cmd("startRound", { subject: { kind: "title", text: "Story 1" } }), "round 1");
    await ok(ana.cmd("castVote", { card: "5", round: 1 }), "vote");
    await ok(ben.cmd("castVote", { card: "8", round: 1 }), "vote");
    await ok(ana.cmd("reveal"), "reveal");
    await ok(ana.cmd("setFinal", { card: "5" }), "final");
    await ok(ana.cmd("startRound", { subject: { kind: "none" } }), "round 2");
    // Round 1's row, copied as rounds 3 to 1,051: 1,050 finished rounds, all today.
    const [room] = await dbQuery<{ id: string }>("select id from room where code = $1", [code]);
    await dbQuery(
      `insert into round_history
         (room_id, number, subject, deck, votes, stats, final, started_at, revealed_at, finished_at)
       select room_id, n, jsonb_build_object('kind', 'title', 'text', 'Story ' || n), deck,
              votes, stats, final, started_at, revealed_at, finished_at
       from round_history, generate_series(3, $2::int) as n
       where room_id = $1 and number = 1`,
      [room?.id, ROUNDS + 1],
    );

    const history = page.getByRole("button", { name: "History" });
    const panel = page.getByRole("dialog", { name: "History" });
    for (let i = 0; i < 3; i++) {
      await history.click();
      await expect(panel).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(panel).toBeHidden();
    }
    await history.click();
    await expect(panel).toBeVisible();
    // While the summary reads, a vote every 100 ms.
    const votes: Promise<Ack>[] = [];
    for (let i = 0; i < 20; i++) {
      votes.push(ana.cmd("castVote", { card: i % 2 === 0 ? "3" : "5", round: 2 }));
      await page.waitForTimeout(100);
    }
    expect((await Promise.all(votes)).filter((ack) => !ack.ok)).toEqual([]);

    const summary = panel.locator("[data-history-summary]");
    await expect(summary.locator("[data-summary-stat=rounds] dd").first()).toHaveText("1,000", {
      timeout: 30_000,
    });
    await expect(summary.locator("[data-summary-capped]")).toHaveText(
      "Only the latest 1,000 rounds are counted.",
    );
    const packets = packetsIn(frames);
    expect(JSON.stringify(packets)).not.toContain('"rate_limited"');
    const answers = packets.filter(
      (packet) =>
        Array.isArray(packet) &&
        typeof packet[0] === "object" &&
        packet[0] !== null &&
        "rounds" in packet[0],
    );
    // Four opens: the list's first page and the summary's each time, its 19 earlier pages
    // once, and at most one page dropped by each close.
    expect(answers.length).toBeLessThanOrEqual(4 + 4 + 19 + 3);

    // No clipboard (plain-http hosting): the text to copy takes the focus, all selected,
    // and keeps it after the menu closed.
    await page.evaluate(() =>
      Object.defineProperty(Navigator.prototype, "clipboard", {
        get: () => undefined,
        configurable: true,
      }),
    );
    await panel.getByRole("button", { name: "Export" }).click();
    await page.getByRole("menuitem", { name: "Copy Markdown" }).click();
    const field = panel.getByRole("textbox", { name: "Text to copy" });
    await expect(field).toBeFocused();
    await page.waitForTimeout(300);
    await expect(field).toBeFocused();
    expect(
      await field.evaluate(
        (element: HTMLTextAreaElement) =>
          element.selectionStart === 0 && element.selectionEnd === element.value.length,
      ),
    ).toBe(true);
    await expect(field).toHaveValue(/^# Poker Planning: Long history$/m);
  } finally {
    ana.close();
    ben.close();
  }
});
