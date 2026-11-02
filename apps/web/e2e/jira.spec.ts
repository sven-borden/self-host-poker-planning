import { AxeBuilder } from "@axe-core/playwright";
import { settle, WCAG_TAGS } from "./a11y.ts";
import { type BrowserContext, expect, type Page, test } from "./fixtures.ts";
import { JIRA_FAKE_ORIGIN, SIGN_IN_BASE, SIGN_IN_FAKE_ORIGIN } from "./signed-in.ts";
import { handCard, newPerson, ownAddress, ROOM_PATH, recordFrames } from "./support.ts";

// The Jira connector (#54, ADR-030) through the page, against the real server, under the
// production headers. The server runs Atlassian's own addresses and a stand-in answers in its
// process (`fake-jira-start.ts`); the browser's visit to Atlassian goes to the same stand-in here.
// The spec reads what the stand-in received, and tells it to fail, over its own small HTTP door.
// Serial: the stand-in is one, and a forced failure is for the next call, whoever makes it.

test.skip(
  !process.env.DATABASE_URL && !process.env.CI,
  "needs DATABASE_URL: runs against the real server",
);
test.describe.configure({ mode: "serial" });

const ACME = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Acme",
  url: "https://acme.atlassian.net",
};
const GLOBEX = {
  id: "22222222-2222-4222-8222-222222222222",
  name: "Globex",
  url: "https://globex.atlassian.net",
};
const ISSUES = [
  { id: "10001", key: "ABC-1", summary: "The login page", sprint: 7 },
  { id: "10002", key: "ABC-2", summary: "A report by team", sprint: 7 },
  { id: "10003", key: "ABC-3", summary: "Not in this sprint", sprint: 8 },
];

async function control(body: object) {
  const answer = await fetch(`${JIRA_FAKE_ORIGIN}/__control`, {
    method: "POST",
    body: JSON.stringify(body),
  });
  expect(answer.ok).toBe(true);
}

interface FakeState {
  writes: { site: string; issue: string; body: unknown; token: string }[];
  authorizations: Record<string, string>[];
}
const fakeState = async () =>
  (await (await fetch(`${JIRA_FAKE_ORIGIN}/__state`)).json()) as FakeState;

let people = 0;

/** The browser's visits to a provider and to Atlassian go to the stand-ins. */
async function atStandIns(context: BrowserContext) {
  people += 1;
  const id = `${Date.now()}-${people}`;
  const who = { id, email: `jira-${id}@example.com`, name: "Pia Owner", tenant: "tenant-e2e" };
  const param = Buffer.from(JSON.stringify(who)).toString("base64url");
  await context.route(/^https:\/\/accounts\.google\.com\//, async (route) => {
    const url = new URL(route.request().url());
    await route.fulfill({
      status: 302,
      headers: {
        location: `${SIGN_IN_FAKE_ORIGIN}${url.pathname}${url.search}&fake_person=${param}`,
      },
    });
  });
  await context.route(/^https:\/\/auth\.atlassian\.com\//, async (route) => {
    const url = new URL(route.request().url());
    await route.fulfill({
      status: 302,
      headers: { location: `${JIRA_FAKE_ORIGIN}${url.pathname}${url.search}` },
    });
  });
}

/** Signed in, in a room of their own, seated. */
async function poInRoom(page: Page): Promise<string> {
  await page.goto(SIGN_IN_BASE);
  await page.getByRole("button", { name: "Create the room" }).click();
  await expect(page).toHaveURL(ROOM_PATH);
  await page.getByRole("button", { name: "Sign in with Google" }).click();
  await expect(page.locator("[data-account]")).toHaveText("Pia Owner");
  await page.getByRole("button", { name: "Join the room" }).click();
  await expect(page.getByRole("heading", { name: "You", exact: true })).toBeVisible();
  return ROOM_PATH.exec(page.url())?.[1] ?? "";
}

const section = (page: Page) => page.locator("[data-connector=jira]");
const closeSheet = (page: Page) => page.getByRole("button", { name: "Close" }).click();

/** Connected, on one site, the estimate's field saved: the sheet stays open. */
async function connected(page: Page) {
  await page.locator("[data-queue-open]").click();
  await section(page).getByRole("button", { name: "Connect Jira" }).click();
  await expect(section(page).locator("[data-connector-result=connected]")).toBeVisible();
}

