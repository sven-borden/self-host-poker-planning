import { type BrowserContext, test as base, type Page } from "@playwright/test";

// Every spec imports `test` from here (#36): it fails a test when any page it opened, in
// the default context or in one the test made itself, broke the Content Security Policy
// or the Permissions-Policy, or threw an uncaught error. The server serves the built app
// with its production headers (playwright.config.ts), so a policy that breaks the page
// fails here, not on poker.borden.ch.

export * from "@playwright/test";

/** The prefix of the console line a `securitypolicyviolation` event writes. */
const VIOLATION = "pp: CSP violation";

/** Console lines that tell of a broken policy: the browser's own, and the event's. */
const POLICY_PROBLEM = new RegExp(
  [VIOLATION, "Content Security Policy", "Permissions-Policy", "Refused to "].join("|"),
);

export interface SecurityGuardOptions {
  /**
   * True for a test that breaks the policy on purpose and checks the violation itself
   * (e2e/security.spec.ts): the guard then records nothing.
   */
  policyViolationsExpected: boolean;
}

export const test = base.extend<SecurityGuardOptions & { securityGuard: undefined }>({
  policyViolationsExpected: [false, { option: true }],
  securityGuard: [
    async ({ browser, context, policyViolationsExpected }, use) => {
      const problems: string[] = [];
      const watchPage = (page: Page) => {
        page.on("console", (message) => {
          const text = message.text();
          if (POLICY_PROBLEM.test(text)) problems.push(`${page.url()}: ${text}`);
        });
        page.on("pageerror", (error) => problems.push(`${page.url()}: uncaught ${error}`));
      };
      const watch = async (watched: BrowserContext) => {
        if (policyViolationsExpected) return;
        // Playwright's init scripts run outside the page's policy.
        await watched.addInitScript((prefix) => {
          document.addEventListener("securitypolicyviolation", (event) => {
            console.error(
              `${prefix}: ${event.effectiveDirective} blocked ${event.blockedURI || "inline"} at ${event.sourceFile}:${event.lineNumber}`,
            );
          });
        }, VIOLATION);
        for (const page of watched.pages()) watchPage(page);
        watched.on("page", watchPage);
      };
      await watch(context);
      // The contexts a test makes itself (several people in one test): `newPage` makes
      // its context through `newContext` too.
      const newContext = browser.newContext.bind(browser);
      browser.newContext = async (options) => {
        const made = await newContext(options);
        await watch(made);
        return made;
      };
      try {
        await use(undefined);
      } finally {
        Reflect.deleteProperty(browser, "newContext");
      }
      if (problems.length > 0) {
        throw new Error(`The page broke a policy or threw:\n${problems.join("\n")}`);
      }
    },
    { auto: true },
  ],
});
