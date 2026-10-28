import { type BrowserContext, test as base, type Page } from "@playwright/test";

// Every spec imports `test` from here (#36): it fails a test when any page it opened, in
// the default context or in one the test made itself, broke the Content Security Policy
// or the Permissions-Policy, or threw an uncaught error. The server serves the built app
// with its production headers (playwright.config.ts), so a policy that breaks the page
// fails here, not on poker.borden.ch.

export * from "@playwright/test";

/** The prefixes of the console lines the init script writes for a violation. */
const CSP_VIOLATION = "pp: CSP violation";
const PERMISSIONS_VIOLATION = "pp: Permissions-Policy violation";

/**
 * Console lines that tell of a broken policy: the init script's, and the browser's own
 * ("Refused to …" for the CSP; "[Violation] Permissions policy violation: …" in Chromium,
 * spelt "Permissions-Policy" elsewhere).
 */
const POLICY_PROBLEM = new RegExp(
  [CSP_VIOLATION, "Content Security Policy", "permissions[- ]policy", "Refused to "].join("|"),
  "i",
);

export interface SecurityGuardOptions {
  /**
   * True for a test that breaks the policy on purpose and checks the violation itself
   * (e2e/security.spec.ts): the guard still records, in `policyProblems`, but does not
   * fail the test.
   */
  policyViolationsExpected: boolean;
}

export const test = base.extend<SecurityGuardOptions & { policyProblems: string[] }>({
  policyViolationsExpected: [false, { option: true }],
  /** What the guard saw so far: a test that expects a violation reads it here. */
  policyProblems: [
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
        // Playwright's init scripts run outside the page's policy. A Permissions-Policy
        // violation fires no event: the Reporting API hands it over, in Chromium.
        await watched.addInitScript(
          ([csp, permissions]) => {
            document.addEventListener("securitypolicyviolation", (event) => {
              console.error(
                `${csp}: ${event.effectiveDirective} blocked ${event.blockedURI || "inline"} at ${event.sourceFile}:${event.lineNumber}`,
              );
            });
            if (!("ReportingObserver" in window)) return;
            new ReportingObserver(
              (reports) => {
                for (const report of reports) {
                  const body = (report.body ?? {}) as {
                    featureId?: string;
                    sourceFile?: string;
                    lineNumber?: number;
                  };
                  console.error(
                    `${permissions}: ${body.featureId} at ${body.sourceFile}:${body.lineNumber}`,
                  );
                }
              },
              { types: ["permissions-policy-violation"], buffered: true },
            ).observe();
          },
          [CSP_VIOLATION, PERMISSIONS_VIOLATION] as const,
        );
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
        await use(problems);
      } finally {
        Reflect.deleteProperty(browser, "newContext");
      }
      if (problems.length > 0 && !policyViolationsExpected) {
        throw new Error(`The page broke a policy or threw:\n${problems.join("\n")}`);
      }
    },
    { auto: true },
  ],
});
