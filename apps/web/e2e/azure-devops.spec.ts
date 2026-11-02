import { AxeBuilder } from "@axe-core/playwright";
import { settle, WCAG_TAGS } from "./a11y.ts";
import { type BrowserContext, expect, type Page, test } from "./fixtures.ts";
import { AZURE_FAKE_ORIGIN, SIGN_IN_BASE, SIGN_IN_FAKE_ORIGIN } from "./signed-in.ts";
import { handCard, newPerson, ownAddress, ROOM_PATH, recordFrames } from "./support.ts";

// The Azure DevOps connector (#55, ADR-031) through the page, against the real server, under the
// production headers. The server runs `https://dev.azure.com/…` and a stand-in answers in its
// process (`fake-azure-devops-start.ts`). The spec reads what the stand-in received, and tells it
// to fail, over its own small HTTP door. Serial: the stand-in is one, and a forced failure is for
// the next call, whoever makes it.

test.skip(
  !process.env.DATABASE_URL && !process.env.CI,
  "needs DATABASE_URL: runs against the real server",
);
test.describe.configure({ mode: "serial" });

const TOKEN = "e2e-pat-work-write-0123456789abcdefghijklmnopqrstuvwxyz0123";
const STORY_POINTS = "Microsoft.VSTS.Scheduling.StoryPoints";
const QUERY_SHARED = "33333333-aaaa-4aaa-8aaa-333333333333";
const FIBER = {
  id: "6ce954b1-ce1f-45d1-b94d-e6bf2464ba2c",
  name: "Fabrikam Fiber",
  process: "Agile",
};
const CUSTOM = { id: "9f2b7c10-5e3a-4c8d-8b21-4d7e6a1c3b90", name: "Own Way", process: "Custom" };
const ITEMS = [
  { id: 1, title: "The login page", type: "User Story" },
  { id: 2, title: "A report by team", type: "User Story" },
  { id: 3, title: "Set up the build", type: "Task" },
];

async function control(body: object) {
  const answer = await fetch(`${AZURE_FAKE_ORIGIN}/__control`, {
    method: "POST",
    body: JSON.stringify(body),
  });
  expect(answer.ok).toBe(true);
}

interface FakeState {
  writes: {
    organization: string;
    item: string;
    body: unknown;
    token: string;
    contentType: string;
  }[];
  calls: string[];
}
const fakeState = async () =>
  (await (await fetch(`${AZURE_FAKE_ORIGIN}/__state`)).json()) as FakeState;

let people = 0;

/** The browser's visit to a provider goes to the stand-in. */
async function atStandIn(context: BrowserContext) {
  people += 1;
  const id = `${Date.now()}-${people}`;
  const who = { id, email: `azure-${id}@example.com`, name: "Pia Owner", tenant: "tenant-e2e" };
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

const section = (page: Page) => page.locator("[data-connector=azure-devops]");
const closeSheet = (page: Page) => page.getByRole("button", { name: "Close" }).click();
const patField = (page: Page) =>
  section(page).getByRole("textbox", { name: "Personal access token" });
const problem = (page: Page, code: string) =>
  section(page).locator(`[data-connector-problem=${code}]`);

async function fillToken(page: Page, organization: string, token: string) {
  await section(page).getByRole("textbox", { name: "Organisation" }).fill(organization);
  await patField(page).fill(token);
  await section(page).getByRole("button", { name: "Connect Azure DevOps" }).click();
}

/** The sheet open, connected to the one project there is. */
async function connected(page: Page) {
  await page.locator("[data-queue-open]").click();
  await fillToken(page, "fabrikam", TOKEN);
  await expect(section(page).getByText("Connected to fabrikam")).toBeVisible();
}

async function importSaved(page: Page) {
  await section(page)
    .getByRole("combobox", { name: "Saved query" })
    .selectOption({ label: "Shared Queries/Team/Backlog" });
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
  await control({
    reset: true,
    tokens: { [TOKEN]: { organizations: ["fabrikam"], scopes: ["vso.work_write"] } },
    items: ITEMS,
    projects: [FIBER],
    saved: { [QUERY_SHARED]: { ids: [1, 2, 3] } },
  });
});

