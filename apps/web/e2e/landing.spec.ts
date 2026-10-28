import { fileURLToPath } from "node:url";
import { expect, type Locator, type Page, test } from "./fixtures.ts";

// The landing page, joining by code, the missing room and the generic error page (#24),
// against the real server and Postgres: an unknown code must get the server's real 404.
// Needs DATABASE_URL (playwright.config.ts then starts the server); skipped without it
// locally, failing without it in CI.

test.skip(
  !process.env.DATABASE_URL && !process.env.CI,
  "needs DATABASE_URL: runs against the real server",
);
test.beforeAll(() => {
  if (!process.env.DATABASE_URL) throw new Error("CI must run the landing tests: set DATABASE_URL");
});

const SHOTS = fileURLToPath(new URL("../tmp/screenshots/", import.meta.url));
const ROOM_PATH = /\/r\/([1-9A-HJ-NP-Za-km-z]{10})$/;
/** Well-formed, and absent from a fresh database. */
const UNKNOWN = "Unknown123";
/** The room route's split chunk, which a test breaks to reach the error page. */
const ROOM_CHUNK = /\/assets\/_code-[\w-]+\.js$/;

async function join(page: Page, typed: string) {
  await page.getByRole("textbox", { name: "Room code or link" }).fill(typed);
  await page.getByRole("button", { name: "Join", exact: true }).click();
}

async function createRoom(page: Page, name: string): Promise<string> {
  await page.goto("/");
  await page.getByRole("textbox", { name: "Room name" }).fill(name);
  await page.getByRole("button", { name: "Create the room" }).click();
  await expect(page).toHaveURL(ROOM_PATH);
  return ROOM_PATH.exec(page.url())?.[1] ?? "";
}

async function fitsWidth(page: Page): Promise<boolean> {
  return page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
}

test("an unknown code shows the not-found page, without the code", async ({ page }) => {
  await page.goto("/");
  await join(page, UNKNOWN);
  await expect(page).toHaveURL(`/r/${UNKNOWN}`);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Room not found");
  // The heading takes the focus, so a screen reader announces the page.
  await expect(page.getByRole("heading", { level: 1 })).toBeFocused();
  // The server states its retention period (ROOM_TTL_DAYS, 90 by default).
  await expect(page.getByText("removed after 90 days without activity.")).toBeVisible();
  await expect(page).toHaveTitle("Room not found · Poker Planning");
  expect((await page.locator("body").textContent()) ?? "").not.toContain(UNKNOWN);
  await page.getByRole("link", { name: "Create a new room" }).click();
  await expect(page).toHaveURL("/");
  await expect(page.getByRole("button", { name: "Create the room" })).toBeVisible();
  await expect(page).toHaveTitle("Poker Planning");
});

test("a malformed code stays on the landing page with a message", async ({ page }) => {
  await page.goto("/");
  const field = page.getByRole("textbox", { name: "Room code or link" });
  for (const bad of ["abc", "0OIl000000", "https://poker.example.com/r/nope"]) {
    await join(page, bad);
    await expect(page.getByRole("alert")).toHaveText(/^This is not a room code\./);
    await expect(field).toBeFocused();
    await expect(page).toHaveURL("/");
  }
  // Typed straight into the address bar, it reaches the not-found page.
  await page.goto("/r/abc");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Room not found");
});

test("a pasted link and a code with spaces or dashes open the room", async ({ page, baseURL }) => {
  const code = await createRoom(page, "Join by code");
  for (const typed of [
    `${baseURL}/r/${code}?from=chat`,
    ` ${code.slice(0, 3)} ${code.slice(3, 6)} ${code.slice(6)} `,
    `"${code.slice(0, 5)}-${code.slice(5)}".`,
  ]) {
    await page.goto("/");
    await join(page, typed);
    await expect(page, typed).toHaveURL(`/r/${code}`);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Join by code");
  }
});

test("a room link for another host is offered, not opened here", async ({ page }) => {
  await page.goto("/");
  const link = `https://poker.other.org/r/${UNKNOWN}?from=chat`;
  await join(page, link);
  await expect(page.getByRole("alert")).toHaveText(
    "This link is for poker.other.org. Open it there",
  );
  const there = page.getByRole("link", { name: "Open it there" });
  await expect(there).toHaveAttribute("href", link);
  await expect(there).toHaveAttribute("rel", "noopener noreferrer");
  await expect(page.getByRole("textbox", { name: "Room code or link" })).toBeFocused();
  await expect(page).toHaveURL("/");
});

test("the landing page keeps both ways in above the fold, and the steps last", async ({ page }) => {
  /** Where an element's box ends, from the top of the viewport. */
  const bottomOf = async (locator: Locator) => {
    const box = await locator.boundingBox();
    return box ? box.y + box.height : Number.POSITIVE_INFINITY;
  };
  const topOf = async (locator: Locator) => (await locator.boundingBox())?.y ?? 0;
  for (const [width, height] of [
    [1440, 900],
    [1366, 768],
    [1024, 768],
    [360, 800],
  ] as const) {
    await page.setViewportSize({ width, height });
    await page.goto("/");
    await page.waitForFunction(() => document.getAnimations().length === 0);
    const steps = page.getByRole("heading", { level: 2, name: "How it works" });
    const joinCard = page.getByRole("heading", { level: 2, name: "Join with a code" });
    const create = page.getByRole("button", { name: "Create the room" });
    const field = page.getByRole("textbox", { name: "Room code or link" });
    const joinButton = page.getByRole("button", { name: "Join", exact: true });
    expect(await topOf(steps), `steps after join at ${width}`).toBeGreaterThan(
      await bottomOf(joinButton),
    );
    if (width < 1024) {
      expect(await topOf(steps), `steps after create at ${width}`).toBeGreaterThan(
        await topOf(create),
      );
    }
    expect(await topOf(joinCard)).toBeGreaterThan(0);
    if (width === 1440) {
      expect(await bottomOf(create), "create above the fold").toBeLessThanOrEqual(height);
      expect(await bottomOf(joinButton), "join above the fold").toBeLessThanOrEqual(height);
    }
    if (width === 1366) {
      expect(await bottomOf(field), "join field above the fold").toBeLessThanOrEqual(height);
    }
    if (width >= 1366) {
      await page.screenshot({ path: `${SHOTS}landing-fold-${width}x${height}.png` });
    }
  }
});

