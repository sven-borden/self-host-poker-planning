import { readFileSync } from "node:fs";
import { type BrowserContext, expect, type Locator, type Page, test } from "./fixtures.ts";
import { parse } from "csv-parse/sync";
import { marked } from "marked";
import { type Guest, guestsJoin, join, ownAddress, ROOM_PATH, SHOTS, sameUser } from "./support.ts";

// The session summary and the exports (#34) in real browsers, against the real server and
// Postgres: three rounds (a Jira link with a final; a T-shirt round whose title starts with
// "=" and holds quotes, a comma and a semicolon, with the final M; a title with a Jira key,
// still on the table with its final). The summary counts all three; the CSV is downloaded
// and parsed, in English with commas and in French and German with semicolons and decimal
// commas; the Markdown and the key lines are copied (clipboard-write granted; the page
// may not read the clipboard, `clipboard-read=()` in #36's Permissions-Policy, so the
// write is watched on its way); the key lines and the range by keyboard; and screenshots of the summary and
// the menu. Needs DATABASE_URL; skipped without it locally, failing without it in CI.

test.skip(
  !process.env.DATABASE_URL && !process.env.CI,
  "needs DATABASE_URL: runs against the real server",
);
test.beforeAll(() => {
  if (!process.env.DATABASE_URL) {
    throw new Error("CI must run the export tests: set DATABASE_URL");
  }
});
test.beforeEach(async ({ page }) => {
  await page.setExtraHTTPHeaders(ownAddress());
});

const JIRA = "https://acme.atlassian.net/browse/PAY-482";
const TRICKY = '=1+1 "fast", cheap; filters';
const ROOM = "Team Sky: Q4";
/** The file name: the room's name made safe, the day; never the room's code. */
const FILE = /^planning-poker-Team-Sky-Q4-\d{4}-\d\d-\d\d\.(csv|md)$/;

const panelOf = (page: Page, name = "History") => page.getByRole("dialog", { name });
const summaryOf = (panel: Locator) => panel.locator("[data-history-summary]");
const figure = (panel: Locator, name: string) =>
  summaryOf(panel).locator(`[data-summary-stat=${name}] dd`).first();
const statusOf = (panel: Locator) => panel.locator("[data-export-status]");

async function send(guest: Guest, type: string, payload?: Record<string, unknown>) {
  expect(await guest.cmd(type, payload), type).toMatchObject({ ok: true });
}

/** A round from start to final: the PO's socket and Ben vote, then the PO reveals and records. */
async function playRound(
  po: Guest,
  ben: Guest,
  round: number,
  subject: Record<string, unknown>,
  cards: [string, string],
  final: string,
) {
  await send(po, "startRound", { subject });
  await send(po, "castVote", { card: cards[0], round });
  await send(ben, "castVote", { card: cards[1], round });
  await send(po, "reveal");
  await send(po, "setFinal", { card: final });
}

async function openHistory(page: Page, button = "History", title = button) {
  await page.getByRole("button", { name: button }).click();
  const panel = panelOf(page, title);
  await expect(panel.getByRole("heading", { name: title })).toBeFocused();
  return panel;
}

/** Picks a menu item and returns the file the browser saved, with its name. */
async function download(page: Page, panel: Locator, menu: string, item: string) {
  await panel.getByRole("button", { name: menu }).click();
  const [file] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("menuitem", { name: item }).click(),
  ]);
  const path = await file.path();
  return { name: file.suggestedFilename(), text: readFileSync(path, "utf8") };
}

/** The clipboard's text; Windows hands line ends back as CRLF. */
const readClipboard = async (page: Page) =>
  (await page.evaluate(() => navigator.clipboard.readText())).replace(/\r\n/g, "\n");

/** Waits until no finite animation runs on the page (the sheet sliding in, the menu). */
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

/** Screenshots at 360 and 1440 px, light and dark; `before` runs before each (opens the menu). */
async function shootPanel(page: Page, name: string, before?: () => Promise<void>) {
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    for (const width of [360, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      await page.waitForTimeout(150);
      await settle(page);
      await before?.();
      await settle(page);
      await page.screenshot({ path: `${SHOTS}${name}-${width}-${scheme}.png` });
      if (before) await page.keyboard.press("Escape");
    }
  }
  await page.emulateMedia({ colorScheme: "light" });
  await page.setViewportSize({ width: 1280, height: 900 });
}

