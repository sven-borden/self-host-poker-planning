import { RouterProvider } from "@tanstack/react-router";
import { TooltipProvider } from "./components/ui/tooltip.tsx";
import { AppMotionConfig } from "./motion/motion.tsx";
import type { AppRouter } from "./router.ts";

/**
 * Providers shared by every page; the router renders the pages inside them. The language
 * lives in a module store (src/i18n/i18n.ts), which `useT` reads without a provider.
 */
export function App({ router }: { router: AppRouter }) {
  return (
    <AppMotionConfig>
      <TooltipProvider>
        <RouterProvider router={router} />
      </TooltipProvider>
    </AppMotionConfig>
  );
}
