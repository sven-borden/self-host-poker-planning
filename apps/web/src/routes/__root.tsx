import { createRootRoute, Link, Outlet } from "@tanstack/react-router";
import { BrandMark } from "../components/shell/brand-mark.tsx";
import { ThemeToggle } from "../components/shell/theme-toggle.tsx";
import { buttonVariants } from "../components/ui/button.tsx";
import { Toaster } from "../components/ui/sonner.tsx";
import { useT } from "../i18n/i18n-context.tsx";

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
          <ThemeToggle />
        </div>
      </header>
      <main id="main" tabIndex={-1} className="mx-auto max-w-5xl px-4 py-12 outline-hidden sm:py-20">
        <Outlet />
      </main>
      <Toaster />
    </>
  );
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
