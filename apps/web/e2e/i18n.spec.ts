import { fileURLToPath } from "node:url";
import { expect, type Page, test } from "@playwright/test";

// Languages in a real browser (#9): the switcher changes every string without a reload and
// moves <html lang>, the choice survives a reload, a French browser starts in French with
// no English frame first, and numbers use the language's decimal mark.

const SHOTS = fileURLToPath(new URL("../tmp/screenshots/", import.meta.url));

const HOME = {
  en: "Estimate together, around one table",
  fr: "Estimez ensemble, autour d’une même table",
  de: "Gemeinsam schätzen, an einem Tisch",
};

async function pick(page: Page, current: RegExp, target: string) {
  await page.getByRole("button", { name: current }).click();
  await page.getByRole("menuitemradio", { name: target }).click();
}

/** Marks the page, so a later check can tell whether it was reloaded. */
async function mark(page: Page) {
  await page.evaluate(() => {
    (window as unknown as { ppMark: boolean }).ppMark = true;
  });
}

async function marked(page: Page): Promise<boolean> {
  return page.evaluate(() => (window as unknown as { ppMark?: boolean }).ppMark === true);
}

// The French catalog's chunk, which tests delay or break.
const FRENCH_CHUNK = /\/assets\/fr-[\w-]+\.js$/;

test.describe("with an English browser", () => {
  test("switches the home page to French without a reload, and keeps the choice", async ({
    page,
  }) => {
    await page.goto("/");
    const heading = page.getByRole("heading", { level: 1 });
    await expect(heading).toHaveText(HOME.en);
    await expect(page.locator("html")).toHaveAttribute("lang", "en");
    await mark(page);

    await pick(page, /^Language: English$/, "Français");
    await expect(heading).toHaveText(HOME.fr);
    await expect(page.locator("html")).toHaveAttribute("lang", "fr");
    await expect(page.getByRole("button", { name: "Créer la salle" })).toBeVisible();
    await expect(page.getByRole("button", { name: /^Thème/ })).toBeVisible();
    expect(await marked(page)).toBe(true);

    await page.reload();
    await expect(heading).toHaveText(HOME.fr);
    await expect(page.locator("html")).toHaveAttribute("lang", "fr");
    expect(await marked(page)).toBe(false);

    await pick(page, /^Langue/, "English");
    await expect(heading).toHaveText(HOME.en);
    await expect(page.locator("html")).toHaveAttribute("lang", "en");
  });

  test("switches the table bench to German without a reload", async ({ page }) => {
    await page.goto("/dev/table?n=8&state=voting");
    await expect(page.getByText("6/8 voted so far")).toBeVisible();
    await mark(page);

    await pick(page, /^Language: English$/, "Deutsch");
    await expect(page.getByText("6/8 haben bisher abgestimmt")).toBeVisible();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Tischanordnung");
    // The seat list is for screen readers only.
    await expect(page.getByRole("list", { name: "Personen am Tisch" })).toHaveCount(1);
    await expect(page.locator("html")).toHaveAttribute("lang", "de");
    expect(await marked(page)).toBe(true);

    await page.reload();
    await expect(page.getByText("6/8 haben bisher abgestimmt")).toBeVisible();
  });

  test("writes numbers with the language's decimal mark", async ({ page }) => {
    await page.goto("/dev/table?n=2&state=revealed");
    const average = page.locator("[data-average]");
    await expect(average).toHaveText("Average of the numeric cards: 6.5");
    await pick(page, /^Language: English$/, "Français");
    await expect(average).toHaveText("Moyenne des cartes numériques\u202f: 6,5");
    await pick(page, /^Langue/, "Deutsch");
    await expect(average).toHaveText("Durchschnitt der Zahlenkarten: 6,5");
    await page.goto("/dev/table?n=8&state=revealed");
    await expect(average).toHaveText("Durchschnitt der Zahlenkarten: 31,5");
  });

  test("gives the switcher 44 px targets and a visible focus ring", async ({ page }) => {
    for (const width of [360, 1024]) {
      await page.setViewportSize({ width, height: 800 });
      await page.goto("/");
      const trigger = page.getByRole("button", { name: /^Language: English$/ });
      const box = await trigger.boundingBox();
      expect(box?.height, `${width} px`).toBeGreaterThanOrEqual(44);
      expect(box?.width, `${width} px`).toBeGreaterThanOrEqual(44);
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - window.innerWidth,
      );
      expect(overflow, `${width} px`).toBeLessThanOrEqual(0);
      await page.screenshot({
        path: `${SHOTS}header-${width}.png`,
        clip: { x: 0, y: 0, width, height: 240 },
      });
    }
    // Keyboard focus: skip link, brand, then the switcher.
    await page.keyboard.press("Tab");
    await page.keyboard.press("Tab");
    await page.keyboard.press("Tab");
    const trigger = page.getByRole("button", { name: /^Language: English$/ });
    await expect(trigger).toBeFocused();
    const ring = await trigger.evaluate((element) => getComputedStyle(element).boxShadow);
    expect(ring).not.toBe("none");

    await page.keyboard.press("Enter");
    const items = page.getByRole("menuitemradio");
    await expect(items).toHaveText(["English", "Français", "Deutsch"]);
    // Measure once the menu has finished zooming in.
    await page.waitForFunction(() => document.getAnimations().length === 0);
    for (const item of await items.all()) {
      expect((await item.boundingBox())?.height).toBeGreaterThanOrEqual(44);
    }
    await page.screenshot({
      path: `${SHOTS}language-menu.png`,
      clip: { x: 600, y: 0, width: 424, height: 260 },
    });
    // The arrow keys move through the languages; Enter picks one.
    await expect(items.first()).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await expect(page.getByRole("menuitemradio", { name: "Français" })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.locator("html")).toHaveAttribute("lang", "fr");
  });
});

