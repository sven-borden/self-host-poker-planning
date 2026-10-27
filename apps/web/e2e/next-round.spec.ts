import { expect, type Page, test } from "@playwright/test";
import pg from "pg";
import { computeResults } from "../../../packages/domain/src/results.ts";
import {
  createRoom,
  type Guest,
  join,
  newGuest,
  newPerson,
  ownAddress,
  sameUser,
  seats,
  shoot,
} from "./support.ts";

// The next round with a subject (#21) in real browsers, against the real server and
// Postgres: three people play two rounds, one with a title and one with a Jira link, the
// votes clear and the number goes up each time, and every finished round lands in
// `round_history` (AC 2) with its subject, its votes and its stats, or only its cards in
// an anonymous round. Links open with rel="noopener noreferrer" and only http(s) (AC 1);
// a subject over 200 characters is refused in the browser and on the server (AC 3).
// Needs DATABASE_URL; skipped without it locally, failing without it in CI.

test.skip(
  !process.env.DATABASE_URL && !process.env.CI,
  "needs DATABASE_URL: runs against the real server",
);
test.beforeAll(() => {
  if (!process.env.DATABASE_URL) {
    throw new Error("CI must run the next-round tests: set DATABASE_URL");
  }
});
test.beforeEach(async ({ page }) => {
  await page.setExtraHTTPHeaders(ownAddress());
});

const hand = (page: Page) => page.getByRole("toolbar", { name: "Your cards" });
const handCard = (page: Page, label: string) =>
  hand(page).getByRole("button", { name: label, exact: true });
const pressedCards = (page: Page) => hand(page).locator("[aria-pressed='true']");
const tableLive = (page: Page) => page.locator("[data-table-live]");
const subjectLine = (page: Page) => page.locator("[data-round-subject]");
const subjectField = (page: Page) =>
  page.getByRole("textbox", { name: "Subject of the next round" });
const centreStatus = (page: Page) => page.locator("[data-centre-status='voting']");

interface HistoryRow {
  number: number;
  subject: unknown;
  votes: unknown;
  stats: unknown;
  text: string;
}

/** The room's `round_history` rows, read straight from Postgres (the history UI is #33). */
async function historyOf(code: string): Promise<HistoryRow[]> {
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  client.on("error", () => {});
  await client.connect();
  try {
    const { rows } = await client.query<HistoryRow>(
      `select h.number, h.subject, h.votes, h.stats, row_to_json(h)::text as text
      from round_history h join room r on r.id = h.room_id where r.code = $1
      order by h.number`,
      [code],
    );
    return rows;
  } finally {
    await client.end();
  }
}

test("three people, a titled round then a Jira round: votes clear, the number rises, history is written (AC 1, AC 2)", async ({
  page,
  browser,
}) => {
  test.setTimeout(150_000);
  const code = await createRoom(page);
  await join(page, "Ana");
  const ben = await newPerson(browser);
  const cleo = await newPerson(browser);
  try {
    for (const [person, name] of [
      [ben.page, "Ben"],
      [cleo.page, "Cleo"],
    ] as const) {
      await person.goto(page.url());
      await join(person, name);
    }
    const everyone = [page, ben.page, cleo.page];
    await expect(seats(page).locator("[data-seat]")).toHaveCount(3);
    // Only the PO has the field.
    await expect(subjectField(page)).toBeVisible();
    await expect(subjectField(ben.page)).toHaveCount(0);
    await shoot(page, "next-round-lobby-po");

    // Round 1, with a title.
    const title = "Split invoices by currency";
    await subjectField(page).fill(title);
    await page.getByRole("button", { name: "Start voting" }).click();
    for (const viewer of everyone) {
      await expect(subjectLine(viewer)).toHaveText(`Round 1${title}`);
      await expect(subjectLine(viewer).locator("bdi")).toHaveText(title);
      await expect(centreStatus(viewer)).toHaveText("0/3 voted so far");
    }
    await expect(tableLive(ben.page)).toContainText(`Voting started: ${title}.`);
    await expect(subjectField(page)).toHaveValue("");
    await handCard(page, "5").click();
    await handCard(ben.page, "8").click();
    await handCard(cleo.page, "5").click();
    await expect(page.getByRole("button", { name: "Next round" })).toBeVisible();
    await page.waitForTimeout(1_500);
    await shoot(page, "next-round-title-po");
    await shoot(ben.page, "next-round-title");
    expect(await historyOf(code)).toEqual([]);

    // Round 2, with a Jira link, started with Enter in the field.
    const url = "https://acme.atlassian.net/browse/PAY-482";
    await subjectField(page).fill(url);
    await subjectField(page).press("Enter");
    for (const viewer of everyone) {
      await expect(centreStatus(viewer)).toHaveText("0/3 voted so far");
      await expect(pressedCards(viewer)).toHaveCount(0);
      const link = viewer.getByRole("link", { name: "PAY-482 (opens in a new tab)" });
      await expect(link).toHaveAttribute("href", url);
      await expect(link).toHaveAttribute("rel", "noopener noreferrer");
      await expect(link).toHaveAttribute("target", "_blank");
      await expect(subjectLine(viewer)).toContainText("Round 2");
    }
    await expect(tableLive(cleo.page)).toContainText("Voting started: PAY-482.");
    // The focus stays in the field, which now says when its subject will be used.
    await expect(subjectField(page)).toBeFocused();
    await expect(
      page.getByText("Round 3 will start with this subject after the reveal."),
    ).toBeVisible();

    // AC 2: the finished round 1, with its subject, its votes and its stats.
    const [first, ...others] = await historyOf(code);
    expect(others).toEqual([]);
    expect(first).toMatchObject({
      number: 1,
      subject: { kind: "title", text: title },
      votes: {
        kind: "named",
        votes: [
          { name: "Ana", card: "5" },
          { name: "Ben", card: "8" },
          { name: "Cleo", card: "5" },
        ],
      },
      stats: computeResults(["5", "8", "5"], { kind: "preset", id: "fib" }),
    });

    await handCard(page, "3").click();
    await handCard(ben.page, "3").click();
    await handCard(cleo.page, "3").click();
    await expect(page.getByRole("button", { name: "Next round" })).toBeVisible();
    await page.waitForTimeout(1_500);
    await shoot(page, "next-round-link-po");
    await shoot(cleo.page, "next-round-link");

    // Round 3, no subject: "Round 3", and round 2 is history with the key the server read.
    await page.getByRole("button", { name: "Next round" }).click();
    for (const viewer of everyone) {
      await expect(subjectLine(viewer)).toHaveText("Round 3");
      await expect(viewer.locator("[data-subject-link]")).toHaveCount(0);
    }
    await expect(tableLive(ben.page)).toContainText("Voting started: Round 3.");
    const rows = await historyOf(code);
    expect(rows.map((row) => row.number)).toEqual([1, 2]);
    expect(rows[1]?.subject).toEqual({ kind: "link", url, key: "PAY-482" });
    await shoot(page, "next-round-none-po");
  } finally {
    await ben.context.close();
    await cleo.context.close();
  }
});

