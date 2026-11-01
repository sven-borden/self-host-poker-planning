import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { extname, join as joinPath } from "node:path";
import { fileURLToPath } from "node:url";
import { AxeBuilder } from "@axe-core/playwright";
import { WCAG_TAGS } from "./a11y.ts";
import { chromium, expect, type Page, test } from "./fixtures.ts";
import { OBSERVED_BASE } from "./observed.ts";
import { createRoom, guestsJoin, handCard, join, newPerson, ownAddress } from "./support.ts";

// The installable app (#46, ADR-022) in a real browser, under the production headers: the
// browser's own word on installing it, and the service worker with the rules that matter
// most, that it never stores a room and never holds an old app in place. Every other spec
// runs without a worker (playwright.config.ts). A context's workers and caches end with it.

test.use({ serviceWorkers: "allow" });

/** The worker is active, and has control of a page loaded from now on. */
const workerActive = (page: Page) =>
  page.evaluate(async () => {
    const registration = await navigator.serviceWorker.ready;
    return registration.scope;
  });

/** Every entry of Cache Storage: its cache, its key, the answer's URL and its text. */
const stored = (page: Page) =>
  page.evaluate(async () => {
    const entries: { cache: string; key: string; url: string; type: string; body: string }[] = [];
    for (const name of await caches.keys()) {
      const cache = await caches.open(name);
      for (const request of await cache.keys()) {
        const response = await cache.match(request);
        if (!response) continue;
        const type = response.headers.get("content-type") ?? "";
        entries.push({
          cache: name,
          key: request.url,
          url: response.url,
          type,
          body: /html|css|javascript/.test(type) ? await response.clone().text() : "",
        });
      }
    }
    return entries;
  });

/** The app has loaded under the worker's control. */
async function controlled(page: Page) {
  await workerActive(page);
  await page.reload();
  await expect
    .poll(() => page.evaluate(() => navigator.serviceWorker.controller !== null))
    .toBe(true);
}

test("the browser finds nothing against installing it", async ({ baseURL }) => {
  // A private window is never installable, and Playwright's contexts are private: this needs
  // a real profile. Lighthouse dropped its installability audit in version 12 (ADR-022).
  const profile = mkdtempSync(joinPath(tmpdir(), "pp-install-"));
  const context = await chromium.launchPersistentContext(profile, {
    channel: process.env.CI ? "chromium" : "msedge",
  });
  try {
    const page = context.pages()[0] ?? (await context.newPage());
    await page.goto(baseURL ?? "");
    await workerActive(page);
    const session = await context.newCDPSession(page);
    const { errors, url } = (await session.send("Page.getAppManifest")) as {
      errors: unknown[];
      url: string;
    };
    expect(url).toBe(new URL("/manifest.webmanifest", baseURL).href);
    expect(errors).toEqual([]);
    const installability = () => session.send("Page.getInstallabilityErrors");
    expect((await installability()).installabilityErrors).toEqual([]);
    // The question means something here: a page with no manifest gets a list of reasons.
    await page.goto(new URL("/offline.html", baseURL).href);
    expect((await installability()).installabilityErrors).not.toEqual([]);
  } finally {
    await context.close();
    rmSync(profile, { recursive: true, force: true });
  }
});

test("the manifest, its icons and the worker are served as they should be", async ({ request }) => {
  const manifest = await request.get("/manifest.webmanifest");
  expect(manifest.headers()["content-type"]).toContain("application/manifest+json");
  const { icons } = (await manifest.json()) as { icons: { src: string }[] };
  for (const path of [...icons.map(({ src }) => src), "/icons/apple-touch-icon.png"]) {
    const icon = await request.get(path);
    expect(icon.status(), path).toBe(200);
    expect(icon.headers()["content-type"], path).toBe("image/png");
  }
  const worker = await request.get("/sw.js");
  expect(worker.headers()["content-type"]).toContain("javascript");
  expect(worker.headers()["cache-control"]).toBe("no-cache");
  expect(worker.headers()["content-security-policy"]).toContain("script-src 'self'");
});

