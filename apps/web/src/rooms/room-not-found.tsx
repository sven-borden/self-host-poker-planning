import { Link } from "@tanstack/react-router";
import { PlusIcon } from "lucide-react";
import { EmptyTable } from "../components/shell/empty-table.tsx";
import { usePageTitle } from "../components/shell/use-page-title.ts";
import { buttonVariants } from "../components/ui/button.tsx";
import { useT } from "../i18n/hooks.ts";
import { RiseIn } from "../motion/motion.tsx";
import { JoinRoomCard } from "./join-room-card.tsx";

/**
 * A room that is not there (#24): an unknown or malformed code, or a room the retention
 * purge deleted. The server cannot tell these apart (it keeps no trace of deleted rooms),
 * so the page names both: a mistyped link, or `retentionDays` without activity (from the
 * 404, when the server states it). The way back: another code, or a new room.
 *
 * The code itself is never shown, in the page or in its title: it is a bearer capability
 * (docs/02-architecture.md, section 11) that a screenshot or a shared screen of this page
 * would spread, and the address bar already shows what was typed.
 */
export function RoomNotFound({ retentionDays }: { retentionDays?: number | undefined }) {
  const t = useT();
  usePageTitle(t("room.notFoundTitle"));
  return (
    <RiseIn data-room-not-found className="flex max-w-2xl flex-col gap-10">
      <div>
        <EmptyTable />
        <h1 className="mt-6 text-3xl font-[760] [font-stretch:110%] sm:text-4xl">
          {t("room.notFoundTitle")}
        </h1>
        <p className="mt-4 text-ink-2">{t("roomGone.lede")}</p>
        <ul className="mt-3 flex list-disc flex-col gap-2 pl-5 text-ink-2 marker:text-brass">
          <li>{t("roomGone.typo")}</li>
          <li>
            {retentionDays === undefined
              ? t("roomGone.expiredUnknown")
              : t("roomGone.expired", { count: retentionDays })}
          </li>
        </ul>
      </div>
      <JoinRoomCard title={t("roomGone.tryAnother")} primary />
      <Link to="/" className={buttonVariants({ variant: "outline", className: "self-start" })}>
        <PlusIcon aria-hidden />
        {t("roomGone.createRoom")}
      </Link>
    </RiseIn>
  );
}
