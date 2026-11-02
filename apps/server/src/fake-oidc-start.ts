/**
 * The e2e run's server with sign-in on (`apps/web/playwright.config.ts`): loaded by hand with
 * `tsx --import` before `main.ts`, it starts the fake provider in that process and sends the
 * process's `fetch` there. Not imported by `main.ts`, so never bundled and not in the image.
 */
import { routeProvidersTo, startFakeOidc } from "./fake-oidc.ts";

const fake = await startFakeOidc(Number(process.env.FAKE_OIDC_PORT));
routeProvidersTo(fake.origin);
