import type { SignInErrorCode } from "@pp/protocol";
import { createRootRoute, Link, Outlet } from "@tanstack/react-router";
import { lazy, Suspense, useEffect } from "react";
import { BrandMark } from "../components/shell/brand-mark.tsx";
import { EmptyTable } from "../components/shell/empty-table.tsx";
import { ErrorPage } from "../components/shell/error-page.tsx";
import { LanguageSwitcher } from "../components/shell/language-switcher.tsx";
import { reloadAction } from "../components/shell/reload-action.ts";
import { ThemeToggle } from "../components/shell/theme-toggle.tsx";
import { usePageTitle } from "../components/shell/use-page-title.ts";
import { buttonVariants } from "../components/ui/button.tsx";
import { errorMessage } from "../i18n/errors.ts";
import { useT } from "../i18n/hooks.ts";
import type { MessageKey } from "../i18n/i18n.ts";
import { COOKIES_BLOCKED, UNAUTHENTICATED } from "../identity/identity.ts";
import { takeSignInError } from "../identity/sign-in.ts";
import { RoomSoundButton } from "../sound/sound-button.tsx";
import { useIdentityStore } from "../stores/identity-store.ts";

// The toaster (sonner) loads after first render: no toast can come before the room has
// connected, and it keeps about 10 kB gzipped out of the initial JavaScript.
const Toaster = lazy(() =>
  import("../components/ui/sonner.tsx").then((module) => ({ default: module.Toaster })),
);

/**
 * The page's side gutters: 16 px, or more beside a notch on a phone held sideways. In
 * portrait the insets are 0, so the table's `PHONE_MAX_ROOM` (608 px of a 640 px
 * viewport) still holds. In px, not rem (#37): a larger text setting must not take room
 * from the table, whose geometry is proven for rooms from 328 px (`layout.test.ts`).
 */
const GUTTERS =
  "pr-[max(16px,env(safe-area-inset-right))] pl-[max(16px,env(safe-area-inset-left))]";

export const Route = createRootRoute({
  component: RootLayout,
  notFoundComponent: NotFound,
  errorComponent: RootError,
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
      {/* Inside the safe areas: the page runs under a notch or a home indicator (viewport-fit=cover). */}
      <header className="border-b border-line bg-surface pt-[env(safe-area-inset-top)]">
        <div
          className={`group/bar mx-auto flex max-w-5xl items-center justify-between gap-4 py-2 phone:py-1 ${GUTTERS}`}
        >
          <Link
            to="/"
            className="flex min-h-11 items-center gap-2.5 rounded-md font-display text-base font-[760] [font-stretch:110%]"
          >
            <BrandMark />
            {/* Under 360 px three buttons leave no room for the words: the mark says it. */}
            <span className="narrow:group-has-[[data-sound]]/bar:sr-only">{t("app.name")}</span>
          </Link>
          <div className="flex items-center gap-1">
            <RoomSoundButton />
            <LanguageSwitcher />
            <ThemeToggle />
          </div>
        </div>
      </header>
      <main
        id="main"
        tabIndex={-1}
        // The room page starts close under the header on phones and short screens (#22):
        // the table and the hand need the height.
        className={`mx-auto max-w-5xl py-12 outline-none sm:py-20 lg:py-10 phone:has-[[data-room-page]]:pt-2 squat:has-[[data-room-page]]:pt-3 ${GUTTERS}`}
      >
        <Outlet />
      </main>
      <Suspense fallback={null}>
        <Toaster />
      </Suspense>
      <IdentityToasts />
      <SignInToast />
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
        toast.error(t("identity.cookiesBlocked"), {
          id: "cookies-blocked",
          duration: Infinity,
          action: reloadAction(t),
        });
      } else if (error === UNAUTHENTICATED) {
        toast.error(errorMessage(t, error), { id: "session-lost", action: reloadAction(t) });
      }
    });
  }, [status, error, t]);
  return null;
}

/** The catalog key of each reason a sign-in came back without finishing (#47). */
const SIGN_IN_FAILURES = {
  cancelled: "signIn.errors.cancelled",
  account_exists: "signIn.errors.accountExists",
  no_email: "signIn.errors.noEmail",
  tenant_not_allowed: "signIn.errors.tenantNotAllowed",
  rate_limited: "signIn.errors.rateLimited",
  failed: "signIn.errors.failed",
  still_moving: "signIn.errors.stillMoving",
} as const satisfies Record<SignInErrorCode, MessageKey>;

/**
 * A sign-in ends in a full-page redirect, so what went wrong arrives with the page: said once,
 * in the reader's language. Going back at the provider is no error, and does not look like one;
 * nor do rooms still on their way to the account (#48): that person is signed in.
 */
function SignInToast() {
  const t = useT();
  useEffect(() => {
    const code = takeSignInError();
    if (code === null) return;
    const message = t(SIGN_IN_FAILURES[code]);
    void import("sonner").then(({ toast }) => {
      if (code === "cancelled" || code === "still_moving") toast(message, { id: "sign-in" });
      else toast.error(message, { id: "sign-in" });
    });
  }, [t]);
  return null;
}

/**
 * When the shell itself fails there is no layout around the error page: it brings its own
 * `<main>`. Errors inside a page show within the shell (`defaultErrorComponent`).
 */
function RootError() {
  return (
    <main id="main" className={`mx-auto max-w-5xl py-12 sm:py-20 lg:py-10 ${GUTTERS}`}>
      <ErrorPage />
    </main>
  );
}

function NotFound() {
  const t = useT();
  usePageTitle(t("notFound.title"));
  return (
    <section className="max-w-2xl">
      <EmptyTable />
      <h1 className="mt-6 text-3xl font-[760] [font-stretch:110%] sm:text-4xl">
        {t("notFound.title")}
      </h1>
      <p className="mt-4 text-ink-2">{t("notFound.body")}</p>
      <Link to="/" className={buttonVariants({ variant: "outline", className: "mt-8" })}>
        {t("room.backHome")}
      </Link>
    </section>
  );
}