test("another code can be tried from the not-found page", async ({ page }) => {
  const code = await createRoom(page, "Second try");
  await page.goto(`/r/${UNKNOWN}`);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Room not found");
  await join(page, code);
  await expect(page).toHaveURL(`/r/${code}`);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Second try");
});

test("a page that cannot load shows the error page, and its button reloads", async ({ page }) => {
  await page.route(ROOM_CHUNK, (route) => route.abort());
  await page.goto(`/r/${UNKNOWN}`);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Something went wrong", {
    timeout: 15_000,
  });
  await expect(page).toHaveTitle("Something went wrong · Poker Planning");
  const text = (await page.locator("body").textContent()) ?? "";
  expect(text).not.toContain(UNKNOWN);
  expect(text).not.toMatch(/Error|import|\.js/);
  await page.unroute(ROOM_CHUNK);
  await page.getByRole("button", { name: "Reload the page" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Room not found");
});

test.describe("in French", () => {
  test.use({ locale: "fr-FR" });

  test("the not-found page and the error page speak French", async ({ page }) => {
    await page.goto(`/r/${UNKNOWN}`);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Salle introuvable");
    await expect(page.getByRole("link", { name: "Créer une nouvelle salle" })).toBeVisible();
    await page.route(ROOM_CHUNK, (route) => route.abort());
    await page.goto(`/r/${UNKNOWN}?again`);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Une erreur s’est produite", {
      timeout: 15_000,
    });
    await expect(page.getByRole("button", { name: "Recharger la page" })).toBeVisible();
  });
});

test.describe("in German", () => {
  test.use({ locale: "de-DE" });

  test("the landing page and the not-found page speak German", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 2, name: "So funktioniert es" })).toBeVisible();
    await page.getByRole("textbox", { name: "Raumcode oder Link" }).fill(UNKNOWN);
    await page.getByRole("button", { name: "Beitreten" }).click();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Raum nicht gefunden");
  });
});

test("screenshots of the other-host warning and of forced colours", async ({ page }) => {
  for (const width of [360, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`/r/${UNKNOWN}`);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Room not found");
    await join(page, `https://poker.other.org/r/${UNKNOWN}`);
    await expect(page.getByRole("link", { name: "Open it there" })).toBeVisible();
    await page.waitForFunction(() => document.getAnimations().length === 0);
    expect(await fitsWidth(page), `other host ${width}`).toBe(true);
    await page.screenshot({ path: `${SHOTS}not-found-other-host-${width}.png`, fullPage: true });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.emulateMedia({ forcedColors: "active" });
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await page.waitForFunction(() => document.getAnimations().length === 0);
  await page.screenshot({ path: `${SHOTS}landing-forced-colors-1440.png` });
  await page.route(ROOM_CHUNK, (route) => route.abort());
  await page.goto(`/r/${UNKNOWN}?forced`);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Something went wrong", {
    timeout: 15_000,
  });
  await page.waitForFunction(() => document.getAnimations().length === 0);
  // The filled button keeps an outline where forced colours drop its fill.
  const border = await page
    .getByRole("button", { name: "Reload the page" })
    .evaluate((button) => getComputedStyle(button).borderTopWidth);
  expect(border).toBe("1px");
  await page.screenshot({ path: `${SHOTS}error-forced-colors-1440.png`, fullPage: true });
  await page.unroute(ROOM_CHUNK);
});

test("screenshots of the landing, not-found and error pages", async ({ page }) => {
  test.slow();
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    for (const width of [360, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto("/");
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      await page.waitForFunction(() => document.getAnimations().length === 0);
      expect(await fitsWidth(page), `landing ${width} ${scheme}`).toBe(true);
      await page.screenshot({ path: `${SHOTS}landing-${width}-${scheme}.png`, fullPage: true });

      await page.goto(`/r/${UNKNOWN}`);
      await expect(page.getByRole("heading", { level: 1 })).toHaveText("Room not found");
      await page.waitForFunction(() => document.getAnimations().length === 0);
      expect(await fitsWidth(page), `not-found ${width} ${scheme}`).toBe(true);
      await page.screenshot({ path: `${SHOTS}not-found-${width}-${scheme}.png`, fullPage: true });

      await page.route(ROOM_CHUNK, (route) => route.abort());
      await page.goto(`/r/${UNKNOWN}?broken`);
      await expect(page.getByRole("heading", { level: 1 })).toHaveText("Something went wrong", {
        timeout: 15_000,
      });
      await page.waitForFunction(() => document.getAnimations().length === 0);
      expect(await fitsWidth(page), `error ${width} ${scheme}`).toBe(true);
      await page.screenshot({ path: `${SHOTS}error-${width}-${scheme}.png`, fullPage: true });
      await page.unroute(ROOM_CHUNK);
    }
  }
});
