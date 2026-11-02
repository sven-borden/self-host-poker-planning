// The third server of the e2e run (#47): the same app and database with provider keys set, for
// e2e/sign-in.spec.ts. It runs the production code against the providers' own addresses. Only
// its process differs: `apps/server/src/fake-oidc-start.ts`, loaded by hand before `main.ts`,
// starts a stand-in for them on SIGN_IN_FAKE_ORIGIN and sends that process's `fetch` there. The
// spec does the same for the browser with Playwright's routing. Nothing leaves the machine.
// Shared by playwright.config.ts and the spec.

const PORT = Number(process.env.E2E_WEB_PORT ?? 4173);

/** After the first server, the observed one and that one's stand-in address. */
export const SIGN_IN_PORT = PORT + 3;
export const SIGN_IN_BASE = `http://localhost:${SIGN_IN_PORT}`;

const FAKE_PORT = PORT + 4;
export const SIGN_IN_FAKE_ORIGIN = `http://127.0.0.1:${FAKE_PORT}`;

const JIRA_FAKE_PORT = PORT + 5;
/** The stand-in for Atlassian (#54): `apps/server/src/fake-jira-start.ts`, in the same process. */
export const JIRA_FAKE_ORIGIN = `http://127.0.0.1:${JIRA_FAKE_PORT}`;

const AZURE_FAKE_PORT = PORT + 6;
/** The stand-in for Azure DevOps (#55): `apps/server/src/fake-azure-devops-start.ts`, the same way. */
export const AZURE_FAKE_ORIGIN = `http://127.0.0.1:${AZURE_FAKE_PORT}`;

/** Fake keys, and where the stand-ins listen. The Jira keys are `FAKE_JIRA_CLIENT`'s. */
export const SIGN_IN_ENV = {
  GOOGLE_CLIENT_ID: "e2e-google-client",
  GOOGLE_CLIENT_SECRET: "e2e-google-secret",
  MICROSOFT_CLIENT_ID: "e2e-microsoft-client",
  MICROSOFT_CLIENT_SECRET: "e2e-microsoft-secret",
  FAKE_OIDC_PORT: String(FAKE_PORT),
  JIRA_CLIENT_ID: "fake-jira-client",
  JIRA_CLIENT_SECRET: "fake-jira-secret",
  // Not secret, and not used anywhere else: 32 bytes for this run's throwaway rows.
  POKER_VAULT_KEY: "ZTJlLW9ubHktdmF1bHQta2V5LW5vdC1mb3ItdXNlLTA=",
  FAKE_JIRA_PORT: String(JIRA_FAKE_PORT),
  FAKE_AZURE_PORT: String(AZURE_FAKE_PORT),
};