test("the browser and the server refuse other schemes, credentials and a title over 200 characters (AC 1, AC 3)", async ({
  page,
  context,
  baseURL,
}) => {
  test.setTimeout(60_000);
  const code = await createRoom(page);
  await join(page, "Ana");
  const po = await sameUser(baseURL ?? "", context);
  try {
    expect(await po.enter(code)).toMatchObject({ ok: true });
    const badLink = "Only http and https links work, without a user name or password.";
    for (const [draft, message] of [
      ["javascript:alert(1)", badLink],
      ["data:text/html,<script>alert(1)</script>", badLink],
      ["http://user:pass@acme.atlassian.net/browse/PAY-1", badLink],
      ["x".repeat(201), "A title can have at most 200 characters."],
    ] as const) {
      await subjectField(page).fill(draft);
      await page.getByRole("button", { name: "Start voting" }).click();
      await expect(page.locator("[data-next-subject] [role='alert']")).toHaveText(message);
      await expect(subjectField(page)).toHaveAttribute("aria-invalid", "true");
      await expect(subjectField(page)).toHaveValue(draft);
    }
    await shoot(page, "next-round-refused-po");
    // The page sent nothing: still the lobby.
    await expect(subjectLine(page)).toHaveCount(0);
    // The server refuses the same subjects, whoever sends them.
    for (const subject of [
      { kind: "link", url: "javascript:alert(1)" },
      { kind: "link", url: "data:text/html,x" },
      { kind: "link", url: "http://user:pass@acme.atlassian.net/browse/PAY-1" },
      { kind: "title", text: "x".repeat(201) },
    ]) {
      expect(await po.cmd("startRound", { subject })).toEqual({ ok: false, code: "bad_subject" });
    }
    // 200 characters are a title.
    await subjectField(page).fill("x".repeat(200));
    await page.getByRole("button", { name: "Start voting" }).click();
    await expect(subjectLine(page).locator("bdi")).toHaveText("x".repeat(200));
  } finally {
    po.close();
  }
});

test("an anonymous round leaves only its cards in history (AC 2)", async ({
  page,
  context,
  baseURL,
}) => {
  test.setTimeout(60_000);
  const base = baseURL ?? "";
  const code = await createRoom(page);
  await join(page, "Ana");
  const po = await sameUser(base, context);
  const guests: Guest[] = [];
  try {
    for (const name of ["Ben", "Cleo"]) {
      const guest = await newGuest(base);
      guests.push(guest);
      expect(await guest.enter(code)).toMatchObject({ ok: true });
      expect(await guest.cmd("join", { name, role: "voter" })).toMatchObject({ ok: true });
    }
    // The settings panel comes in W2: anonymity is set over the protocol.
    expect(await po.enter(code)).toMatchObject({ ok: true });
    expect(await po.cmd("updateSettings", { patch: { revealNames: false } })).toMatchObject({
      ok: true,
    });
    await subjectField(page).fill("https://dev.azure.com/acme/Payments/_workitems/edit/12345");
    await page.getByRole("button", { name: "Start voting" }).click();
    await expect(page.getByRole("link", { name: "#12345 (opens in a new tab)" })).toBeVisible();
    for (const [i, guest] of guests.entries()) {
      const card = ["13", "8"][i];
      expect(await guest.cmd("castVote", { card, round: 1 })).toMatchObject({ ok: true });
    }
    await handCard(page, "8").click();
    await page.getByRole("button", { name: "Next round" }).click();
    await expect(subjectLine(page)).toHaveText("Round 2");
    const [row] = await historyOf(code);
    expect(row).toMatchObject({
      number: 1,
      subject: { kind: "link", key: "12345" },
      votes: { kind: "anonymous", cards: ["8", "8", "13"] },
    });
    for (const leak of ["Ana", "Ben", "Cleo"]) expect(row?.text).not.toContain(leak);
  } finally {
    po.close();
    for (const guest of guests) guest.close();
  }
});

