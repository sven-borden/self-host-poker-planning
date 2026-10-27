import { RotateCwIcon } from "lucide-react";
import { useT } from "../../i18n/hooks.ts";
import { Button, buttonVariants } from "../ui/button.tsx";
import { EmptyTable } from "./empty-table.tsx";
import { usePageTitle } from "./use-page-title.ts";

/**
 * The generic error page (#24): what the router shows when a page throws or its chunk
 * cannot load (`defaultErrorComponent` in router.ts). A calm message, a reload and a way
 * home, never the error itself: no message, stack or address on screen, since any of
 * them can carry a room code. The home link is a plain link, so it starts the app afresh.
 */
export function ErrorPage() {
  const t = useT();
  usePageTitle(t("errorPage.title"));
  return (
    <section data-error-page className="max-w-2xl">
      <EmptyTable card />
      <h1 className="mt-6 text-3xl font-[760] [font-stretch:110%] sm:text-4xl">
        {t("errorPage.title")}
      </h1>
      <p className="mt-4 max-w-prose text-ink-2">{t("errorPage.body")}</p>
      <div className="mt-8 flex flex-wrap gap-3">
        <Button onClick={() => window.location.reload()}>
          <RotateCwIcon aria-hidden />
          {t("errorPage.reload")}
        </Button>
        <a href="/" className={buttonVariants({ variant: "outline" })}>
          {t("room.backHome")}
        </a>
      </div>
    </section>
  );
}