async function setLanguage(page: Page, language: string) {
  await page.evaluate((value) => localStorage.setItem("pp-language", value), language);
  await page.reload();
}

/** Grants the write and watches it: every page of the context records what it copies. */
async function watchClipboard(context: BrowserContext, base: string) {
  await context.grantPermissions(["clipboard-write"], { origin: base });
  await context.addInitScript(() => {
    const clipboard = navigator.clipboard;
    if (!clipboard) return;
    const write = clipboard.writeText.bind(clipboard);
    clipboard.writeText = (text: string) => {
      (window as { ppCopied?: string }).ppCopied = text;
      return write(text);
    };
  });
}

test("the summary counts three rounds; CSV, Markdown and key lines in en, fr and de, by keyboard too", async ({
  page,
  context,
  baseURL,
}) => {
  test.setTimeout(150_000);
  const base = baseURL ?? "";
  await watchClipboard(context, base);
  await page.goto("/");
  await page.getByRole("textbox", { name: /^Room name/ }).fill(ROOM);
  await page.getByRole("button", { name: "Create the room" }).click();
  await expect(page).toHaveURL(ROOM_PATH);
  const code = ROOM_PATH.exec(page.url())?.[1] ?? "";
  await join(page, "Ana");
  const po = await sameUser(base, context);
  const [ben] = await guestsJoin(base, code, ["Ben"]);
  if (!ben) throw new Error("Ben did not join");
  try {
    expect(await po.enter(code)).toMatchObject({ ok: true });
    await send(po, "updateSettings", { patch: { revealWhenAllVoted: false } });
    // Round 1: the Jira link, 5 and 5, final 5.
    await playRound(po, ben, 1, { kind: "link", url: JIRA }, ["5", "5"], "5");
    // Round 2: T-shirt sizes, a title a spreadsheet would run, M and L, final M.
    await send(po, "updateSettings", { patch: { deck: { kind: "preset", id: "tshirt" } } });
    await playRound(po, ben, 2, { kind: "title", text: TRICKY }, ["M", "L"], "M");
    // Round 3: a Jira key in the title, 3 and 8, final 5; it stays on the table.
    await send(po, "updateSettings", { patch: { deck: { kind: "preset", id: "fib" } } });
    await playRound(po, ben, 3, { kind: "title", text: "PAY-17 Checkout" }, ["3", "8"], "5");
    await expect(page.locator("[data-centre-final]")).toHaveAttribute("data-centre-final", "5");

    const panel = await openHistory(page);
    // The history lists rounds 1 and 2; the summary adds round 3 from the table.
    await expect(panel.locator("[data-history-round]")).toHaveCount(2);
    await expect(summaryOf(panel).getByRole("radio", { name: "Today" })).toBeChecked();
    await expect(figure(panel, "rounds")).toHaveText("3");
    await expect(figure(panel, "total")).toHaveText("10");
    await expect(summaryOf(panel).locator("[data-summary-stat=total]")).toContainText(
      "1 round without a numeric estimate",
    );
    // 100 %, 50 % and 50 %.
    await expect(figure(panel, "agreement")).toHaveText("67%");
    await expect(panel.getByRole("button", { name: "Export" })).toBeEnabled();
    await shootPanel(page, "exports-summary");
    await shootPanel(page, "exports-menu", async () => {
      await panel.getByRole("button", { name: "Export" }).click();
      await expect(page.getByRole("menu")).toBeVisible();
    });

    // The CSV, in English: commas, a point for decimals, the formula defused.
    const csv = await download(page, panel, "Export", "Download CSV");
    expect(csv.name).toMatch(FILE);
    expect(csv.name).not.toContain(code);
    expect(csv.text.charCodeAt(0)).toBe(0xfeff);
    expect(csv.text).toContain("\r\n");
    const rows = parse(csv.text, { bom: true, delimiter: "," }) as string[][];
    expect(rows).toHaveLength(4);
    expect(rows[0]).toEqual([
      "Round",
      "Subject",
      "Key",
      "Final estimate",
      "Suggested card",
      "Agreement (%)",
      "Average",
      "Median",
      "Votes",
      "Voting time (s)",
      "Ended",
    ]);
    expect(rows[1]?.slice(0, 9)).toEqual(["1", JIRA, "PAY-482", "5", "5", "100", "5", "5", "2"]);
    expect(rows[2]?.slice(0, 9)).toEqual(["2", `'${TRICKY}`, "", "M", "M", "50", "", "", "2"]);
    expect(rows[3]?.slice(0, 9)).toEqual([
      "3",
      "PAY-17 Checkout",
      "PAY-17",
      "5",
      "5",
      "50",
      "5.5",
      "5.5",
      "2",
    ]);
    expect(rows[3]?.[10]).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d[+-]\d\d:\d\d$/);
    for (const text of [code, "Ana", "Ben"]) expect(csv.text).not.toContain(text);
    await expect(statusOf(panel)).toHaveText("CSV downloaded.");

    // The Markdown, copied: a GitHub table of the same rounds, the link kept.
    await panel.getByRole("button", { name: "Export" }).click();
    await page.getByRole("menuitem", { name: "Copy Markdown" }).click();
    await expect(statusOf(panel)).toHaveText("Markdown copied.");
    const markdown = await readClipboard(page);
    const html = marked.parse(markdown, { gfm: true, async: false });
    expect(html).toContain("<h1>Poker Planning: Team Sky: Q4</h1>");
    expect(html.match(/<tr>/g)).toHaveLength(4);
    expect(html).toContain(`<a href="${JIRA}">PAY-482</a>`);
    for (const text of [code, "Ana", "Ben"]) expect(markdown).not.toContain(text);

    // The key lines, by keyboard: from the title, Tab to "Export", Enter, the fourth item.
    await page.mouse.move(0, 0);
    await panel.getByRole("heading", { name: "History" }).focus();
    const exportButton = panel.getByRole("button", { name: "Export" });
    for (let i = 0; i < 6; i++) {
      if (await exportButton.evaluate((element) => element === document.activeElement)) break;
      await page.keyboard.press("Tab");
    }
    await expect(exportButton).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("menuitem", { name: "Download CSV" })).toBeFocused();
    for (let i = 0; i < 3; i++) {
      await page.keyboard.press("ArrowDown");
      await page.waitForTimeout(50);
    }
    await expect(
      page.getByRole("menuitem", { name: "Copy for Jira or Azure DevOps" }),
    ).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(statusOf(panel)).toHaveText(
      "2 lines copied for Jira or Azure DevOps. 1 round skipped: no key or no final estimate.",
    );
    expect(await readClipboard(page)).toBe("PAY-482 5\nPAY-17 5");
    await expect(exportButton).toBeFocused();
    // The range by keyboard: Shift+Tab to "Today", the arrow to "All rounds".
    await page.keyboard.press("Shift+Tab");
    const today = summaryOf(panel).getByRole("radio", { name: "Today" });
    await expect(today).toBeFocused();
    await page.keyboard.press("ArrowRight");
    await expect(summaryOf(panel).getByRole("radio", { name: "All rounds" })).toBeChecked();
    await expect(figure(panel, "rounds")).toHaveText("3");

    // French and German: a semicolon and decimal commas.
    for (const [language, button, menu, item, first] of [
      ["fr", "Historique", "Exporter", "Télécharger en CSV", "Tour"],
      ["de", "Verlauf", "Exportieren", "CSV herunterladen", "Runde"],
    ] as const) {
      await setLanguage(page, language);
      const local = await openHistory(page, button);
      await expect(local.getByRole("button", { name: menu })).toBeEnabled();
      const file = await download(page, local, menu, item);
      expect(file.name).toMatch(FILE);
      const table = parse(file.text, { bom: true, delimiter: ";" }) as string[][];
      expect(table).toHaveLength(4);
      for (const row of table) expect(row).toHaveLength(11);
      expect(table[0]?.[0]).toBe(first);
      expect(table[2]?.[1]).toBe(`'${TRICKY}`);
      expect(table[3]?.slice(5, 8)).toEqual(["50", "5,5", "5,5"]);
      expect(file.text).toContain(";5,5;5,5;");
      await page.keyboard.press("Escape");
    }
  } finally {
    po.close();
    ben.close();
  }
});
