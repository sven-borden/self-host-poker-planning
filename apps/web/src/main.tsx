import "@fontsource-variable/archivo/wdth.css";
import "@fontsource/ibm-plex-sans/400.css";
import "@fontsource/ibm-plex-sans/500.css";
import "@fontsource/ibm-plex-sans/600.css";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/500.css";
import "./styles.css";

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app.tsx";
import { startLanguage } from "./i18n/i18n.ts";
import { ensureIdentity } from "./identity/identity.ts";
import { startErrorReports } from "./observability/errors.ts";
import { trackPageViews } from "./observability/page-views.ts";
import { createAppRouter } from "./router.ts";

const container = document.getElementById("root");
if (!container) {
  throw new Error("The page has no #root element.");
}

// Sentry and Umami, each only when the server's page asks for it (#40): nothing by default.
startErrorReports();
const router = createAppRouter();
trackPageViews(router);

// The first render waits for the language's catalog (French and German are separate
// chunks) and, in parallel, for the route's own chunk, which the router would fetch
// before showing the page anyway. So the page does not paint in the wrong language, and a
// French or German start costs no extra round trip. startLanguage never rejects and
// settles within 3 s: a hung catalog shows the page in English, and the catalog still
// applies when it lands, unless the reader has picked a language by then.
void Promise.all([startLanguage(), router.load().catch(() => {})]).then(() => {
  createRoot(container).render(
    <StrictMode>
      <App router={router} />
    </StrictMode>,
  );
});

// Every visitor gets an identity: the session cookie's, or a new guest's (#10). It runs
// next to the first render rather than before it; sockets wait for it
// (`connectWhenIdentified`). A temporary failure (a redeploy) is retried with backoff;
// a final one (cookies blocked) is kept in the identity store.
ensureIdentity({ retry: true }).catch(() => {});
