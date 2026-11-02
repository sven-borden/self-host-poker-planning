/**
 * The e2e run's server with Jira on (`apps/web/playwright.config.ts`): loaded by hand with
 * `tsx --import` before `main.ts`, it starts the stand-in in that process and sends the process's
 * `fetch` there. Not imported by `main.ts`, so never bundled and not in the image.
 */
import { routeAtlassianTo, startFakeJira } from "./fake-jira.ts";

const fake = await startFakeJira(Number(process.env.FAKE_JIRA_PORT));
routeAtlassianTo(fake.origin);
