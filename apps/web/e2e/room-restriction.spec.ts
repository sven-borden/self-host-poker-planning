import { scan } from "./a11y.ts";
import { type BrowserContext, expect, type Page, test } from "./fixtures.ts";
import { SIGN_IN_BASE, SIGN_IN_FAKE_ORIGIN } from "./signed-in.ts";
import { newPerson, ROOM_PATH } from "./support.ts";

// A room limited to accounts (#50, ADR-028) in a real browser, under the production headers, with
// real redirects to the stand-in for the providers (e2e/signed-in.ts). The PO sets a rule in the
// panel; a guest is asked to sign in, and sees neither the room's name nor its people; a wrong
// account is told why, signs out, signs in with the right one and lands back in the room.

interface Person {
  id: string;
  email: string;
  name: string;
  tenant: string;
  emailVerified: boolean;
}

let people = 0;
/** Someone at `domain`, with an address of their own: a retry or a second run meets no other. */
function person(name: string, domain: string, tenant = "tenant-e2e"): Person {
  people += 1;
  const id = `${Date.now()}-${people}`;
  return { id, email: `person-${id}@${domain}`, name, tenant, emailVerified: true };
}

const PROVIDER = /^https:\/\/(accounts\.google\.com|login\.microsoftonline\.com)\//;

/** From now on the browser's visits to the providers answer as `who`. */
async function signsInAs(context: BrowserContext, who: Person) {
  await context.unroute(PROVIDER);
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
}

const signIn = (page: Page, provider: "Google" | "Microsoft") =>
  page.getByRole("button", { name: `Sign in with ${provider}` }).click();

/** A signed-in PO at the table of a new, named room: its address. */
async function poAtTheTable(page: Page, context: BrowserContext, who: Person): Promise<string> {
  await signsInAs(context, who);
  await page.goto(SIGN_IN_BASE);
  await signIn(page, "Google");
  await expect(page.locator("[data-account]")).toHaveText(who.email);
  await page.getByRole("textbox", { name: /Room name/ }).fill("Confidential planning");
  await page.getByRole("button", { name: "Create the room" }).click();
  await expect(page).toHaveURL(ROOM_PATH);
  await page.getByRole("button", { name: "Join the room" }).click();
  await expect(page.getByRole("heading", { name: "You", exact: true })).toBeVisible();
  return page.url();
}

async function setRule(page: Page, domains: string) {
  await page.getByRole("button", { name: "Room settings" }).click();
  const dialog = page.getByRole("dialog", { name: "Room settings" });
  await dialog.getByRole("textbox", { name: "Email domains" }).fill(domains);
  await dialog.getByRole("button", { name: "Save the rule" }).click();
  return dialog;
}

test("a guest is asked to sign in, a wrong account is told why, and the right one joins", async ({
  browser,
}) => {
  const po = await newPerson(browser);
  const owner = person("Pia Product", "example.com");
  const url = await poAtTheTable(po.page, po.context, owner);
  const dialog = await setRule(po.page, "example.com");
  await expect(dialog.getByRole("button", { name: "Remove the rule" })).toBeVisible();
  await dialog.getByRole("button", { name: "Close" }).click();

  // A guest: no form, no people, no name, and what would pass.
  const guest = await newPerson(browser);
  await guest.page.goto(url);
  const refused = guest.page.locator('[data-room-restricted="sign_in_required"]');
  await expect(refused).toContainText("Google account on example.com");
  await expect(guest.page.getByRole("button", { name: "Join the room" })).toHaveCount(0);
  await expect(guest.page.getByRole("button", { name: "Sign in with Microsoft" })).toHaveCount(0);
  await expect(guest.page.locator("body")).not.toContainText("Confidential planning");
  await expect(guest.page.locator("body")).not.toContainText("Pia");
  expect((await scan(guest.page)).violations).toEqual([]);

  // A wrong account: told which rule failed, and how to try another.
  await signsInAs(guest.context, person("Otto Other", "elsewhere.example"));
  await signIn(guest.page, "Google");
  await expect(guest.page.locator('[data-room-restricted="account_not_allowed"]')).toContainText(
    "not on one of these domains",
  );
  expect(guest.page.url()).toBe(url);

  // Sign-out then sign-in, with the room as the way back.
  await signsInAs(guest.context, person("Cleo Colleague", "example.com"));
  await guest.page.getByRole("button", { name: "Sign out" }).click();
  await expect(guest.page.locator('[data-room-restricted="sign_in_required"]')).toBeVisible();
  await signIn(guest.page, "Google");
  await expect(guest.page.getByRole("button", { name: "Join the room" })).toBeVisible();
  expect(guest.page.url()).toBe(url);
  await expect(guest.page.getByRole("heading", { level: 1 })).toContainText(
    "Confidential planning",
  );
  await guest.page.getByRole("button", { name: "Join the room" }).click();
  await expect(guest.page.getByRole("heading", { name: "You", exact: true })).toBeVisible();
  await guest.context.close();
  await po.context.close();
});