test("connects with a token, imports a saved query, and the final reaches Azure DevOps", async ({
  browser,
}) => {
  await control({ projects: [FIBER, CUSTOM] });
  const { context, page } = await newPerson(browser);
  await atStandIn(context);
  const frames = recordFrames(page);
  const sent: string[] = [];
  page.on("request", (request) => {
    sent.push(`${request.url()} ${request.postData() ?? ""}`);
  });
  await poInRoom(page);
  await page.locator("[data-queue-open]").click();

  await expect(patField(page)).toHaveAttribute("type", "password");
  await expect(patField(page)).toHaveAttribute("autocomplete", "off");
  await fillToken(page, "fabrikam", TOKEN);
  await expect(section(page).getByText("Connected to fabrikam")).toBeVisible();

  await section(page)
    .getByRole("combobox", { name: "Project" })
    .selectOption({ label: "Fabrikam Fiber" });
  await section(page).getByRole("button", { name: "Use this project" }).click();
  await expect(section(page).locator("[data-connector-site-name]")).toHaveText(
    "Project: Fabrikam Fiber",
  );
  await importSaved(page);
  await expect(section(page).locator("[data-connector-report]")).toHaveText("3 items added.");
  await expect(page.locator("[data-queue-item]")).toHaveCount(3);
  await expect(page.locator("[data-queue-title]").first()).toHaveText("The login page");
  await closeSheet(page);

  await estimateNext(page, "Start voting", "5");
  await expect(page.locator("[data-write-line=written]")).toHaveText("#1: 5 is in Azure DevOps.");
  expect((await fakeState()).writes).toEqual([
    {
      organization: "fabrikam",
      item: "1",
      contentType: "application/json-patch+json",
      token: TOKEN,
      body: [{ op: "add", path: `/fields/${STORY_POINTS}`, value: 5 }],
    },
  ]);
  expect(frames.join("")).not.toContain(TOKEN);
  // The token left this page once, in the body of one request to this server.
  const carrying = sent.filter((request) => request.includes(TOKEN));
  expect(carrying).toHaveLength(1);
  expect(carrying[0]).toContain(`${SIGN_IN_BASE}/api/connectors/azure-devops/connect `);
  expect(await page.content()).not.toContain(TOKEN);
  await context.close();
});

test("says what is wrong with a token by its code, and clears the field each time", async ({
  browser,
}) => {
  await control({
    tokens: {
      "e2e-other-organisation": { organizations: ["contoso"], scopes: ["vso.work_write"] },
      "e2e-code-only": { organizations: ["fabrikam"], scopes: ["vso.code"] },
    },
  });
  const { context, page } = await newPerson(browser);
  await atStandIn(context);
  await poInRoom(page);
  await page.locator("[data-queue-open]").click();
  for (const [organization, token, signIn, code, words] of [
    ["fabrikam", "e2e-no-such-token", "203", "connector_bad_token", "did not take this token"],
    ["fabrikam", "e2e-no-such-token", "302", "connector_bad_token", "did not take this token"],
    ["fabrikam", "e2e-other-organisation", "203", "connector_no_access", "cannot reach"],
    ["fabrikam", "e2e-code-only", "203", "connector_scope", "Work Items, Read & write"],
    ["no-such-org", TOKEN, "203", "connector_no_organization", "no organisation of that name"],
    ["evil.example", TOKEN, "203", "connector_bad_organization", "no organisation’s name"],
  ] as const) {
    await control({ signIn });
    await fillToken(page, organization, token);
    await expect(problem(page, code)).toContainText(words);
    if (code !== "connector_bad_organization") await expect(patField(page)).toHaveValue("");
  }
  expect((await fakeState()).calls).not.toContain("GET /_signin");
  await context.close();
});

test("a write that fails keeps the round, shows beside it and can be tried again", async ({
  browser,
}) => {
  const { context, page } = await newPerson(browser);
  await atStandIn(context);
  await poInRoom(page);
  await connected(page);
  await importSaved(page);
  await expect(page.locator("[data-queue-item]")).toHaveCount(3);
  await closeSheet(page);
  await control({
    fail: [{ match: "/_apis/wit/workitems/1", method: "PATCH", status: 429, retryAfter: "9" }],
  });
  await estimateNext(page, "Start voting", "5");
  const line = page.locator("[data-write-line=failed]");
  await expect(line).toContainText("#1: 5 did not reach Azure DevOps.");
  await expect(line).toContainText("Try again in 9 s.");
  await page.locator("[data-write-retry]").click();
  await expect(page.locator("[data-write-line=written]")).toBeVisible();
  await context.close();
});

test("an item with no estimate field says so, with nothing to retry, and the room goes on", async ({
  browser,
}) => {
  await control({ items: [ITEMS[2], ITEMS[0]], saved: { [QUERY_SHARED]: { ids: [3, 1] } } });
  const { context, page } = await newPerson(browser);
  await atStandIn(context);
  await poInRoom(page);
  await connected(page);
  await importSaved(page);
  await expect(page.locator("[data-queue-item]")).toHaveCount(2);
  await closeSheet(page);
  await estimateNext(page, "Start voting", "5");
  const line = page.locator("[data-write-line=kept]");
  await expect(line).toContainText("This item has no estimate field");
  await expect(page.locator("[data-write-retry]")).toHaveCount(0);
  expect((await fakeState()).writes).toEqual([]);
  await context.close();
});

