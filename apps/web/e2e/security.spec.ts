import { expect, test } from "./fixtures.ts";

// The production headers (#36) on what the server sends, and proof that the strict policy
// leaves what the app needs working: React's style props, the Web Animations API, Radix's
// scroll lock (a constructed style sheet, src/csp/) and sonner's sheet (bundled CSS). The
// guard in fixtures.ts fails every other spec on a violation; the last test here breaks
// the policy on purpose, to show that it is enforced and that the guard sees it.

const PATHS = [
  "/",
  "/r/Unknown123",
  "/dev/table",
  "/theme-init.js",
  "/favicon.svg",
  "/api/health",
  "/api/nope",
  "/api/rooms/Unknown123",
  "/assets/missing-00000000.js",
];

test("every kind of answer carries the security headers", async ({ request }) => {
  for (const path of PATHS) {
    const headers = (await request.get(path)).headers();
    const csp = headers["content-security-policy"] ?? "";
    expect(csp, path).toContain("default-src 'self'; script-src 'self'; style-src 'self';");
    expect(csp, path).toContain("frame-ancestors 'none'");
    expect(csp, path).not.toMatch(/unsafe-inline|unsafe-eval|\*/);
    expect(headers["x-content-type-options"], path).toBe("nosniff");
    expect(headers["x-frame-options"], path).toBe("DENY");
    expect(headers["referrer-policy"], path).toBe("same-origin");
    expect(headers["permissions-policy"], path).toContain("camera=()");
    expect(headers["cross-origin-opener-policy"], path).toBe("same-origin");
    expect(headers["cross-origin-resource-policy"], path).toBe("same-origin");
    // BASE_URL is http here: no HSTS, no upgrade.
    expect(headers["strict-transport-security"], path).toBeUndefined();
    expect(csp, path).not.toContain("upgrade-insecure-requests");
  }
});

test("React style props and the Web Animations API work under the policy", async ({ page }) => {
  await page.goto("/dev/table?n=8&state=revealed");
  await expect(page.getByRole("main")).toBeVisible();
  // Sizes set through React's style prop (avatars, cards) reach the layout.
  const sized = await page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>("[style]")]
      .filter((element) => /^\d+px$/.test(element.style.width))
      .map((element) => [element.style.width, getComputedStyle(element).width]),
  );
  expect(sized.length).toBeGreaterThan(0);
  for (const [set, computed] of sized) expect(computed).toBe(set);
  const animation = await page.evaluate(async () => {
    const running = document.body.animate([{ opacity: 1 }, { opacity: 0.5 }], { duration: 50 });
    await running.finished;
    return running.playState;
  });
  expect(animation).toBe("finished");
});

test("Radix's scroll lock and sonner's sheet load without a style element", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Language: English" }).click();
  await expect(page.getByRole("menu")).toBeVisible();
  // react-remove-scroll locks the page behind the menu through its constructed sheet.
  await expect
    .poll(() => page.evaluate(() => getComputedStyle(document.body).overflow))
    .toBe("hidden");
  expect(await page.evaluate(() => document.adoptedStyleSheets.length)).toBeGreaterThan(0);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu")).toBeHidden();
  await expect
    .poll(() => page.evaluate(() => getComputedStyle(document.body).overflow))
    .not.toBe("hidden");
  // sonner's rules come from a bundled style sheet of this origin.
  await expect
    .poll(() =>
      page.evaluate(() =>
        [...document.styleSheets].some(
          (sheet) =>
            sheet.href?.startsWith(location.origin) &&
            [...sheet.cssRules].some((rule) => rule.cssText.includes("data-sonner-toaster")),
        ),
      ),
    )
    .toBe(true);
  expect(await page.locator("style").count()).toBe(0);
});

test("the guard fails a test whose page reads the clipboard", async ({ page }) => {
  // Expected to fail: the guard throws after the test, on the Permissions-Policy violation.
  test.fail();
  await page.goto("/");
  await expect(page.getByRole("main")).toBeVisible();
  await page.evaluate(() => navigator.clipboard.readText().catch(() => undefined));
  await page.waitForTimeout(300);
});

test.describe("a page that breaks the policy", () => {
  test.use({ policyViolationsExpected: true });

  test("cannot run an inline script or apply an inline style element", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("main")).toBeVisible();
    const outcome = await page.evaluate(async () => {
      const seen: string[] = [];
      document.addEventListener("securitypolicyviolation", (event) => {
        seen.push(event.effectiveDirective);
      });
      const script = document.createElement("script");
      script.textContent = "window.ppInlineRan = true;";
      document.head.append(script);
      const style = document.createElement("style");
      style.textContent = "body { outline: 7px solid red; }";
      document.head.append(style);
      await new Promise((resolve) => setTimeout(resolve, 100));
      return {
        ran: (window as { ppInlineRan?: boolean }).ppInlineRan === true,
        outline: getComputedStyle(document.body).outlineWidth,
        seen,
      };
    });
    expect(outcome.ran).toBe(false);
    expect(outcome.outline).not.toBe("7px");
    expect(outcome.seen).toEqual(expect.arrayContaining(["script-src-elem", "style-src-elem"]));
  });

  test("cannot read the clipboard, and the guard sees it", async ({ page, policyProblems }) => {
    await page.goto("/");
    await expect(page.getByRole("main")).toBeVisible();
    // `clipboard-read=()`: refused by the policy, whatever the browser's permission.
    const outcome = await page.evaluate(() =>
      navigator.clipboard.readText().then(
        () => "read",
        (error: Error) => error.name,
      ),
    );
    expect(outcome).toBe("NotAllowedError");
    // The browser's own console line and the Reporting API's report, through the guard.
    await expect
      .poll(() => policyProblems.filter((line) => /permissions[- ]policy/i.test(line)).length)
      .toBeGreaterThanOrEqual(1);
    await expect
      .poll(() =>
        policyProblems.some((line) =>
          line.includes("Permissions-Policy violation: clipboard-read"),
        ),
      )
      .toBe(true);
  });
});
