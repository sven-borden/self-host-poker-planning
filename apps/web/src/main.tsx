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
import { createAppRouter } from "./router.ts";

const container = document.getElementById("root");
if (!container) {
  throw new Error("The page has no #root element.");
}

const router = createAppRouter();

// The first render waits for the language's catalog (French and German are separate
// chunks) and, in parallel, for the route's own chunk, which the router would fetch
// before showing the page anyway. So the page never paints in the wrong language, and a
// French or German start costs no extra round trip. startLanguage never rejects.
void Promise.all([startLanguage(), router.load().catch(() => {})]).then(() => {
  createRoot(container).render(
    <StrictMode>
      <App router={router} />
    </StrictMode>,
  );
});
