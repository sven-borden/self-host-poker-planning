import { createFileRoute, Link } from "@tanstack/react-router";
import { buttonVariants } from "../../components/ui/button.tsx";
import { useT } from "../../i18n/i18n-context.tsx";
import { RiseIn } from "../../motion/motion.tsx";

export const Route = createFileRoute("/r/$code")({
  component: RoomPlaceholder,
});

/** Placeholder until W1 brings the table: shows the room code from the URL. */
function RoomPlaceholder() {
  const { code } = Route.useParams();
  const t = useT();
  return (
    <RiseIn className="max-w-2xl">
      <h1 className="text-3xl font-[760] [font-stretch:110%] sm:text-4xl">
        {t("room.title", { code })}
      </h1>
      <dl className="mt-6 flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <dt className="font-mono text-xs tracking-[0.08em] text-ink-2 uppercase">
          {t("room.codeLabel")}
        </dt>
        <dd className="m-0 rounded-md bg-surface-2 px-2 py-0.5 font-mono text-sm">{code}</dd>
      </dl>
      <p className="mt-6 text-ink-2">{t("room.notOpenYet")}</p>
      <Link to="/" className={buttonVariants({ variant: "outline", className: "mt-8" })}>
        {t("room.backHome")}
      </Link>
    </RiseIn>
  );
}