test("a room leaves no trace in Cache Storage", async ({ browser, baseURL }) => {
  const { page, context } = await newPerson(browser);
  try {
    const code = await createRoom(page);
    await join(page, "Ana");
    expect(await workerActive(page)).toBe(new URL("/", baseURL).href);
    await page.reload();
    await page.getByRole("button", { name: "Start voting" }).click();
    await handCard(page, "5").click();
    await expect(page.locator("[data-centre-result]")).toContainText("Suggested 5");
    await page.goto(`/r/${code}?again=${code}`);
    await expect(page.locator("[data-centre-result]")).toContainText("Suggested 5");

    const entries = await stored(page);
    const paths = entries.map(({ key }) => new URL(key).pathname);
    expect(paths).toContain("/offline.html");
    expect(paths.filter((path) => path.startsWith("/assets/")).length).toBeGreaterThan(3);
    for (const { cache, key, url, body } of entries) {
      expect(new URL(key).pathname).toMatch(/^\/(offline\.html|assets\/[^/]+)$/);
      expect(new URL(key).search).toBe("");
      expect(`${cache} ${key} ${url} ${body}`).not.toContain(code);
    }
    // Nothing else a page can reach keeps it either: the worker holds no state of its own.
    expect(await page.evaluate(() => caches.keys())).toHaveLength(1);
  } finally {
    await context.close();
  }
});

test("offline, a page says a room needs a connection, and comes back", async ({ browser }) => {
  const { page, context } = await newPerson(browser);
  try {
    const code = await createRoom(page);
    await join(page, "Ana");
    await controlled(page);

    await context.setOffline(true);
    await page.goto(`/r/${code}`);
    await expect(page.getByRole("heading", { name: "You are offline" })).toBeVisible();
    await expect(page.getByText("A room needs a connection")).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`/r/${code}$`));
    // Only one language shows, and no room is pretended.
    await expect(page.getByRole("heading")).toHaveCount(1);
    await expect(page.locator("[data-seat], [data-room-table]")).toHaveCount(0);
    expect(await page.content()).not.toContain(code);

    await page.getByRole("button", { name: "Try again" }).click();
    await expect(page.getByRole("heading", { name: "You are offline" })).toBeVisible();
    for (const colorScheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme });
      const { violations } = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
      expect(violations).toEqual([]);
    }

    await context.setOffline(false);
    await page.getByRole("button", { name: "Try again" }).click();
    await expect(page.getByRole("heading", { name: "You", exact: true })).toBeVisible();
  } finally {
    await context.close();
  }
});

for (const [language, tag, title, retry] of [
  ["a saved language", "de-CH", "Vous êtes hors ligne", "Réessayer"],
  ["the browser's language", "de-CH", "Sie sind offline", "Erneut versuchen"],
] as const) {
  test(`offline, the page speaks ${language}`, async ({ browser }) => {
    const context = await browser.newContext({ locale: tag, extraHTTPHeaders: ownAddress() });
    const page = await context.newPage();
    try {
      await page.goto("/");
      if (language === "a saved language") {
        await page.evaluate(() => {
          localStorage.setItem("pp-language", "fr");
          localStorage.setItem("pp-theme", "dark");
        });
      }
      await controlled(page);
      await context.setOffline(true);
      await page.goto("/r/4mZk8pQr2T");
      await expect(page.getByRole("heading", { name: title })).toBeVisible();
      await expect(page.getByRole("button", { name: retry })).toBeVisible();
      if (language === "a saved language") {
        await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
      }
    } finally {
      await context.close();
    }
  });
}

test("the worker keeps away from the API and the socket", async ({ browser, baseURL }) => {
  const { page, context } = await newPerson(browser);
  try {
    await page.goto("/");
    await controlled(page);
    await context.setOffline(true);
    // A navigation there gets the browser's own failure, not our page.
    const failed = await page.goto(new URL("/api/health", baseURL).href).catch(() => null);
    expect(failed).toBeNull();
  } finally {
    await context.setOffline(false);
    await context.close();
  }
});

test("a deployment's head tags are never stored", async ({ browser }) => {
  const context = await browser.newContext({
    baseURL: OBSERVED_BASE,
    extraHTTPHeaders: ownAddress(),
  });
  const page = await context.newPage();
  await context.route(/^https?:\/\/(?!localhost)/, (route) => route.abort());
  try {
    await page.goto("/");
    await controlled(page);
    const entries = await stored(page);
    const pages = entries.filter(({ type }) => type.includes("html"));
    expect(pages.map(({ key }) => new URL(key).pathname)).toEqual(["/offline.html"]);
    expect(pages[0]?.body).not.toContain('name="pp-');
    // The page itself comes from the server each time, with today's tags.
    await expect(page.locator('meta[name="pp-sentry-dsn"]')).toHaveCount(1);
  } finally {
    await context.close();
  }
});

