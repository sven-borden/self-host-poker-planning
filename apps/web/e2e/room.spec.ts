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
  // Ready for Ctrl+C: focused, and the whole link selected.
  await expect(link).toBeFocused();
  expect(
    await link.evaluate((el: HTMLInputElement) => [
      el.selectionStart,
      el.selectionEnd,
      el.value.length,
    ]),
  ).toEqual([0, page.url().length, page.url().length]);
  await page.setViewportSize({ width: 360, height: 800 });
  await page.screenshot({ path: `${SHOTS}room-link-fallback-360.png` });
  await expect(
    page.getByText("Your browser did not allow copying.", { exact: false }),
  ).toBeVisible();
});

test("an unknown room shows the not-found state", async ({ page }) => {
  await page.goto("/r/Unknown123");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Room not found");
  await page.getByRole("link", { name: "Create a new room" }).click();
  await expect(page.getByRole("button", { name: "Create the room" })).toBeVisible();
});

test("the name field says it is optional to a screen reader", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("textbox", { name: /^Room name\s+Optional$/ })).toBeVisible();
});

test("the button keeps the focus through a failed creation", async ({ page }) => {
  await page.route("**/api/rooms", (route) =>
    route.request().method() === "POST"
      ? route.fulfill({ status: 500, json: { code: "internal" } })
      : route.continue(),
  );
  await page.goto("/");
  const submit = page.getByRole("button", { name: "Create the room" });
  await submit.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("alert")).toBeVisible();
  await expect(submit).toBeFocused();
  // Never `disabled`: that would drop the focus to the page. Busy is aria-disabled.
  await expect(submit).toBeEnabled();
  await expect(submit).not.toHaveAttribute("aria-disabled", "true");
});

test("a refused name moves the focus to the name field, with the error linked to it", async ({
  page,
}) => {
  const posts: string[] = [];
  page.on("request", (request) => {
    if (request.method() === "POST" && request.url().endsWith("/api/rooms")) posts.push("post");
  });
  await page.goto("/");
  const name = page.getByRole("textbox", { name: "Room name" });
  const submit = page.getByRole("button", { name: "Create the room" });
  const zalgo = `a${"\u{300}\u{301}\u{302}\u{303}\u{304}\u{305}".repeat(3)}`;
  for (const bad of ["x".repeat(61), zalgo, "Sv\u{200B}en"]) {
    await name.fill(bad);
    await submit.click();
    const alert = page.getByRole("alert");
    await expect(alert).toContainText("A room name needs");
    await expect(name).toBeFocused();
    await expect(name).toHaveAttribute("aria-invalid", "true");
    const alertId = await alert.getAttribute("id");
    expect(await name.getAttribute("aria-describedby")).toContain(alertId);
  }
  // Checked in the browser: nothing was sent, so nothing counted against the limit.
  expect(posts).toEqual([]);
  // A paste is cut by the field, long before the server's body limit.
  await name.fill("y".repeat(20_000));
  expect((await name.inputValue()).length).toBeLessThan(500);
});

test("a name with stacked marks (Vietnamese) shows whole in the room header", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 800 });
  await page.goto("/");
  const title = "Nguy\u{1EC5}n Th\u{1ECB} Minh Khai \u{1EC6} \u{1EC4} \u{1EA6} \u{1ED4} \u{1EAC}";
  await page.getByRole("textbox", { name: "Room name" }).fill(title);
  await page.getByRole("button", { name: "Create the room" }).click();
  await expect(page).toHaveURL(ROOM_PATH);
  const heading = page.getByRole("heading", { level: 1 });
  await expect(heading).toHaveText(title);
  // overflow-hidden clips what does not fit: nothing may be cut off.
  expect(await heading.evaluate((el) => el.scrollHeight <= el.clientHeight)).toBe(true);
  await page.screenshot({ path: `${SHOTS}room-header-vietnamese-360.png` });
});

test("a limited header read shows the rate-limit message, and Try again recovers", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("textbox", { name: "Room name" }).fill("Limited");
  await page.getByRole("button", { name: "Create the room" }).click();
  await expect(page).toHaveURL(ROOM_PATH);
  let limited = true;
  await page.route("**/api/rooms/*", (route) =>
    limited
      ? route.fulfill({
          status: 429,
          headers: { "retry-after": "30" },
          json: { code: "rate_limited" },
        })
      : route.continue(),
  );
  await page.reload();
  await expect(page.getByRole("alert")).toHaveText(/Too many attempts/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    /^Room [1-9A-HJ-NP-Za-km-z]{10}$/,
  );
  limited = false;
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Limited");
});

test("a bogus code with a network failure does not overflow the page at 360 px", async ({
  page,
}) => {
  await page.setViewportSize({ width: 360, height: 800 });
  await page.route("**/api/rooms/*", (route) => route.abort());
  await page.goto(`/r/${"A".repeat(80)}`);
  await expect(page.getByRole("alert")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
});
