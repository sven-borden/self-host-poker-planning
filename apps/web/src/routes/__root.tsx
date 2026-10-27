import { createRootRoute, Link, Outlet } from "@tanstack/react-router";
import { lazy, Suspense, useEffect } from "react";
import { BrandMark } from "../components/shell/brand-mark.tsx";
import { LanguageSwitcher } from "../components/shell/language-switcher.tsx";
import { ThemeToggle } from "../components/shell/theme-toggle.tsx";
import { buttonVariants } from "../components/ui/button.tsx";
import { errorMessage } from "../i18n/errors.ts";
import { useT } from "../i18n/hooks.ts";
import { COOKIES_BLOCKED, UNAUTHENTICATED } from "../identity/identity.ts";
import { useIdentityStore } from "../stores/identity-store.ts";

// The toaster (sonner) loads after first render: no toast can come before the room has
// connected, and it keeps about 10 kB gzipped out of the initial JavaScript.
const Toaster = lazy(() =>
  import("../components/ui/sonner.tsx").then((module) => ({ default: module.Toaster })),
);

export const Route = createRootRoute({
  component: RootLayout,
  notFoundComponent: NotFound,
});

function RootLayout() {
  const t = useT();
  return (
    <>
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:rounded-md focus:bg-surface focus:px-4 focus:py-2 focus:text-ink"
      >
        {t("app.skipToContent")}
      </a>
      <header className="border-b border-line bg-surface">
        <div className="mx-auto flex max-w-5xl items-center justify-between gap-4 px-4 py-2">
          <Link
            to="/"
            className="flex min-h-11 items-center gap-2.5 rounded-md font-display text-base font-[760] [font-stretch:110%]"
          >
            <BrandMark />
            {t("app.name")}
          </Link>
          <div className="flex items-center gap-1">
            <LanguageSwitcher />
            <ThemeToggle />
          </div>
        </div>
      </header>
      <main id="main" tabIndex={-1} className="mx-auto max-w-5xl px-4 py-12 outline-none sm:py-20">
        <Outlet />
      </main>
      <Suspense fallback={null}>
        <Toaster />
      </Suspense>
      <IdentityToasts />
    </>
  );
}

/**
 * What the identity bootstrap has to say, in the reader's language:
 * - while it retries a temporary failure (a redeploy), a quiet note that stays until it
 *   passes;
 * - when the browser refuses the session cookie, that the site needs cookies;
 * - when the socket was refused twice in a row for want of a session, the bootstrap in
 *   between included (`connectWhenIdentified`), that the session ended.
 */
function IdentityToasts() {
  const t = useT();
  const status = useIdentityStore((state) => state.status);
  const error = useIdentityStore((state) => state.error);
  useEffect(() => {
    // The toaster is a lazy chunk, so the toasts are too.
    void import("sonner").then(({ toast }) => {
      if (status === "retrying") {
        toast(t("identity.reconnecting"), { id: "identity-retrying", duration: Infinity });
        return;
      }
      toast.dismiss("identity-retrying");
      if (status !== "error") return;
      if (error === COOKIES_BLOCKED) {
        toast.error(t("identity.cookiesBlocked"), { id: "cookies-blocked", duration: Infinity });
      } else if (error === UNAUTHENTICATED) {
        toast.error(errorMessage(t, error), { id: "session-lost" });
      }
    });
  }, [status, error, t]);
  return null;
}

function NotFound() {
  const t = useT();
  return (
    <section className="max-w-2xl">
      <h1 className="text-3xl font-[760] [font-stretch:110%]">{t("notFound.title")}</h1>
      <p className="mt-4 text-ink-2">{t("notFound.body")}</p>
      <Link to="/" className={buttonVariants({ variant: "outline", className: "mt-8" })}>
        {t("room.backHome")}
      </Link>
    </section>
  );
}
