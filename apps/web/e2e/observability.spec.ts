import { expect, type Page, type Route, test } from "./fixtures.ts";
import {
  OBSERVED_BASE,
  RELEASE,
  SENTRY_KEY,
  SENTRY_PROJECT,
  SERVICES_ORIGIN,
  UMAMI_WEBSITE_ID,
} from "./observed.ts";
import { createRoom, handCard, join, ownAddress, ROOM_PATH } from "./support.ts";

// Opt-in observability (#40) in a real browser. With the variables unset (the first
// server), a whole round, the history and the settings send no request outside the app's
// origin (the issue's acceptance criterion). With Sentry and Umami on (the second server,
// e2e/observed.ts), the policy lets their tracker and endpoints through, Umami gets each
// page as its route and Sentry an uncaught error with the route as its request, and
// neither ever sees the room code. The services are answered here, through Playwright's
// routing: nothing leaves the machine. Needs DATABASE_URL.

test.skip(
  !process.env.DATABASE_URL && !process.env.CI,
  "needs DATABASE_URL: runs against the real server",
);
test.beforeEach(async ({ page }) => {
  await page.setExtraHTTPHeaders(ownAddress());
});

/** Every address the page asks for: requests and WebSockets. */
function recordAddresses(page: Page): string[] {
  const addresses: string[] = [];
  page.context().on("request", (request) => addresses.push(request.url()));
  page.on("websocket", (socket) => addresses.push(socket.url()));
  return addresses;
}

/** Joins the room on screen, votes and lets the last vote reveal, then opens both panels. */
async function playRound(page: Page) {
  await join(page, "Ana");
  await page.getByRole("button", { name: "Start voting" }).click();
  await handCard(page, "5").click();
  await expect(page.locator("[data-centre-result]")).toContainText("Suggested 5");
  for (const name of ["History", "Room settings"]) {
    await page.getByRole("button", { name }).click();
    await expect(page.getByRole("dialog", { name })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog", { name })).toHaveCount(0);
  }
}

test("with the variables unset, no request leaves the app's origin", async ({
  page,
  request,
  baseURL,
}) => {
  const html = await (await request.get("/")).text();
  expect(html).not.toContain("pp-sentry-dsn");
  expect(html).not.toContain("data-website-id");
  const addresses = recordAddresses(page);
  await createRoom(page);
  await playRound(page);
  await page.reload();
  await expect(page.locator("[data-centre-result]")).toContainText("Suggested 5");
  const app = new URL(baseURL ?? "").host;
  expect(addresses.length).toBeGreaterThan(10);
  const elsewhere = addresses.filter(
    (address) => !/^(data|blob):/.test(address) && new URL(address).host !== app,
  );
  expect(elsewhere).toEqual([]);
});

/**
 * A stand-in for Umami's tracker with its API: `umami.track(fn)` posts `fn(payload)` to
 * `/api/send` beside the script, as the real one does.
 */
const TRACKER = `(() => {
  const script = document.currentScript;
  const endpoint = script.src.split("/").slice(0, -1).join("/") + "/api/send";
  const website = script.getAttribute("data-website-id");
  window.umami = {
    track: (view) => fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "event", payload: view({
        website, hostname: location.hostname, url: location.href,
        referrer: document.referrer, title: document.title,
      }) }),
    }),
  };
})();`;

interface View {
  type: string;
  payload: { website: string; url: string; referrer: string; title: string };
}

test.describe("with Sentry and Umami on", () => {
  // The test throws an uncaught error on purpose: the guard keeps it in `policyProblems`
  // instead of failing, and the test checks that it is the only problem.
  test.use({ baseURL: OBSERVED_BASE, policyViolationsExpected: true });

  test("they get routes and errors, never a room code", async ({ page, policyProblems }) => {
    const views: View[] = [];
    const envelopes: { url: string; body: string }[] = [];
    const cors = {
      "access-control-allow-origin": "*",
      "access-control-allow-headers": "content-type",
      "access-control-allow-methods": "POST",
    };
    await page.context().route(`${SERVICES_ORIGIN}/**`, (route: Route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (request.method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
      if (url.pathname === "/script.js") {
        return route.fulfill({ contentType: "text/javascript", body: TRACKER, headers: cors });
      }
      if (url.pathname === "/api/send") {
        views.push(JSON.parse(request.postData() ?? "{}") as View);
        return route.fulfill({ json: {}, headers: cors });
      }
      if (url.pathname === `/api/${SENTRY_PROJECT}/envelope/`) {
        envelopes.push({ url: url.href, body: request.postData() ?? "" });
        return route.fulfill({ json: {}, headers: cors });
      }
      return route.fulfill({ status: 404, headers: cors });
    });

    const code = await createRoom(page);
    expect(page.url()).toMatch(ROOM_PATH);
    await playRound(page);
    await expect
      .poll(() => views.map((view) => view.payload.url))
      .toEqual([`${OBSERVED_BASE}/`, `${OBSERVED_BASE}/r/:code`]);
    for (const view of views) {
      expect(view.payload.website).toBe(UMAMI_WEBSITE_ID);
      expect(view.payload.referrer).toBe("");
    }

    // An uncaught error on the room's page, once the Sentry chunk is there.
    await expect.poll(() => page.evaluate(() => "__SENTRY__" in window)).toBe(true);
    await page.evaluate(() => {
      setTimeout(() => {
        throw new Error(`boom in ${window.location.pathname}`);
      });
    });
    await expect.poll(() => envelopes.length).toBeGreaterThan(0);
    const [envelope] = envelopes;
    expect(new URL(envelope?.url ?? "").searchParams.get("sentry_key")).toBe(SENTRY_KEY);
    const event = (envelope?.body ?? "")
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .find((item) => "exception" in item);
    expect(event).toMatchObject({
      release: RELEASE,
      request: { url: `${OBSERVED_BASE}/r/:code` },
      exception: { values: [{ type: "Error", value: "boom in /r/:code" }] },
    });
    expect(event).not.toHaveProperty("breadcrumbs");
    expect(event).not.toHaveProperty("user");

    expect(JSON.stringify(views)).not.toContain(code);
    for (const { url, body } of envelopes) {
      expect(url).not.toContain(code);
      expect(body).not.toContain(code);
    }
    // The policy let everything through: the error thrown on purpose is the only problem.
    expect(policyProblems.filter((problem) => !problem.includes("boom in"))).toEqual([]);
  });
});
