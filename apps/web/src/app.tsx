import { RouterProvider } from "@tanstack/react-router";
import { TooltipProvider } from "./components/ui/tooltip.tsx";
import type { Language } from "./i18n/i18n.ts";
import { I18nProvider } from "./i18n/i18n-context.tsx";
import { AppMotionConfig } from "./motion/motion.tsx";
import type { AppRouter } from "./router.ts";

/** Providers shared by every page; the router renders the pages inside them. */
export function App({ router, language }: { router: AppRouter; language: Language }) {
  return (
    <I18nProvider language={language}>
      <AppMotionConfig>
        <TooltipProvider>
          <RouterProvider router={router} />
        </TooltipProvider>
      </AppMotionConfig>
    </I18nProvider>
  );
}
