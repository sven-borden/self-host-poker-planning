import { AxeBuilder } from "@axe-core/playwright";
import { WCAG_TAGS } from "./a11y.ts";
import {
  type Browser,
  type BrowserContext,
  expect,
  type Page,
  type Request,
  test,
} from "./fixtures.ts";
import { SIGN_IN_BASE, SIGN_IN_FAKE_ORIGIN } from "./signed-in.ts";
import { dbQuery, newPerson, ownAddress, ROOM_PATH, recordFrames } from "./support.ts";

// Sign-in with Google and Microsoft (#47, ADR-023) in a real browser, under the production
// headers: `e2e/fixtures.ts` fails a test on any policy violation, so the whole flow proves the
// policy needed no change. The server runs the providers' own addresses, and the stand-in in its
// process answers for them (e2e/signed-in.ts). Here the browser's navigation to Google or
// Microsoft goes to the same stand-in, which sends it back with a code and the `state`: a real
// redirect, a real callback.

interface Person {
  id: string;
  email?: string;
  name: string;
  tenant?: string;
}

let people = 0;
function person(name = "Ada Lovelace"): Person {
  people += 1;
  const id = `${Date.now()}-${people}`;
  return { id, email: `person-${id}@example.com`, name, tenant: "tenant-e2e" };
}

const PROVIDER = /^https:\/\/(accounts\.google\.com|login\.microsoftonline\.com)\//;

/**
 * The browser's visits to the providers go to the stand-in, as `who` (`denied`: the person
 * cancels there). The requests are kept, as they left the page.
 */
async function atProviders(context: BrowserContext, who: Person | "denied"): Promise<Request[]> {
  const seen: Request[] = [];
  const param = Buffer.from(JSON.stringify(who)).toString("base64url");
  await context.route(PROVIDER, async (route) => {
    seen.push(route.request());
    const url = new URL(route.request().url());
    await route.fulfill({
      status: 302,
      headers: {
        location: `${SIGN_IN_FAKE_ORIGIN}${url.pathname}${url.search}&fake_person=${param}`,
      },
    });
  });
  return seen;
}

const buttonOf = (page: Page, name: string) => page.getByRole("button", { name });

/** In a room, on a screen that may be shared: the name and the provider, never the address. */
async function expectNoAddress(page: Page, who: Person, provider: string) {
  await expect(page.locator("[data-sign-in]")).toContainText(`Signed in with ${provider}`);
  await expect(page.locator("body")).not.toContainText(who.email ?? "");
}
const signOutButton = (page: Page) => page.getByRole("button", { name: "Sign out" });

async function newRoom(page: Page): Promise<string> {
  await page.goto(SIGN_IN_BASE);
  await page.getByRole("button", { name: "Create the room" }).click();
  await expect(page).toHaveURL(ROOM_PATH);
  return ROOM_PATH.exec(page.url())?.[1] ?? "";
}

async function joinAs(page: Page) {
  await page.getByRole("button", { name: "Join the room" }).click();
  await expect(page.getByRole("heading", { name: "You", exact: true })).toBeVisible();
}

test.describe("without provider keys", () => {
  test("no page offers a sign-in, and nothing in it tells of one", async ({ browser }) => {
    const { context, page } = await newPerson(browser);
    await page.goto("/");
    await expect(page.getByRole("button", { name: "Create the room" })).toBeVisible();
    await expect(page.locator('meta[name="pp-sign-in"]')).toHaveCount(0);
    await page.getByRole("button", { name: "Create the room" }).click();
    await expect(page).toHaveURL(ROOM_PATH);
    await expect(page.getByRole("button", { name: "Join the room" })).toBeVisible();
    await expect(page.locator("[data-sign-in]")).toHaveCount(0);
    await page.getByRole("textbox", { name: "Your name" }).fill("Ada");
    await joinAs(page);
    await expect(page.locator("[data-sign-in]")).toHaveCount(0);
    await expect(page.getByRole("button", { name: /Sign in/ })).toHaveCount(0);
    await context.close();
  });
});