/**
 * The built app on a port of its own, with no API and no headers, where a test can deploy: a
 * deployment changes the worker's build and the page, as a real one does.
 */
async function deployable() {
  const dist = fileURLToPath(new URL("../dist", import.meta.url));
  const release = { build: "first", tag: "" };
  const server = createServer((request, response) => {
    const path = new URL(request.url ?? "/", "http://localhost").pathname;
    const type = { ".js": "text/javascript", ".css": "text/css", ".html": "text/html" }[
      extname(path)
    ];
    const file = joinPath(dist, path);
    if (path === "/sw.js") {
      const source = readFileSync(file, "utf8");
      response.setHeader("content-type", "text/javascript");
      response.setHeader("cache-control", "no-cache");
      response.end(source.replace(/const BUILD = "[^"]+"/, `const BUILD = "${release.build}"`));
    } else if (extname(path) !== "") {
      if (type) response.setHeader("content-type", type);
      if (existsSync(file)) response.end(readFileSync(file));
      else response.writeHead(404).end();
    } else {
      const html = readFileSync(joinPath(dist, "index.html"), "utf8");
      response.setHeader("content-type", "text/html");
      response.end(html.replace("</head>", `${release.tag}</head>`));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "localhost", resolve));
  const { port } = server.address() as AddressInfo;
  return { server, release, url: `http://localhost:${port}/` };
}

test("a deployment drops the old build's files, leaves an open tab alone and pins nothing", async ({
  browser,
}) => {
  const { server, release, url } = await deployable();
  const { page, context } = await newPerson(browser);
  try {
    await page.goto(url);
    await controlled(page);
    expect(await page.evaluate(() => caches.keys())).toEqual(["pp-shell-first"]);
    await page.evaluate(() => {
      Object.assign(window, { stayed: true });
      navigator.serviceWorker.addEventListener("controllerchange", () => {
        Object.assign(window, { handedOver: true });
      });
    });

    release.build = "second";
    release.tag = '<meta name="deployed" content="second">';
    await page.evaluate(async () => {
      await (await navigator.serviceWorker.ready).update();
    });
    await expect.poll(() => page.evaluate(() => caches.keys())).toEqual(["pp-shell-second"]);
    // The new worker took over without waiting for the tab, which never reloaded.
    expect(await page.evaluate(() => "stayed" in window)).toBe(true);
    await expect.poll(() => page.evaluate(() => "handedOver" in window)).toBe(true);
    await expect(page.locator('meta[name="deployed"]')).toHaveCount(0);

    // Its next navigation is the new deployment's.
    await page.reload();
    await expect(page.locator('meta[name="deployed"]')).toHaveCount(1);
    expect(await page.evaluate(() => "stayed" in window)).toBe(false);
  } finally {
    await context.close();
    server.close();
  }
});

test("a whole round runs under the worker, and only the app's origin hears it", async ({
  browser,
  baseURL,
}) => {
  const { page, context } = await newPerson(browser);
  const addresses: string[] = [];
  context.on("request", (request) => addresses.push(request.url()));
  page.on("websocket", (socket) => addresses.push(socket.url()));
  const code = await createRoom(page);
  await join(page, "Ana");
  await controlled(page);
  const guests = await guestsJoin(baseURL ?? "", code, ["Ben"]);
  try {
    await page.getByRole("button", { name: "Start voting" }).click();
    await handCard(page, "5").click();
    expect(await guests[0]?.cmd("castVote", { card: "5", round: 1, restart: 0 })).toMatchObject({
      ok: true,
    });
    await expect(page.locator("[data-centre-result]")).toContainText("Suggested 5");
    const app = new URL(baseURL ?? "").host;
    const elsewhere = addresses.filter(
      (address) => !/^(data|blob):/.test(address) && new URL(address).host !== app,
    );
    expect(elsewhere).toEqual([]);
  } finally {
    for (const guest of guests) guest.close();
    await context.close();
  }
});
