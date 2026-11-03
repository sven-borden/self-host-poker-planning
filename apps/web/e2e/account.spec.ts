import { readFile } from "node:fs/promises";
import { scan } from "./a11y.ts";
import { type Browser, expect, type Page, test } from "./fixtures.ts";
import { SIGN_IN_BASE, SIGN_IN_FAKE_ORIGIN } from "./signed-in.ts";
import { join, newPerson, ROOM_PATH } from "./support.ts";

// The account page (#51, ADR-029) in a real browser, on the server with provider keys and on the
// one without. A second browser sits in the room, so what a room's people see is what is tested.

let people = 0;
const PROVIDER = /^https:\/\/accounts\.google\.com\//;
const ACCOUNT = `${SIGN_IN_BASE}/account`;

/** Someone signed in on the keyed server, with a stand-in for Google, on the account page. */
async function signedIn(browser: Browser) {
  const { context, page } = await newPerson(browser);
  people += 1;
  const id = `${Date.now()}-${test.info().workerIndex}-${people}`;
  const who = {
    id,
    email: `account-${id}@example.com`,
    name: "Ada Lovelace",
    tenant: "tenant-e2e",
  };
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
  await page.goto(ACCOUNT);
  await page.getByRole("button", { name: "Sign in with Google" }).click();
  await page.waitForURL(ACCOUNT);
  await expect(page.locator("[data-account-delete]")).toBeVisible();
  return { context, page, who };
}

/** A room made on the keyed server, by whoever `page` is: its path. */
async function createRoom(page: Page, name: string): Promise<string> {
  await page.goto(`${SIGN_IN_BASE}/`);
  await page.getByLabel(/room name/i).fill(name);
  await page.getByRole("button", { name: "Create the room" }).click();
  await expect(page).toHaveURL(ROOM_PATH);
  return new URL(page.url()).pathname;
}

async function confirmDeletion(page: Page) {
  await page.locator("[data-account-delete]").click();
  const dialog = page.locator("[data-account-dialog]");
  await dialog.getByLabel("Type DELETE to confirm").fill("DELETE");
  await dialog.getByRole("button", { name: "Delete my account" }).click();
}

test.describe("without provider keys", () => {
  test("/account is an unknown page, and no page leads there", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await expect(page.locator("[data-account-link]")).toHaveCount(0);
    await page.goto("/account");
    await expect(page.getByRole("heading", { name: "Page not found" })).toBeVisible();
    await expect(page.locator("[data-account]")).toHaveCount(0);
  });

  test("the server refuses a guest on every route", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    for (const path of ["/api/account", "/api/account/export"]) {
      const response = await page.request.get(path);
      expect([401, 403]).toContain(response.status());
      expect(response.headers()["cache-control"]).toBe("no-store");
    }
  });
});

