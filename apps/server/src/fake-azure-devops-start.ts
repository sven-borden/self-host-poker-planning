/**
 * The e2e run's server with a stand-in for Azure DevOps (`apps/web/playwright.config.ts`): loaded by
 * hand with `tsx --import` before `main.ts`, it starts the stand-in in that process and sends the
 * process's `fetch` there. Not imported by `main.ts`, so never bundled and not in the image.
 */
import { routeAzureTo, startFakeAzure } from "./fake-azure-devops.ts";

const fake = await startFakeAzure(Number(process.env.FAKE_AZURE_PORT));
routeAzureTo(fake.origin);