test("someone seated stays until they reload, the PO sees a count, and the PO stays", async ({
  browser,
}) => {
  const po = await newPerson(browser);
  const url = await poAtTheTable(po.page, po.context, person("Pia Product", "example.org"));

  const seated = await newPerson(browser);
  await seated.page.goto(url);
  await seated.page.getByRole("textbox", { name: "Your name" }).fill("Gus Guest");
  await seated.page.getByRole("button", { name: "Join the room" }).click();
  await expect(seated.page.getByRole("heading", { name: "You", exact: true })).toBeVisible();

  // A rule the PO does not meet asks first.
  const dialog = await setRule(po.page, "example.com");
  await expect(dialog.locator("[data-restriction-ask]")).toContainText(
    "You do not meet this rule yourself.",
  );
  await dialog.getByRole("button", { name: "Save it anyway" }).click();
  await expect(dialog.locator("[data-restriction-outsiders]")).toContainText(
    "1 person here would not pass.",
  );
  await expect(dialog.locator("[data-restriction-outsiders]")).not.toContainText("Gus");

  await expect(seated.page.getByRole("heading", { name: "You", exact: true })).toBeVisible();
  await seated.page.reload();
  await expect(seated.page.locator('[data-room-restricted="sign_in_required"]')).toBeVisible();

  await po.page.reload();
  await expect(po.page.getByRole("heading", { name: "You", exact: true })).toBeVisible();
  await seated.context.close();
  await po.context.close();
});

test("the PO removes everyone who would not pass, without being shown who", async ({ browser }) => {
  const po = await newPerson(browser);
  const url = await poAtTheTable(po.page, po.context, person("Pia Product", "example.com"));

  const seated = await newPerson(browser);
  await seated.page.goto(url);
  await seated.page.getByRole("textbox", { name: "Your name" }).fill("Gus Guest");
  await seated.page.getByRole("button", { name: "Join the room" }).click();
  await expect(seated.page.getByRole("heading", { name: "You", exact: true })).toBeVisible();

  const dialog = await setRule(po.page, "example.com");
  await expect(dialog.locator("[data-restriction-outsiders]")).toContainText(
    "1 person here would not pass.",
  );
  await dialog.getByRole("button", { name: "Remove everyone who would not pass" }).click();
  await expect(dialog.locator("[data-restriction-remove-ask]")).toContainText(
    "1 person leaves the room now",
  );
  await dialog.getByRole("button", { name: "Remove them" }).click();
  await expect(dialog.locator("[data-restriction-outsiders]")).toHaveCount(0);
  await expect(seated.page.getByRole("heading", { name: "You", exact: true })).toHaveCount(0);
  await seated.context.close();
  await po.context.close();
});

test("a domain of 63 letters does not widen the refused screen at 320 px", async ({ browser }) => {
  const po = await newPerson(browser);
  const url = await poAtTheTable(po.page, po.context, person("Pia Product", "example.com"));
  const long = `${"a".repeat(63)}.example.com`;
  const dialog = await setRule(
    po.page,
    `example.com
${long}`,
  );
  await expect(dialog.getByRole("button", { name: "Remove the rule" })).toBeVisible();

  const guest = await newPerson(browser);
  await guest.page.setViewportSize({ width: 320, height: 640 });
  await guest.page.goto(url);
  await expect(guest.page.locator("[data-room-restricted]")).toContainText(long);
  await expect(guest.page.locator("[data-room-restricted]")).toContainText("example.com or");
  const width = await guest.page.evaluate(() => ({
    page: document.documentElement.scrollWidth,
    view: document.documentElement.clientWidth,
  }));
  expect(width.page).toBeLessThanOrEqual(width.view);
  await guest.context.close();
  await po.context.close();
});
