import { AxeBuilder } from "@axe-core/playwright";
import { WCAG_TAGS } from "./a11y.ts";
import { type Browser, expect, type Page, test } from "./fixtures.ts";
import { SIGN_IN_BASE, SIGN_IN_FAKE_ORIGIN } from "./signed-in.ts";
import { join, newPerson, ROOM_PATH } from "./support.ts";

// "My rooms" (#49, ADR-027) in a real browser, on the server with provider keys and on the one
// without. Rename and delete run against a second browser sitting in the room, so what its
// people see is what is tested.

let people = 0;
const PROVIDER = /^https:\/\/accounts\.google\.com\//;
const ROOMS = `${SIGN_IN_BASE}/rooms`;

/** Someone signed in on the keyed server, with a stand-in for Google, on the empty list. */
async function signedIn(browser: Browser) {
  const { context, page } = await newPerson(browser);
  people += 1;
  const id = `${Date.now()}-${test.info().workerIndex}-${people}`;
  const who = { id, email: `rooms-${id}@example.com`, name: "Ada Lovelace", tenant: "tenant-e2e" };
  const param = Buffer.from(JSON.stringify(who)).toString("base64url");
  await context.route(PROVIDER, async (route) => {
    const url = new URL(route.request().url());
    await route.fulfill({
      status: 302,
      headers: {
        location: `${SIGN_IN_FAKE_ORIGIN}${url.pathname}${url.search}&fake_person=${param}`,
      },
    });
  });
  await page.goto(ROOMS);
  await page.getByRole("button", { name: "Sign in with Google" }).click();
  await page.waitForURL(ROOMS);
  await expect(page.locator("[data-my-rooms-empty]")).toBeVisible();
  return { context, page };
}

/** A room made on the keyed server, by whoever `page` is: its path. */
async function createRoom(page: Page, name: string): Promise<string> {
  await page.goto(`${SIGN_IN_BASE}/`);
  await page.getByLabel(/room name/i).fill(name);
  await page.getByRole("button", { name: "Create the room" }).click();
  await expect(page).toHaveURL(ROOM_PATH);
  return new URL(page.url()).pathname;
}

/** A guest of another browser, sitting in the room. */
async function guestAt(browser: Browser, path: string) {
  const { context, page } = await newPerson(browser);
  await page.goto(`${SIGN_IN_BASE}${path}`);
  await join(page, "Grace");
  return { context, page };
}

test.describe("without provider keys", () => {
  test("/rooms is an unknown page, and no page leads there", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await expect(page.locator("[data-my-rooms-link]")).toHaveCount(0);
    await page.goto("/rooms");
    await expect(page.getByRole("heading", { name: "Page not found" })).toBeVisible();
    await expect(page.locator("[data-my-rooms]")).toHaveCount(0);
  });

  test("the server refuses a guest", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    const response = await page.request.get("/api/my-rooms");
    expect([401, 403]).toContain(response.status());
    expect(response.headers()["cache-control"]).toBe("no-store");
  });
});