test.describe("with provider keys", () => {
  test("is linked beside My rooms, and downloads the person's data with no code", async ({
    browser,
  }) => {
    const { context, page, who } = await signedIn(browser);
    const path = await createRoom(page, "Kept Room");
    await join(page, "Ada");
    await page.goto(`${SIGN_IN_BASE}/`);
    await page.locator("[data-account-link]").click();
    await expect(page).toHaveURL(ACCOUNT);
    const download = page.waitForEvent("download");
    await page.locator("[data-account-export]").click();
    const file = await download;
    expect(file.suggestedFilename()).toBe("poker-planning-account.json");
    const text = await readFile(await file.path(), "utf8");
    const parsed = JSON.parse(text) as { rooms: { name: string }[]; profile: { email: string } };
    expect(parsed.profile.email).toBe(who.email);
    expect(parsed.rooms[0]?.name).toBe("Kept Room");
    expect(text).not.toContain(path.slice(3));
    await expect(page.locator("[data-account-exported]")).toHaveText("Your file is on its way.");
    await context.close();
  });

  test("hands a room to someone seated, who sees it, and the browser ends as a new guest", async ({
    browser,
  }) => {
    const { context, page } = await signedIn(browser);
    const path = await createRoom(page, "Handed Over");
    await join(page, "Ada");
    const other = await newPerson(browser);
    await other.page.goto(`${SIGN_IN_BASE}${path}`);
    await join(other.page, "Grace");

    await page.goto(ACCOUNT);
    await expect(page.locator("[data-account-room]")).toHaveCount(1);
    await expect(page.getByLabel("Who takes Handed Over")).toHaveValue("");
    await confirmDeletion(page);
    await expect(page.getByRole("heading", { name: "Your account is deleted" })).toBeFocused();
    await expect(page.getByText(/This browser is a new guest/)).toBeVisible();

    await expect(other.page.getByRole("list", { name: "People at the table" })).not.toContainText(
      "Ada",
    );
    const session = await (await page.request.get(`${SIGN_IN_BASE}/api/auth/get-session`)).json();
    expect((session as { user: { isAnonymous: boolean } }).user.isAnonymous).toBe(true);
    await context.close();
    await other.context.close();
  });

  test("a room the person chose to delete goes for the people in it, who see that", async ({
    browser,
  }) => {
    const { context, page } = await signedIn(browser);
    const path = await createRoom(page, "Deleted With It");
    await join(page, "Ada");
    const other = await newPerson(browser);
    await other.page.goto(`${SIGN_IN_BASE}${path}`);
    await join(other.page, "Grace");

    await page.goto(ACCOUNT);
    await page.getByLabel("Who takes Deleted With It").selectOption("delete");
    await expect(page.getByText(/This room goes for everyone in it/)).toBeVisible();
    await confirmDeletion(page);
    await expect(page.getByRole("heading", { name: "Your account is deleted" })).toBeVisible();
    await expect(other.page.getByRole("heading", { name: /room/i }).first()).toBeVisible();
    await expect(other.page.locator("[data-seat-part=name]")).toHaveCount(0);
    await context.close();
    await other.context.close();
  });

  test("another tab in a room reloads as a new guest", async ({ browser }) => {
    const { context, page } = await signedIn(browser);
    const path = await createRoom(page, "Two Tabs");
    await join(page, "Ada");
    const account = await context.newPage();
    await account.goto(ACCOUNT);
    await confirmDeletion(account);
    await expect(account.getByRole("heading", { name: "Your account is deleted" })).toBeVisible();
    await expect(page).toHaveURL(`${SIGN_IN_BASE}${path}`);
    await expect(page.getByText(/This room is gone|no longer|not found/i).first()).toBeVisible();
    await context.close();
  });

  test("Cancel does nothing while the request runs, and the answer still reaches the person", async ({
    browser,
  }) => {
    const { context, page } = await signedIn(browser);
    let answer = () => {};
    const held = new Promise<void>((resolve) => {
      answer = resolve;
    });
    await page.route("**/api/account/delete", async (route) => {
      await held;
      await route.fulfill({ status: 500, json: { code: "internal" } });
    });
    await confirmDeletion(page);
    const dialog = page.locator("[data-account-dialog]");
    const cancel = dialog.getByRole("button", { name: "Cancel" });
    await expect(cancel).toHaveAttribute("aria-disabled", "true");
    await cancel.focus();
    await page.keyboard.press("Enter");
    await expect(dialog).toBeVisible();
    answer();
    await expect(dialog.getByRole("alert")).toContainText("Nothing was deleted");
    await context.close();
  });

  test("a wrong word says why at the field", async ({ browser }) => {
    const { context, page } = await signedIn(browser);
    await page.locator("[data-account-delete]").click();
    const dialog = page.locator("[data-account-dialog]");
    const field = dialog.getByLabel("Type DELETE to confirm");
    await field.fill("delete it");
    await field.press("Enter");
    await expect(dialog.getByRole("alert")).toContainText("That is not the word asked for");
    await expect(field).toHaveAttribute("aria-invalid", "true");
    await context.close();
  });

  test("someone signed out in another tab hears that this request deleted nothing", async ({
    browser,
  }) => {
    const { context, page } = await signedIn(browser);
    await page.locator("[data-account-delete]").waitFor();
    const signedOut = await page.request.post(`${SIGN_IN_BASE}/api/auth/sign-out`, {
      headers: { origin: SIGN_IN_BASE },
      data: {},
    });
    expect(signedOut.ok()).toBe(true);
    await confirmDeletion(page);
    await expect(page.getByRole("heading", { name: "You are signed out" })).toBeFocused();
    await expect(page.getByText(/this request deleted nothing/)).toBeVisible();
    await expect(page.getByRole("button", { name: "Sign in with Google" })).toBeVisible();
    await context.close();
  });

  for (const language of ["en", "fr", "de"]) {
    test(`a choice's reason fits a 320 px phone in full, in ${language}`, async ({ browser }) => {
      const { context, page } = await signedIn(browser);
      await page.setViewportSize({ width: 320, height: 640 });
      await page.evaluate((chosen) => localStorage.setItem("pp-language", chosen), language);
      const seats = [{ id: "a", name: "Wolfeschlegelsteinhausenbergerdo" }];
      const room = (n: number, why: string, list = seats) => ({
        id: `00000000-0000-4000-8000-00000000000${n}`,
        name: `Room ${n}`,
        lastActiveAt: new Date().toISOString(),
        seats: list,
        why,
      });
      const shared = [
        room(1, "runsTheRoom"),
        room(2, "here"),
        room(3, "away"),
        room(4, "nobody", []),
      ];
      await page.route("**/api/account", async (route) => {
        const response = await route.fetch();
        const body = (await response.json()) as object;
        await route.fulfill({ response, json: { ...body, shared } });
      });
      await page.reload();
      await expect(page.locator("[data-account-taker-line]")).toHaveCount(4);
      const sized = await page.evaluate(() => ({
        page: document.documentElement.scrollWidth,
        lines: [...document.querySelectorAll("[data-account-taker-line]")].map(
          (line) => line.scrollWidth <= line.clientWidth,
        ),
        options: [...document.querySelectorAll("select")].map((select) => {
          const pen = document.createElement("canvas").getContext("2d");
          const style = getComputedStyle(select);
          if (pen) pen.font = `${style.fontSize} ${style.fontFamily}`;
          const text = select.options[select.selectedIndex]?.text ?? "";
          return (pen?.measureText(text).width ?? 0) <= select.clientWidth;
        }),
      }));
      expect(sized).toEqual({
        page: expect.any(Number),
        lines: [true, true, true, true],
        options: [true, true, true, true],
      });
      expect(sized.page).toBeLessThanOrEqual(320);
      for (const select of await page.locator("select").all()) {
        await expect(select).toHaveAttribute("aria-describedby", /.+/);
      }
      await context.close();
    });
  }

  test("an old session goes through the sign-in and comes back here", async ({ browser }) => {
    const { context, page } = await signedIn(browser);
    await page.route("**/api/account", async (route) => {
      const response = await route.fetch();
      const body = (await response.json()) as object;
      await route.fulfill({ response, json: { ...body, recent: false } });
    });
    await page.reload();
    await expect(page.locator("[data-account-again]")).toBeVisible();
    await page.unroute("**/api/account");
    await page.getByRole("button", { name: "Sign in again" }).click();
    await page.waitForURL(ACCOUNT);
    await expect(page.locator("[data-account-delete]")).toBeVisible();
    await context.close();
  });

  test("fits a 320 px phone with a long name and every state, with nothing for axe", async ({
    browser,
  }) => {
    const { context, page } = await signedIn(browser);
    await page.setViewportSize({ width: 320, height: 640 });
    const path = await createRoom(page, "W".repeat(60));
    await join(page, "Ada");
    const other = await newPerson(browser);
    await other.page.goto(`${SIGN_IN_BASE}${path}`);
    await join(other.page, "Grace");
    await page.goto(ACCOUNT);
    await expect(page.locator("[data-account-room]")).toHaveCount(1);
    const fits = async () => {
      const width = await page.evaluate(() => document.documentElement.scrollWidth);
      expect(width).toBeLessThanOrEqual(320);
      expect((await scan(page)).violations.map(({ id }) => id)).toEqual([]);
    };
    await fits();
    await page.locator("[data-account-delete]").click();
    const dialog = page.locator("[data-account-dialog]");
    await expect(dialog).toBeVisible();
    await dialog.evaluate((node) =>
      Promise.all(node.getAnimations({ subtree: true }).map((one) => one.finished)),
    );
    await fits();
    await context.close();
    await other.context.close();
  });
});
