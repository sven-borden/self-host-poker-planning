import { scan } from "./a11y.ts";
import { type BrowserContext, expect, type Page, test, type WebSocketRoute } from "./fixtures.ts";
import { createRoom, join, newPerson, ownAddress } from "./support.ts";

// U5: the PO removes someone whose browser is offline (a network blip, a laptop asleep, a phone
// tab in the background), in real browsers against the real server and Postgres. Back online,
// their page is on the join form under the same notice an online removal shows, announced as an
// alert, with no axe finding; the PO's page hears nothing new. Once they join again, a reload is
// an ordinary one. Once in French. Needs DATABASE_URL; skipped without it locally, failing
// without it in CI.

test.skip(
  !process.env.DATABASE_URL && !process.env.CI,
  "needs DATABASE_URL: runs against the real server",
);
test.beforeAll(() => {
  if (!process.env.DATABASE_URL) {
    throw new Error("CI must run the removal while offline: set DATABASE_URL");
  }
});

const live = (page: Page) => page.locator("[data-table-live]");
const popover = (page: Page) => page.getByRole("dialog");
const personButton = (page: Page, name: string) =>
  page.locator("[data-room-table]").getByRole("button", { name: new RegExp(`^${name}(,|$)`) });
const connection = (page: Page) => page.getByTestId("room-connection");

/**
 * The page's sockets, proxied, so the test can take its network away. Chromium's offline mode
 * blocks new requests but leaves an open WebSocket be, and Socket.IO's client listens for the
 * browser's `offline` event only away from localhost: so `offline` also closes every proxied
 * socket at both ends, as a dropped network would, and refuses new ones until `online`.
 */
async function network(context: BrowserContext, page: Page) {
  const open: { ws: WebSocketRoute; server: WebSocketRoute }[] = [];
  let down = false;
  await page.routeWebSocket(/\/socket\.io\//, (ws: WebSocketRoute) => {
    if (down) {
      void ws.close();
      return;
    }
    const server = ws.connectToServer();
    ws.onMessage((message) => server.send(message));
    server.onMessage((message) => ws.send(message));
    open.push({ ws, server });
  });
  return {
    async offline(connected: string) {
      down = true;
      await context.setOffline(true);
      for (const { ws, server } of open.splice(0)) {
        await server.close();
        await ws.close();
      }
      await expect(connection(page)).not.toHaveText(connected, { timeout: 10_000 });
    },
    async online() {
      down = false;
      await context.setOffline(false);
    },
  };
}

/** The PO removes `name`, by pointer, and sees the seat go. */
async function remove(page: Page, name: string) {
  await personButton(page, name).click();
  await popover(page).getByRole("button", { name: "Remove from the room" }).click();
  await popover(page).getByRole("button", { name: "Remove", exact: true }).click();
  await expect(personButton(page, name)).toHaveCount(0);
}

test("someone removed while offline is told so when back, above the join form", async ({
  page,
  browser,
}) => {
  test.setTimeout(90_000);
  await createRoom(page);
  await join(page, "Ana");
  const ben = await newPerson(browser);
  const benNet = await network(ben.context, ben.page);
  try {
    await ben.page.goto(page.url());
    await join(ben.page, "Ben");
    await expect(personButton(page, "Ben")).toHaveCount(1);

    await benNet.offline("Connected");
    await remove(page, "Ben");
    const said = "The product owner removed Ben from the room.";
    await expect(live(page)).toContainText(said);
    const before = (await live(page).textContent()) ?? "";

    await benNet.online();
    const notice = ben.page.getByRole("alert").filter({
      hasText: "The product owner removed you from this room.",
    });
    await expect(notice).toBeVisible({ timeout: 20_000 });
    await expect(ben.page.getByRole("textbox", { name: "Your name" })).toBeFocused();
    // The notice sits above the join form.
    const noticeBox = await notice.boundingBox();
    const formBox = await ben.page.getByRole("textbox", { name: "Your name" }).boundingBox();
    expect(noticeBox && formBox && noticeBox.y < formBox.y).toBe(true);
    await expect(connection(ben.page)).toHaveText("Connected");
    const { violations } = await scan(ben.page);
    expect(violations.map(({ id }) => id)).toEqual([]);

    // The PO's page heard of the removal once, and nothing of Ben's return.
    expect((await live(page).textContent()) ?? "").toBe(before);
    expect(before.split(said).length - 1).toBe(1);

    // Ben joins again: the notice goes, and a reload says nothing of the old removal.
    await join(ben.page, "Ben");
    await expect(notice).toHaveCount(0);
    await expect(personButton(page, "Ben")).toHaveCount(1);
    await ben.page.reload();
    await expect(ben.page.getByRole("heading", { name: "You", exact: true })).toBeVisible();
    await expect(connection(ben.page)).toHaveText("Connected");
    await expect(ben.page.getByRole("alert")).toHaveCount(0);
  } finally {
    await ben.context.close();
  }
});

test("in French, the notice says so in French", async ({ page, browser }) => {
  test.setTimeout(90_000);
  await createRoom(page);
  await join(page, "Ana");
  const context = await browser.newContext({ locale: "fr-FR", extraHTTPHeaders: ownAddress() });
  const benPage = await context.newPage();
  const benNet = await network(context, benPage);
  try {
    await benPage.goto(page.url());
    await benPage.getByRole("textbox", { name: "Votre nom" }).fill("Ben");
    await benPage.getByRole("radio", { name: /^Votant/ }).check();
    await benPage.getByRole("button", { name: "Rejoindre la salle" }).click();
    await expect(personButton(page, "Ben")).toHaveCount(1);
    await expect(connection(benPage)).toHaveText("Connecté");

    await benNet.offline("Connecté");
    await remove(page, "Ben");
    await benNet.online();

    const notice = benPage.getByRole("alert").filter({
      hasText: "Le product owner vous a retiré de cette salle.",
    });
    await expect(notice).toBeVisible({ timeout: 20_000 });
    await expect(benPage.getByRole("textbox", { name: "Votre nom" })).toBeFocused();
    const { violations } = await scan(benPage);
    expect(violations.map(({ id }) => id)).toEqual([]);
  } finally {
    await context.close();
  }
});