test.describe("with provider keys", () => {
  test("someone signed out signs in here and comes back here, to an empty list", async ({
    browser,
  }) => {
    const { context, page } = await signedIn(browser);
    await expect(page.getByText("No rooms yet")).toBeVisible();
    await expect(page.getByRole("link", { name: "Create a new room" })).toBeVisible();
    await context.close();
  });

  test("the landing page leads to the list, and the list back into the room", async ({
    browser,
  }) => {
    const { context, page } = await signedIn(browser);
    const path = await createRoom(page, "Sprint 12");
    await page.goto(`${SIGN_IN_BASE}/`);
    await page.locator("[data-my-rooms-link]").click();
    await page.waitForURL(ROOMS);
    const row = page.locator("[data-my-room]");
    await expect(row).toHaveCount(1);
    await expect(row).toContainText("You own this room");
    await row.getByRole("link", { name: "Sprint 12" }).click();
    await page.waitForURL(`**${path}`);
    await expect(page.getByRole("heading", { name: "Sprint 12" })).toBeVisible();
    await context.close();
  });

  test("a rename reaches the people in the room", async ({ browser }) => {
    const { context, page } = await signedIn(browser);
    const path = await createRoom(page, "Before");
    const { context: others, page: guest } = await guestAt(browser, path);
    await expect(guest.getByRole("heading", { name: "Before" })).toBeVisible();

    await page.goto(ROOMS);
    await page.getByRole("button", { name: "Rename Before" }).click();
    await page.getByLabel("Room name").fill("After");
    await page.getByRole("button", { name: "Save" }).click();

    await expect(page.getByRole("link", { name: "After" })).toBeVisible();
    await expect(guest.getByRole("heading", { name: "After" })).toBeVisible();
    await others.close();
    await context.close();
  });

  test("a delete asks first, and a live room shows what an unknown room shows", async ({
    browser,
  }) => {
    const { context, page } = await signedIn(browser);
    const path = await createRoom(page, "Doomed");
    const { context: others, page: guest } = await guestAt(browser, path);

    await page.goto(ROOMS);
    await page.getByRole("button", { name: "Delete Doomed" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("heading", { name: "Delete Doomed?" })).toBeVisible();
    await expect(guest.locator("[data-room-page]")).toBeVisible();
    await dialog.getByRole("button", { name: "Delete this room" }).click();

    await expect(page.getByText("Room deleted.")).toBeVisible();
    await expect(page.locator("[data-my-room]")).toHaveCount(0);
    await expect(guest.locator("[data-room-not-found]")).toBeVisible();
    await expect(guest.getByRole("heading", { name: "Room not found" })).toBeVisible();
    await expect(guest.getByText("The room’s product owner deleted it.")).toBeVisible();
    await guest.reload();
    await expect(guest.locator("[data-room-not-found]")).toBeVisible();
    await others.close();
    await context.close();
  });

  test("the focus goes back to the opener, or to the title when that went", async ({ browser }) => {
    const { context, page } = await signedIn(browser);
    await createRoom(page, "Focus");
    await page.goto(ROOMS);
    const focused = () =>
      page.evaluate(
        () => document.activeElement?.getAttribute("aria-label") ?? document.activeElement?.tagName,
      );

    await page.getByRole("button", { name: "Rename Focus" }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect.poll(focused).toBe("Rename Focus");

    await page.getByRole("button", { name: "Rename Focus" }).click();
    await page.getByLabel("Room name").fill("Renamed");
    await page.getByRole("button", { name: "Save" }).click();
    await expect(page.getByText("Room renamed.")).toBeVisible();
    await expect.poll(focused).toBe("Rename Renamed");

    await page.getByRole("button", { name: "Delete Renamed" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Cancel" }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect.poll(focused).toBe("Delete Renamed");

    await page.getByRole("button", { name: "Delete Renamed" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Delete this room" }).click();
    await expect(page.getByText("Room deleted.")).toBeVisible();
    await expect.poll(focused).toBe("H1");
    await context.close();
  });

  test("a role taken by claim offers rename and leave, and says why not delete", async ({
    browser,
  }) => {
    const { context, page } = await signedIn(browser);
    // A room whose creator never sat down: the role is free at once.
    const { context: others, page: creator } = await newPerson(browser);
    const path = await createRoom(creator, "Abandoned");
    await others.close();
    await page.goto(`${SIGN_IN_BASE}${path}`);
    await join(page, "Ada");
    await page.getByRole("button", { name: "Claim the product owner role" }).click();
    await expect(page.getByRole("button", { name: "Claim the product owner role" })).toHaveCount(0);

    await page.goto(ROOMS);
    const row = page.locator('[data-my-room="claimed"]');
    await expect(row).toContainText("You are the product owner");
    await expect(row).toContainText("does not carry that right");
    await expect(row.getByRole("button", { name: "Rename Abandoned" })).toBeVisible();
    await expect(row.getByRole("button", { name: "Leave this room: Abandoned" })).toBeVisible();
    await expect(row.getByRole("button", { name: "Delete Abandoned" })).toHaveCount(0);
    await page.setViewportSize({ width: 320, height: 640 });
    const width = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(width).toBeLessThanOrEqual(320);
    expect(
      (await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze()).violations.map(({ id }) => id),
    ).toEqual([]);

    const id = await page.evaluate(async () => {
      const { rooms } = await (await fetch("/api/my-rooms")).json();
      return rooms[0].id as string;
    });
    const refused = await page.request.delete(`${SIGN_IN_BASE}/api/my-rooms/${id}`, {
      headers: { origin: SIGN_IN_BASE },
    });
    expect(refused.status()).toBe(403);
    expect(await refused.json()).toEqual({ code: "not_keeper" });
    await context.close();
  });

  test("someone in another's room can leave it from the list", async ({ browser }) => {
    const { context, page } = await signedIn(browser);
    const { context: others, page: po } = await newPerson(browser);
    const path = await createRoom(po, "Theirs");
    await join(po, "Grace");
    await page.goto(`${SIGN_IN_BASE}${path}`);
    await join(page, "Ada");

    await page.goto(ROOMS);
    await expect(page.locator("[data-my-room]")).toContainText("You hold a seat");
    await page.getByRole("button", { name: "Leave this room: Theirs" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Leave this room" }).click();

    await expect(page.getByText("You left the room.")).toBeVisible();
    await expect(po.getByText("1 person in the room")).toBeVisible();
    await others.close();
    await context.close();
  });

  test("fits a 320 px phone with a long name, with nothing for axe", async ({ browser }) => {
    const { context, page } = await signedIn(browser);
    await page.setViewportSize({ width: 320, height: 640 });
    await createRoom(page, "W".repeat(60));
    await page.goto(ROOMS);
    await expect(page.locator("[data-my-room]")).toHaveCount(1);
    const width = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(width).toBeLessThanOrEqual(320);
    expect(
      (await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze()).violations.map(({ id }) => id),
    ).toEqual([]);
    await page.getByRole("button", { name: /^Delete / }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    // Faded in, or axe reads the colours halfway.
    await dialog.evaluate((box) => Promise.all(box.getAnimations().map((run) => run.finished)));
    expect(
      (await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze()).violations.map(({ id }) => id),
    ).toEqual([]);
    await context.close();
  });
});