test.describe("with a French browser and no saved choice", () => {
  test.use({ locale: "fr-FR" });

  test("starts in French, with no English frame first", async ({ page }) => {
    // Records every heading text the page ever shows, from the first frame on.
    await page.addInitScript(() => {
      const seen: string[] = [];
      (window as unknown as { ppHeadings: string[] }).ppHeadings = seen;
      new MutationObserver(() => {
        const text = document.querySelector("h1")?.textContent;
        if (text && seen.at(-1) !== text) {
          seen.push(text);
        }
      }).observe(document, { childList: true, subtree: true, characterData: true });
    });
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(HOME.fr);
    await expect(page.locator("html")).toHaveAttribute("lang", "fr");
    const headings = await page.evaluate(
      () => (window as unknown as { ppHeadings: string[] }).ppHeadings,
    );
    expect(headings).toEqual([HOME.fr]);
  });
});

test.describe("with slow or missing catalogs", () => {
  test("keeps the last pick when an earlier catalog arrives late", async ({ page }) => {
    await page.route(FRENCH_CHUNK, async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      await route.continue();
    });
    await page.goto("/");
    const heading = page.getByRole("heading", { level: 1 });
    await expect(heading).toHaveText(HOME.en);
    const frenchLanded = page.waitForEvent("requestfinished", (request) =>
      FRENCH_CHUNK.test(request.url()),
    );
    await pick(page, /^Language: English$/, "Français");
    await pick(page, /^Language: English$/, "Deutsch");
    await expect(heading).toHaveText(HOME.de);
    await frenchLanded;
    // Give the late chunk time to run, then check that nothing moved.
    await page.waitForTimeout(300);
    await expect(heading).toHaveText(HOME.de);
    await expect(page.locator("html")).toHaveAttribute("lang", "de");
    expect(await page.evaluate(() => localStorage.getItem("pp-language"))).toBe("de");
  });

  test("says so when a language cannot be loaded, and stays in its language", async ({ page }) => {
    // After a redeploy, an open tab asks for a chunk the server no longer has.
    await page.route(FRENCH_CHUNK, (route) => route.fulfill({ status: 404, body: "" }));
    await page.goto("/");
    await pick(page, /^Language: English$/, "Français");
    await expect(
      page.getByText("Could not load this language. Reload the page and try again."),
    ).toBeVisible();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(HOME.en);
    await expect(page.locator("html")).toHaveAttribute("lang", "en");
  });
});

test.describe("with a French browser and a hung catalog", () => {
  test.use({ locale: "fr-FR" });

  test("shows English after about 3 s, then French when the catalog lands", async ({ page }) => {
    await page.route(FRENCH_CHUNK, async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 5000));
      await route.continue();
    });
    await page.goto("/");
    const heading = page.getByRole("heading", { level: 1 });
    await expect(heading).toHaveText(HOME.en, { timeout: 4500 });
    await expect(heading).toHaveText(HOME.fr, { timeout: 8000 });
    await expect(page.locator("html")).toHaveAttribute("lang", "fr");
  });
});

test.describe("with a Swiss German browser", () => {
  test.use({ locale: "de-CH" });

  test("speaks German and writes numbers the Swiss way", async ({ page }) => {
    await page.goto("/dev/table?n=2&state=revealed");
    await expect(page.locator("html")).toHaveAttribute("lang", "de");
    await expect(page.locator("[data-average]")).toHaveText("Durchschnitt der Zahlenkarten: 6.5");
  });
});

test.describe("in forced-colours mode", () => {
  test("outlines a button and a menu item only while they have focus", async ({ page }) => {
    await page.emulateMedia({ forcedColors: "active" });
    await page.goto("/");
    const trigger = page.getByRole("button", { name: /^Language: English$/ });
    const outline = (locator: typeof trigger) =>
      locator.evaluate((element) => getComputedStyle(element).outlineStyle);
    const box = await trigger.boundingBox();
    if (!box) {
      throw new Error("The switcher has no box.");
    }
    const clip = { x: box.x - 6, y: box.y - 6, width: box.width + 12, height: box.height + 12 };
    expect(await outline(trigger)).toBe("none");
    expect(await outline(page.getByRole("button", { name: /^Theme/ }))).toBe("none");
    const unfocused = await page.screenshot({ clip });

    // Skip link, brand, then the switcher.
    for (let step = 0; step < 3; step += 1) {
      await page.keyboard.press("Tab");
    }
    await expect(trigger).toBeFocused();
    expect(await outline(trigger)).not.toBe("none");
    const focused = await page.screenshot({ clip, path: `${SHOTS}forced-colours-focus.png` });
    expect(focused.equals(unfocused)).toBe(false);

    await page.keyboard.press("Enter");
    const items = page.getByRole("menuitemradio");
    await expect(items.first()).toBeFocused();
    expect(await outline(items.first())).not.toBe("none");
    expect(await outline(items.nth(1))).toBe("none");
  });
});
