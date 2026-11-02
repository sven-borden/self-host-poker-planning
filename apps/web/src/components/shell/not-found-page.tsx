import { Link } from "@tanstack/react-router";
import { useT } from "../../i18n/hooks.ts";
import { buttonVariants } from "../ui/button.tsx";
import { EmptyTable } from "./empty-table.tsx";
import { usePageTitle } from "./use-page-title.ts";

/** An address this app has no page for, or a page this install does not offer (#49). */
export function NotFoundPage() {
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