test("a final found on coming back waits for a press, and the press writes it", async ({
  browser,
}) => {
  const { context, page } = await newPerson(browser);
  await atStandIn(context);
  await poInRoom(page);
  await connected(page);
  await importSaved(page);
  await expect(page.locator("[data-queue-item]")).toHaveCount(3);
  await closeSheet(page);
  await control({ fail: [{ match: "/_apis/wit/workitems/1", status: 503, times: 1 }] });
  await estimateNext(page, "Start voting", "5");
  await expect(page.locator("[data-write-line=failed]")).toBeVisible();
  await page.reload();
  const waiting = page.locator("[data-write-line=waiting]");
  await expect(waiting).toContainText("was not recorded on this page");
  expect((await fakeState()).writes).toEqual([]);
  await page.locator("[data-write-now]").click();
  await expect(page.locator("[data-write-line=written]")).toBeVisible();
  await context.close();
});

test("a person chooses a field from a type's own, and goes back to the type's", async ({
  browser,
}) => {
  await control({
    projects: [CUSTOM],
    items: [{ id: 1, title: "Own story", type: "Story", project: CUSTOM.id }],
    saved: { [QUERY_SHARED]: { ids: [1] } },
  });
  const { context, page } = await newPerson(browser);
  await atStandIn(context);
  await poInRoom(page);
  await connected(page);
  await expect(section(page).locator("[data-connector-field-name]")).toContainText(
    "the field each item’s type carries",
  );
  await section(page).getByRole("button", { name: "Choose a field" }).click();
  await section(page).getByRole("combobox", { name: "Work item type" }).selectOption("Story");
  const field = section(page).getByRole("combobox", { name: "Estimates go to" });
  await expect(field).toHaveValue(STORY_POINTS);
  await field.selectOption({ label: "Points" });
  await section(page).getByRole("button", { name: "Save the field" }).click();
  await expect(section(page).locator("[data-connector-field-name]")).toHaveText(
    "Estimates go to Points",
  );
  await importSaved2(page);
  await closeSheet(page);
  await estimateNext(page, "Start voting", "8");
  await expect(page.locator("[data-write-line=written]")).toBeVisible();
  expect((await fakeState()).writes.at(-1)?.body).toEqual([
    { op: "add", path: "/fields/Custom.Points", value: 8 },
  ]);
  await page.locator("[data-queue-open]").click();
  await section(page).getByRole("button", { name: "Use each type’s own field" }).click();
  await expect(section(page).locator("[data-connector-field-name]")).toContainText(
    "the field each item’s type carries",
  );
  await context.close();
});

async function importSaved2(page: Page) {
  await importSaved(page);
  await expect(section(page).locator("[data-connector-report]")).toContainText("added");
}

test("a WIQL query the tracker refuses keeps the box and says so; a token found dead asks again", async ({
  browser,
}) => {
  const { context, page } = await newPerson(browser);
  await atStandIn(context);
  await poInRoom(page);
  await connected(page);
  await section(page).getByRole("radio", { name: "A WIQL query" }).check();
  const box = section(page).getByRole("textbox", { name: "WIQL query" });
  await box.fill("bad wiql");
  await section(page).locator("[data-connector-run]").click();
  await expect(problem(page, "connector_bad_query")).toContainText("could not run this query");
  await expect(box).toHaveValue("bad wiql");
  await control({
    fail: [{ match: "/wiql", status: 203, text: "<html>", contentType: "text/html" }],
  });
  await box.fill("Select [System.Id] From WorkItems");
  await section(page).locator("[data-connector-run]").click();
  await expect(problem(page, "connector_reconnect")).toBeVisible();
  await expect(patField(page)).toBeVisible();
  await context.close();
});

test("disconnecting goes back to the form and says where to revoke the token", async ({
  browser,
}) => {
  const { context, page } = await newPerson(browser);
  await atStandIn(context);
  await poInRoom(page);
  await connected(page);
  await expect(
    section(page).getByRole("link", { name: "revoke it in Azure DevOps" }),
  ).toHaveAttribute("href", "https://dev.azure.com/fabrikam/_usersSettings/tokens");
  await section(page).getByRole("button", { name: "Disconnect" }).click();
  await expect(patField(page)).toBeVisible();
  await expect(patField(page)).toHaveValue("");
  await context.close();
});

test("a chunk that cannot load leaves the room working, and says so", async ({ browser }) => {
  const { context, page } = await newPerson(browser);
  await atStandIn(context);
  await poInRoom(page);
  await page.route(/azure-section-[^/]*\.js$/, (route) => route.abort());
  await page.locator("[data-queue-open]").click();
  await expect(
    page.getByText("The Azure DevOps part of this page could not be loaded."),
  ).toBeVisible();
  await expect(section(page)).toHaveCount(0);
  await expect(page.locator("[data-panel-title]")).toBeVisible();
  await context.close();
});