/** The round's number and how many votes it holds, as the server stored them in Postgres. */
async function roomOf(code: string): Promise<{ round: number; votes: number }> {
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  client.on("error", () => {});
  await client.connect();
  try {
    const { rows } = await client.query<{ round: number; votes: number }>(
      `select (live->'round'->>'number')::int as round,
      (select count(*) from jsonb_object_keys(coalesce(live->'round'->'votes', '{}'::jsonb)))::int
        as votes
      from room where code = $1`,
      [code],
    );
    const [row] = rows;
    if (!row) throw new Error("no such room");
    return row;
  } finally {
    await client.end();
  }
}

test("a double Enter in the subject field starts one round and casts no vote, in the lobby and after a reveal", async ({
  page,
}) => {
  test.setTimeout(60_000);
  const code = await createRoom(page);
  await join(page, "Ana");
  for (const [round, url] of [
    [1, "https://acme.atlassian.net/browse/PAY-482"],
    [2, "https://acme.atlassian.net/browse/PAY-483"],
  ] as const) {
    await subjectField(page).fill(url);
    await subjectField(page).press("Enter");
    await page.waitForTimeout(120);
    await subjectField(page).press("Enter");
    await expect(centreStatus(page)).toHaveText("0/1 voted so far");
    await expect(subjectLine(page)).toContainText(`Round ${round}`);
    // Long enough for a stray vote to reach the server.
    await page.waitForTimeout(600);
    await expect(pressedCards(page)).toHaveCount(0);
    await expect(subjectField(page)).toBeFocused();
    // One round started (a second start would have made it the next one), and no vote.
    expect(await roomOf(code)).toEqual({ round, votes: 0 });
    // Vote and reveal for the next pass.
    await handCard(page, "5").click();
    await expect(page.getByRole("button", { name: "Next round" })).toBeVisible();
  }
});

test("a double Enter on the centre's button starts one round and casts no vote; the hand then answers Enter again", async ({
  page,
}) => {
  test.setTimeout(60_000);
  const code = await createRoom(page);
  await join(page, "Ana");
  for (const [round, name] of [
    [1, "Start voting"],
    [2, "Next round"],
  ] as const) {
    const button = page.getByRole("button", { name });
    await button.focus();
    await button.press("Enter");
    // The focus moves to the hand; the second Enter lands on a card and is ignored.
    await expect(hand(page).locator("[tabindex='0']")).toBeFocused();
    await page.keyboard.press("Enter");
    await page.keyboard.press(" ");
    await expect(centreStatus(page)).toHaveText("0/1 voted so far");
    await page.waitForTimeout(600);
    await expect(pressedCards(page)).toHaveCount(0);
    expect(await roomOf(code)).toEqual({ round, votes: 0 });
    // A moment later Enter on a card votes, which reveals this one-person round.
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("Enter");
    await expect(page.getByRole("button", { name: "Next round" })).toBeVisible();
    expect(await roomOf(code)).toEqual({ round, votes: 1 });
  }
});

test("a long title shows on at most two lines, the whole title on hover", async ({
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
    const title =
      "As a finance admin I want the monthly invoice export to split every line by currency and cost centre, so that the controllers can reconcile the ledger without editing the file by hand";
    await subjectField(page).fill(title);
    await page.getByRole("button", { name: "Start voting" }).click();
    for (const viewer of [page, ben.page]) {
      const shown = subjectLine(viewer).locator("bdi[data-subject-title]");
      await expect(shown).toHaveText(title);
      await expect(shown).toHaveAttribute("title", title);
      for (const width of [360, 1440]) {
        await viewer.setViewportSize({ width, height: 900 });
        // Two lines at most: the clamp holds the rest, and nothing spills sideways.
        const box = await shown.evaluate((element) => {
          const style = getComputedStyle(element);
          return {
            lines: element.clientHeight / Number.parseFloat(style.lineHeight),
            overflow: document.documentElement.scrollWidth - window.innerWidth,
          };
        });
        expect(box.lines, `${width} px`).toBeLessThanOrEqual(2.05);
        expect(box.overflow, `${width} px`).toBeLessThanOrEqual(0);
      }
    }
    await shoot(page, "next-round-long-title-po");
    await shoot(ben.page, "next-round-long-title");
  } finally {
    await ben.context.close();
  }
});