test.describe("with provider keys", () => {
  test("a guest signs in on the landing page and comes back to it, signed in", async ({
    browser,
  }) => {
    const { context, page } = await newPerson(browser);
    const who = person();
    await atProviders(context, who);
    await page.goto(SIGN_IN_BASE);
    await buttonOf(page, "Sign in with Google").click();
    await expect(page.locator("[data-account]")).toHaveText(who.email ?? "");
    await expect(page.locator("[data-sign-in]")).toContainText("Signed in with Google");
    expect(page.url()).toBe(`${SIGN_IN_BASE}/`);
    await expect(page.getByRole("button", { name: /Sign in/ })).toHaveCount(0);
    await context.close();
  });

  test("signing in from a room comes back to that room, and a code goes nowhere", async ({
    browser,
  }) => {
    const { context, page } = await newPerson(browser);
    const who = person("Grace Hopper");
    const requests = await atProviders(context, who);
    const frames = recordFrames(page);
    const code = await newRoom(page);
    await buttonOf(page, "Sign in with Microsoft").click();
    await expect(page.locator("[data-account]")).toHaveText("Grace Hopper");
    expect(page.url()).toBe(`${SIGN_IN_BASE}/r/${code}`);
    await expect(page.getByRole("textbox", { name: "Your name" })).toHaveValue("Grace Hopper");
    await expectNoAddress(page, who, "Microsoft");

    expect(requests).toHaveLength(1);
    const [request] = requests;
    expect(request?.url()).not.toContain(code);
    // `Referrer-Policy: same-origin`: nothing of the room's address in the header either.
    expect(await request?.headerValue("referer")).toBeNull();

    await joinAs(page);
    await expect(page.locator("section[data-you] [data-account]")).toHaveText("Grace Hopper");
    await expect(page.locator("[data-you-name] bdi")).toHaveText("Grace Hopper");
    await expectNoAddress(page, who, "Microsoft");
    for (const frame of frames) {
      expect(frame).not.toContain(who.email);
      expect(frame).not.toContain(who.id);
    }
    await context.close();
  });

  test("a guest PO signs in at the table: same seat, same card, no form, and no other tab left behind", async ({
    browser,
  }) => {
    const { context, page } = await newPerson(browser);
    const who = person("Grace Hopper");
    await atProviders(context, who);
    const code = await newRoom(page);
    await page.getByRole("textbox", { name: "Your name" }).fill("Table Name");
    await joinAs(page);
    // A second person keeps the round open: alone, a card would reveal it.
    const ben = await newPerson(browser);
    await ben.page.goto(`${SIGN_IN_BASE}/r/${code}`);
    await ben.page.getByRole("textbox", { name: "Your name" }).fill("Ben");
    await joinAs(ben.page);
    await page.getByRole("button", { name: "Start voting" }).click();
    const card = page.getByRole("button", { name: "5", exact: true });
    await card.click();
    await expect(card).toHaveAttribute("aria-pressed", "true");

    const other = await context.newPage();
    await other.goto(`${SIGN_IN_BASE}/r/${code}`);
    await expect(other.locator("[data-you-name] bdi")).toHaveText("Table Name");

    await buttonOf(page, "Sign in with Microsoft").click();
    await expect(page.locator("section[data-you] [data-account]")).toHaveText("Grace Hopper");
    expect(page.url()).toBe(`${SIGN_IN_BASE}/r/${code}`);
    await expect(page.locator("[data-you-name] bdi")).toHaveText("Table Name");
    await expect(page.getByRole("button", { name: "Join the room" })).toHaveCount(0);
    await expect(card).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByRole("button", { name: "Reveal cards" }).first()).toBeEnabled();
    await expectNoAddress(page, who, "Microsoft");

    // The other tab of that guest hears of it, and comes back as the account, at the same seat.
    await expect(other.locator("section[data-you] [data-account]")).toHaveText("Grace Hopper");
    await expect(other.locator("[data-you-name] bdi")).toHaveText("Table Name");
    await expect(other.getByRole("button", { name: "Join the room" })).toHaveCount(0);
    await expect(other.getByRole("button", { name: "5", exact: true })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    // At the table the seat keeps the name it had, and the round stays open.
    await expect(ben.page.getByText("Table Name").first()).toBeVisible();
    await expect(ben.page.getByText("Grace Hopper")).toHaveCount(0);
    await expect(ben.page.getByRole("button", { name: "Join the room" })).toHaveCount(0);
    await context.close();
    await ben.context.close();
  });

  test("the account row holds no provider token after a browser's sign-in", async ({ browser }) => {
    const { context, page } = await newPerson(browser);
    const who = person();
    await atProviders(context, who);
    await page.goto(SIGN_IN_BASE);
    await buttonOf(page, "Sign in with Microsoft").click();
    await expect(page.locator("[data-account]")).toHaveText(who.email ?? "");
    const rows = await dbQuery<Record<string, unknown>>(
      `select access_token, refresh_token, id_token, tenant_id from account where account_id = $1`,
      [`tenant-e2e:${who.id}`],
    );
    expect(rows).toEqual([
      { access_token: null, refresh_token: null, id_token: null, tenant_id: "tenant-e2e" },
    ]);
    await context.close();
  });

  test("signing out in a room leaves a new guest on the same page", async ({ browser }) => {
    const { context, page } = await newPerson(browser);
    const who = person();
    await atProviders(context, who);
    const code = await newRoom(page);
    await buttonOf(page, "Sign in with Google").click();
    await expect(page.locator("[data-account]")).toHaveText(who.name);
    await joinAs(page);
    await signOutButton(page).click();
    await expect(page.getByRole("button", { name: "Join the room" })).toBeVisible();
    expect(page.url()).toBe(`${SIGN_IN_BASE}/r/${code}`);
    await expect(buttonOf(page, "Sign in with Google")).toBeVisible();
    await expect(page.locator("[data-account]")).toHaveCount(0);
    await expect(page.getByRole("textbox", { name: "Your name" })).toHaveValue("");
    await page.getByRole("textbox", { name: "Your name" }).fill("Cleo");
    await joinAs(page);
    await expect(page.locator("[data-you-name] bdi")).toHaveText("Cleo");
    await context.close();
  });

  test("a guest who cancels stays a guest, and hears why in their language", async ({
    browser,
  }) => {
    const context = await browser.newContext({ locale: "fr-FR", extraHTTPHeaders: ownAddress() });
    const page = await context.newPage();
    await atProviders(context, "denied");
    await page.goto(SIGN_IN_BASE);
    await page.getByRole("button", { name: "Se connecter avec Google" }).click();
    await expect(page.getByText("Connexion annulée.")).toBeVisible();
    expect(page.url()).toBe(`${SIGN_IN_BASE}/`);
    await expect(page.getByRole("button", { name: "Se connecter avec Google" })).toBeVisible();
    await context.close();
  });

  test("a broken link back from a provider lands on the app, not on JSON", async ({ browser }) => {
    const context = await browser.newContext({ locale: "de-DE", extraHTTPHeaders: ownAddress() });
    const page = await context.newPage();
    await page.goto(`${SIGN_IN_BASE}/api/auth/callback/google?state=old&code=old`);
    await expect(page.getByText("Die Anmeldung wurde nicht abgeschlossen.")).toBeVisible();
    expect(page.url()).toBe(`${SIGN_IN_BASE}/`);
    await context.close();
  });

  test("works through the installed app's service worker", async ({ browser }) => {
    const context = await browser.newContext({
      locale: "en-US",
      extraHTTPHeaders: ownAddress(),
      serviceWorkers: "allow",
    });
    const page = await context.newPage();
    const who = person();
    await atProviders(context, who);
    const code = await newRoom(page);
    await page.evaluate(() => navigator.serviceWorker.ready.then(() => undefined));
    await page.reload();
    await expect
      .poll(() => page.evaluate(() => navigator.serviceWorker.controller !== null))
      .toBe(true);
    await buttonOf(page, "Sign in with Google").click();
    await expect(page.locator("[data-account]")).toHaveText(who.name);
    expect(page.url()).toBe(`${SIGN_IN_BASE}/r/${code}`);
    await context.close();
  });

  test("holds its buttons and a long address on a 320 px phone, with nothing for axe", async ({
    browser,
  }: {
    browser: Browser;
  }) => {
    const context = await browser.newContext({
      locale: "de-DE",
      viewport: { width: 320, height: 640 },
      extraHTTPHeaders: ownAddress(),
    });
    const page = await context.newPage();
    const id = person().id;
    await atProviders(context, {
      ...person("Ada"),
      email: `a.very.long.address.of.someone.${id}@departement.example.com`,
    });
    await page.goto(SIGN_IN_BASE);
    const fits = () =>
      page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
    await expect(page.getByRole("button", { name: "Mit Google anmelden" })).toBeVisible();
    expect(await fits()).toBe(true);
    const audit = () => new AxeBuilder({ page }).include("[data-sign-in]").withTags(WCAG_TAGS);
    expect((await audit().analyze()).violations).toEqual([]);
    await page.getByRole("button", { name: "Mit Google anmelden" }).click();
    await expect(page.locator("[data-account]")).toBeVisible();
    expect(await fits()).toBe(true);
    expect((await audit().analyze()).violations).toEqual([]);
    await context.close();
  });
});