test("a guest PO is asked to sign in, and sees no field for a token", async ({ browser }) => {
  const { context, page } = await newPerson(browser);
  await page.goto(SIGN_IN_BASE);
  await page.getByRole("button", { name: "Create the room" }).click();
  await expect(page).toHaveURL(ROOM_PATH);
  await page.getByRole("textbox", { name: "Your name" }).fill("Gus");
  await page.getByRole("button", { name: "Join the room" }).click();
  await page.locator("[data-queue-open]").click();
  await expect(section(page).locator("[data-connector-sign-in]")).toHaveText(
    "Sign in with an account to connect Azure DevOps.",
  );
  await expect(patField(page)).toHaveCount(0);
  await context.close();
});

test("without the vault nothing of it shows", async ({ page }) => {
  // The first server of the run has neither the vault nor a provider.
  await page.goto("/");
  await page.getByRole("button", { name: "Create the room" }).click();
  await expect(page).toHaveURL(ROOM_PATH);
  await page.getByRole("textbox", { name: "Your name" }).fill("Gus");
  await page.getByRole("button", { name: "Join the room" }).click();
  await page.locator("[data-queue-open]").click();
  await expect(page.locator("[data-panel-title]")).toBeVisible();
  await expect(section(page)).toHaveCount(0);
  const answer = await page.request.get("/api/connectors/azure-devops");
  expect(answer.status()).toBe(404);
});

async function audit(page: Page) {
  await settle(page);
  const { violations } = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
  expect(violations.map(({ id }) => id)).toEqual([]);
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
}

test("axe finds nothing at 320 px, as a guest", async ({ browser }) => {
  const { context, page } = await newPerson(browser);
  await page.setViewportSize({ width: 320, height: 800 });
  await page.goto(SIGN_IN_BASE);
  await page.getByRole("button", { name: "Create the room" }).click();
  await expect(page).toHaveURL(ROOM_PATH);
  await page.getByRole("textbox", { name: "Your name" }).fill("Gus");
  await page.getByRole("button", { name: "Join the room" }).click();
  await page.locator("[data-queue-open]").click();
  await expect(section(page).locator("[data-connector-sign-in]")).toBeVisible();
  await audit(page);
  await context.close();
});

test("axe finds nothing at 320 px, in every state of the section", async ({ browser }) => {
  await control({ projects: [FIBER, CUSTOM] });
  const { context, page } = await newPerson(browser);
  await atStandIn(context);
  await page.setViewportSize({ width: 320, height: 800 });
  await poInRoom(page);
  await page.locator("[data-queue-open]").click();
  await expect(patField(page)).toBeVisible();
  await audit(page);
  await control({ signIn: "203" });
  await fillToken(page, "fabrikam", "e2e-no-such-token");
  await expect(problem(page, "connector_bad_token")).toBeVisible();
  await audit(page);
  await fillToken(page, "fabrikam", TOKEN);
  await expect(section(page).getByRole("combobox", { name: "Project" })).toBeVisible();
  await audit(page);
  await section(page).getByRole("button", { name: "Use this project" }).click();
  await expect(section(page).getByRole("combobox", { name: "Saved query" })).toBeVisible();
  await audit(page);
  await section(page).getByRole("button", { name: "Choose a field" }).click();
  await expect(section(page).getByRole("combobox", { name: "Estimates go to" })).toBeVisible();
  await audit(page);
  await section(page).getByRole("button", { name: "Cancel" }).click();
  await section(page).getByRole("radio", { name: "A WIQL query" }).check();
  await expect(section(page).getByRole("textbox", { name: "WIQL query" })).toBeVisible();
  await audit(page);
  await section(page).getByRole("radio", { name: "A saved query" }).check();
  await section(page).getByRole("button", { name: "Choose a field" }).click();
  await expect(section(page).getByRole("combobox", { name: "Estimates go to" })).toBeVisible();
  await section(page).getByRole("button", { name: "Save the field" }).click();
  await expect(section(page).locator("[data-connector-field-reset]")).toBeVisible();
  await audit(page);
  await section(page).locator("[data-connector-field-reset]").click();
  await importSaved(page);
  await expect(section(page).locator("[data-connector-report]")).toHaveText("3 items added.");
  await audit(page);
  await closeSheet(page);
  await control({ fail: [{ match: "/_apis/wit/workitems/1", method: "PATCH", status: 500 }] });
  await estimateNext(page, "Start voting", "5");
  await expect(page.locator("[data-write-line=failed]")).toBeVisible();
  await audit(page);
  await page.locator("[data-write-retry]").click();
  await expect(page.locator("[data-write-line=written]")).toBeVisible();
  await audit(page);
  await context.close();
});
