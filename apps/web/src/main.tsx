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
import { detectLanguage } from "./i18n/i18n.ts";
import { createAppRouter } from "./router.ts";

const language = detectLanguage();
document.documentElement.lang = language;

const container = document.getElementById("root");
if (!container) {
  throw new Error("The page has no #root element.");
}

createRoot(container).render(
  <StrictMode>
    <App router={createAppRouter()} language={language} />
  </StrictMode>,
);
