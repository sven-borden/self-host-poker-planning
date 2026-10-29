import { createRouter, type RouterHistory } from "@tanstack/react-router";
import { ErrorPage } from "./components/shell/error-page.tsx";
import { reportError } from "./observability/errors.ts";
import { routeTree } from "./routeTree.gen.ts";

export function createAppRouter(history?: RouterHistory) {
  return createRouter({
    routeTree,
    ...(history ? { history } : {}),
    defaultPreload: "intent",
    // A page that throws, or whose chunk cannot load, shows the calm error page (#24), and
    // the error goes to Sentry when its reports are on (#40).
    defaultErrorComponent: ErrorPage,
    defaultOnCatch: reportError,
    scrollRestoration: true,
  });
}

export type AppRouter = ReturnType<typeof createAppRouter>;

declare module "@tanstack/react-router" {
  interface Register {
    router: AppRouter;
  }
}