async function importJql(page: Page, jql: string) {
  await section(page).getByRole("radio", { name: "A JQL search" }).check();
  await section(page).getByRole("textbox", { name: "JQL query" }).fill(jql);
  await section(page).locator("[data-connector-run]").click();
}

/** One person's round on the next item, to a recorded final. */
async function estimateNext(page: Page, start: string, card: string) {
  await page.getByRole("button", { name: start }).click();
  await handCard(page, card).click();
  await expect(page.locator("[data-record-final]")).toBeVisible();
  await page.locator(`[data-final-card="${card}"]`).click();
  await page.locator("[data-record-final]").click();
}

test.beforeEach(async ({ page }) => {
  await page.setExtraHTTPHeaders(ownAddress());
  await control({ sites: [ACME], issues: ISSUES });
});

test("connects, picks a site and a field, imports, and the final reaches Jira", async ({
  browser,
}) => {
  await control({ sites: [ACME, GLOBEX] });
  const { context, page } = await newPerson(browser);
  await atStandIns(context);
  const frames = recordFrames(page);
  const code = await poInRoom(page);
  await connected(page);
  // The way back left no trace in the address, and no room code left for Atlassian.
  expect(page.url()).toBe(`${SIGN_IN_BASE}/r/${code}`);
  const asked = (await fakeState()).authorizations.at(-1);
  expect(JSON.stringify(asked)).not.toContain(code);

  await section(page).getByRole("combobox", { name: "Site" }).selectOption({ label: "Acme" });
  await section(page).getByRole("button", { name: "Use this site" }).click();
  await expect(section(page).locator("[data-connector-site-name]")).toHaveText("Connected to Acme");
  const field = section(page).getByRole("combobox", { name: "Estimates go to" });
  await expect(field).toHaveValue("customfield_10016");
  await section(page).getByRole("button", { name: "Save the field" }).click();
  await expect(section(page).locator("[data-connector-field-name]")).toHaveText(
    "Estimates go to Story Points",
  );

  await expect(section(page).getByRole("combobox", { name: "Sprint" })).toContainText(
    "Sprint 7 (active)",
  );
  await section(page).locator("[data-connector-run]").click();
  await expect(section(page).locator("[data-connector-report]")).toHaveText("2 items added.");
  await expect(page.locator("[data-queue-item]")).toHaveCount(2);
  await expect(page.locator("[data-queue-title]").first()).toHaveText("The login page");
  await closeSheet(page);

  await estimateNext(page, "Start voting", "5");
  const line = page.locator("[data-write-line=written]");
  await expect(line).toHaveText("ABC-1: 5 is in Jira.");
  const write = (await fakeState()).writes.at(-1);
  expect(write).toMatchObject({
    site: ACME.id,
    issue: "10001",
    body: { fields: { customfield_10016: 5 } },
  });
  expect(frames.join("")).not.toContain("fake-access");
  expect(frames.join("")).not.toContain(ACME.id);
  await context.close();
});

test("a write that fails keeps the round, shows beside it and can be tried again", async ({
  browser,
}) => {
  const { context, page } = await newPerson(browser);
  await atStandIns(context);
  await poInRoom(page);
  await connected(page);
  await section(page).getByRole("button", { name: "Save the field" }).click();
  await expect(section(page).locator("[data-connector-field-name]")).toBeVisible();
  await importJql(page, "project = ABC");
  await expect(section(page).locator("[data-connector-report]")).toContainText("3 items added.");
  await closeSheet(page);

  await control({
    fail: [{ match: "/rest/api/3/issue/", status: 429, retryAfter: "30" }],
  });
  await estimateNext(page, "Start voting", "8");
  const failed = page.locator("[data-write-line=failed]");
  await expect(failed).toContainText("ABC-1: 8 did not reach Jira.");
  await expect(failed).toContainText("Try again in 30 s");
  await expect(page.locator("[data-centre-final], [data-record-final]").first()).toBeVisible();

  // The room moves on, and the failure stays, under the next round too.
  await page.getByRole("button", { name: "Next item" }).click();
  await expect(failed).toContainText("ABC-1");
  const before = (await fakeState()).writes.length;
  await failed.getByRole("button", { name: "Try again" }).click();
  await expect(failed).toHaveCount(0);
  const state = await fakeState();
  expect(state.writes).toHaveLength(before + 1);
  expect(state.writes.at(-1)).toMatchObject({
    issue: "10001",
    body: { fields: { customfield_10016: 8 } },
  });
  await context.close();
});

