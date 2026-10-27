import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

// Creating a room in a real browser (#14), against the real server and Postgres: browser
// A creates a room and lands on its page, browser B (another context, so another guest)
// opens the link and sees the same room, the copy button confirms with a toast or falls
// back to the link, and an unknown code shows the not-found state. Needs DATABASE_URL
// (playwright.config.ts then starts the server); skipped without it locally, failing
// without it in CI.

test.skip(
  !process.env.DATABASE_URL && !process.env.CI,
  "needs DATABASE_URL: runs against the real server",
);
test.beforeAll(() => {
  if (!process.env.DATABASE_URL) throw new Error("CI must run the room tests: set DATABASE_URL");
});

const SHOTS = fileURLToPath(new URL("../tmp/screenshots/", import.meta.url));
const ROOM_PATH = /\/r\/([1-9A-HJ-NP-Za-km-z]{10})$/;

test("a room created in one browser opens with the same name and code in another", async ({
  page,
  browser,
}) => {
  await page.setViewportSize({ width: 360, height: 900 });
  await page.goto("/");
  await page.screenshot({ path: `${SHOTS}create-room-360.png`, fullPage: true });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.getByRole("textbox", { name: "Room name" }).fill("Sprint 42 refinement");
  await page.getByRole("radio", { name: /^T-shirt sizes/ }).check();
  await page.getByRole("button", { name: "Create the room" }).click();
  await expect(page).toHaveURL(ROOM_PATH);
  const code = ROOM_PATH.exec(page.url())?.[1] ?? "";
  const heading = page.getByRole("heading", { level: 1 });
  await expect(heading).toHaveText("Sprint 42 refinement");
  await expect(heading.locator("bdi")).toHaveText("Sprint 42 refinement");
  await expect(page.locator("[data-room-code]")).toHaveText(code);
  await page.screenshot({ path: `${SHOTS}room-header-1280.png` });

  const other = await browser.newContext();
  try {
    const second = await other.newPage();
    await second.goto(page.url());
    await expect(second.getByRole("heading", { level: 1 })).toHaveText("Sprint 42 refinement");
    await expect(second.locator("[data-room-code]")).toHaveText(code);
  } finally {
    await other.close();
  }
});

test("the copy button copies the room link and confirms with a toast", async ({
  page,
  context,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto("/");
  await page.getByRole("button", { name: "Create the room" }).click();
  await expect(page).toHaveURL(ROOM_PATH);
  const code = ROOM_PATH.exec(page.url())?.[1] ?? "";
  // A room without a name is shown by its code.
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(`Room ${code}`);
  await page.getByRole("button", { name: "Copy the link" }).click();
  await expect(page.getByText("Link copied. Send it to your team.")).toBeVisible();
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  expect(copied).toBe(new URL(`/r/${code}`, page.url()).href);
});

test("a refused clipboard shows the link to copy by hand", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: () => Promise.reject(new DOMException("denied", "NotAllowedError")) },
    });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Create the room" }).click();
  await expect(page).toHaveURL(ROOM_PATH);
  await page.getByRole("button", { name: "Copy the link" }).click();
  const link = page.getByRole("textbox", { name: "Room link" });
  await expect(link).toHaveValue(page.url());
  await page.setViewportSize({ width: 360, height: 800 });
  await page.screenshot({ path: `${SHOTS}room-link-fallback-360.png` });
  await expect(
    page.getByText("Your browser did not allow copying.", { exact: false }),
  ).toBeVisible();
});

test("an unknown room shows the not-found state", async ({ page }) => {
  await page.goto("/r/Unknown123");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Room not found");
  await page.getByRole("link", { name: "Back to the home page" }).click();
  await expect(page.getByRole("button", { name: "Create the room" })).toBeVisible();
});
