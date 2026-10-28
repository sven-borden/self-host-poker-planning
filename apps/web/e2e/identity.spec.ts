import { expect, type Page, test } from "./fixtures.ts";

// Guest identity in a real browser (#10), against the real server and Postgres: a page
// load creates a guest, a reload keeps the same user id, and a second browser (another
// context, so another cookie jar) gets another one. The id is read from the session
// endpoint inside the page, as the app reads it. Needs DATABASE_URL (playwright.config.ts
// then starts the server); skipped without it locally, and failing without it in CI, so
// that the CI job cannot pass with these tests skipped.

test.skip(
  !process.env.DATABASE_URL && !process.env.CI,
  "needs DATABASE_URL: runs against the real server",
);
test.beforeAll(() => {
  if (!process.env.DATABASE_URL)
    throw new Error("CI must run the identity tests: set DATABASE_URL");
});

/** The session's user id as the page sees it, or null without a session. */
function sessionUserId(page: Page): Promise<string | null> {
  return page.evaluate(async () => {
    const response = await fetch("/api/auth/get-session", { credentials: "same-origin" });
    const session = (await response.json()) as { user?: { id?: string } } | null;
    return session?.user?.id ?? null;
  });
}

test("a page load creates a guest, a reload keeps it and a second browser gets another", async ({
  page,
  browser,
}) => {
  await page.goto("/");
  await expect.poll(() => sessionUserId(page)).not.toBeNull();
  const first = await sessionUserId(page);
  expect(first).toMatch(/^[\w-]{1,128}$/);
  // httpOnly: the session cookie never reaches JavaScript.
  expect(await page.evaluate(() => document.cookie)).not.toContain("session_token");

  await page.reload();
  await page.goto("/r/abcdefghij");
  expect(await sessionUserId(page)).toBe(first);

  const other = await browser.newContext();
  try {
    const second = await other.newPage();
    await second.goto("/r/abcdefghij");
    await expect.poll(() => sessionUserId(second)).not.toBeNull();
    expect(await sessionUserId(second)).not.toBe(first);
  } finally {
    await other.close();
  }
});

test("two tabs of a fresh browser that load together become one guest", async ({ browser }) => {
  const context = await browser.newContext();
  try {
    let signIns = 0;
    context.on("response", (response) => {
      if (response.url().endsWith("/api/auth/sign-in/anonymous") && response.ok()) signIns += 1;
    });
    const tabs = [await context.newPage(), await context.newPage()];
    await Promise.all(tabs.map((tab) => tab.goto("/r/abcdefghij")));
    await Promise.all(tabs.map((tab) => tab.waitForLoadState("networkidle")));
    const [first, second] = await Promise.all(tabs.map(sessionUserId));
    expect(first).not.toBeNull();
    expect(second).toBe(first);
    // The identity lock: the second tab found the first one's session instead of
    // creating a guest of its own.
    expect(signIns).toBe(1);
  } finally {
    await context.close();
  }
});