test("says what a refused query is, keeps the box, and a disconnect goes back to Connect", async ({
  browser,
}) => {
  const { context, page } = await newPerson(browser);
  await atStandIns(context);
  await poInRoom(page);
  await connected(page);
  await importJql(page, "bad jql here");
  await expect(section(page).locator("[data-connector-problem=connector_bad_query]")).toBeVisible();
  await expect(section(page).getByRole("textbox", { name: "JQL query" })).toHaveValue(
    "bad jql here",
  );
  await expect(section(page).getByRole("link")).toHaveAttribute(
    "href",
    "https://id.atlassian.com/manage-profile/apps",
  );
  await section(page).getByRole("button", { name: "Disconnect" }).click();
  await expect(section(page).getByRole("button", { name: "Connect Jira" })).toBeVisible();
  await context.close();
});

test("the person who goes back at Atlassian is told, and nothing is stored", async ({
  browser,
}) => {
  const { context, page } = await newPerson(browser);
  await atStandIns(context);
  await context.route(/^https:\/\/auth\.atlassian\.com\//, async (route) => {
    const url = new URL(route.request().url());
    await route.fulfill({
      status: 302,
      headers: { location: `${JIRA_FAKE_ORIGIN}${url.pathname}${url.search}&fake_denied=1` },
    });
  });
  await poInRoom(page);
  await page.locator("[data-queue-open]").click();
  await section(page).getByRole("button", { name: "Connect Jira" }).click();
  await expect(section(page).locator("[data-connector-result=cancelled]")).toBeVisible();
  await expect(section(page).getByRole("button", { name: "Connect Jira" })).toBeVisible();
  await context.close();
});

test("a guest PO is asked to sign in, and sees no way to connect", async ({ browser }) => {
  const { context, page } = await newPerson(browser);
  await page.goto(SIGN_IN_BASE);
  await page.getByRole("button", { name: "Create the room" }).click();
  await expect(page).toHaveURL(ROOM_PATH);
  await page.getByRole("textbox", { name: "Your name" }).fill("Gia");
  await page.getByRole("button", { name: "Join the room" }).click();
  await page.locator("[data-queue-open]").click();
  await expect(section(page).locator("[data-connector-sign-in]")).toBeVisible();
  await expect(section(page).getByRole("button", { name: "Connect Jira" })).toHaveCount(0);
  await context.close();
});

test("without keys nothing of it shows", async ({ browser }) => {
  const { context, page } = await newPerson(browser);
  await page.goto("/");
  await page.getByRole("button", { name: "Create the room" }).click();
  await expect(page).toHaveURL(ROOM_PATH);
  await expect(page.locator('meta[name="pp-connectors"]')).toHaveCount(0);
  await page.getByRole("textbox", { name: "Your name" }).fill("Gia");
  await page.getByRole("button", { name: "Join the room" }).click();
  await page.locator("[data-queue-open]").click();
  await expect(page.locator("[data-queue-form]")).toBeVisible();
  await expect(section(page)).toHaveCount(0);
  await context.close();
});

test("axe finds nothing at 320 px, connecting and connected", async ({ browser }) => {
  await control({ sites: [ACME, GLOBEX] });
  const { context, page } = await newPerson(browser);
  await atStandIns(context);
  await page.setViewportSize({ width: 320, height: 800 });
  await poInRoom(page);
  await page.locator("[data-queue-open]").click();
  const audit = async () => {
    await settle(page);
    const { violations } = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
    expect(violations.map(({ id }) => id)).toEqual([]);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
  };
  await expect(section(page).getByRole("button", { name: "Connect Jira" })).toBeVisible();
  await audit();
  await section(page).getByRole("button", { name: "Connect Jira" }).click();
  await expect(section(page).getByRole("combobox", { name: "Site" })).toBeVisible();
  await audit();
  await section(page).getByRole("button", { name: "Use this site" }).click();
  await expect(section(page).getByRole("combobox", { name: "Estimates go to" })).toBeVisible();
  await audit();
  await section(page).getByRole("button", { name: "Save the field" }).click();
  await expect(section(page).getByRole("combobox", { name: "Sprint" })).toBeVisible();
  await audit();
  await importJql(page, "bad jql here");
  await expect(section(page).locator("[data-connector-problem]")).toBeVisible();
  await audit();
  await context.close();
});
