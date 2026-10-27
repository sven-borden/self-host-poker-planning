import { createFileRoute } from "@tanstack/react-router";
import { useId } from "react";
import { useFormat, useT } from "../i18n/hooks.ts";
import type { MessageKey } from "../i18n/i18n.ts";
import { RiseIn } from "../motion/motion.tsx";
import { CreateRoomCard } from "../rooms/create-room-card.tsx";
import { JoinRoomCard } from "../rooms/join-room-card.tsx";

export const Route = createFileRoute("/")({
  component: Home,
});

/** How a round goes, as the landing page tells it: each step's title and line. */
const STEPS = [
  ["home.step1Title", "home.step1Body"],
  ["home.step2Title", "home.step2Body"],
  ["home.step3Title", "home.step3Body"],
  ["home.step4Title", "home.step4Body"],
] as const satisfies readonly (readonly [MessageKey, MessageKey])[];

/**
 * The landing page (#24): what the tool is, how a round goes, "Create a room" (#14) and
 * "Join with a code". On phones it reads top to bottom: the pitch, the two ways in, then
 * the steps. From 1024 px the creation card stands on the right, with the join card and
 * then the steps under the pitch: both ways in fit above the fold at 1440 × 900, the join
 * field at 1366 × 768, and the steps come last at every width.
 */
function Home() {
  const t = useT();
  const format = useFormat();
  const stepsHeading = useId();
  return (
    <RiseIn className="grid gap-10 [grid-template-areas:'intro'_'create'_'join'_'how'] lg:grid-cols-[minmax(0,1fr)_minmax(0,27rem)] lg:grid-rows-[auto_auto_1fr] lg:gap-x-14 lg:[grid-template-areas:'intro_create'_'join_create'_'how_create']">
      <div className="[grid-area:intro]">
        <p className="font-mono text-xs tracking-[0.08em] text-ink-2 uppercase">
          {t("app.tagline")}
        </p>
        <h1 className="mt-3 text-[clamp(30px,4.4vw,48px)] font-[820] tracking-[-0.01em] [font-stretch:116%]">
          {t("home.title")}
        </h1>
        <p className="mt-5 max-w-prose text-ink-2">{t("home.lede")}</p>
      </div>
      <CreateRoomCard className="[grid-area:create] lg:self-start" />
      <JoinRoomCard title={t("join.title")} className="max-w-xl [grid-area:join] lg:self-start" />
      <section aria-labelledby={stepsHeading} className="[grid-area:how]">
        <h2 id={stepsHeading} className="font-mono text-xs tracking-[0.08em] text-ink-2 uppercase">
          {t("home.howTitle")}
        </h2>
        <ol className="mt-4 grid gap-x-6 gap-y-5 sm:grid-cols-2">
          {STEPS.map(([title, body], index) => (
            <li key={title} className="flex gap-3.5">
              {/* A small card face; the list itself tells a screen reader the number. */}
              <span
                aria-hidden
                className="flex h-11 w-8 shrink-0 items-center justify-center rounded-[5px] border border-card-edge bg-card-face font-display text-lg font-[800] text-card-ink tabular-nums shadow-sm [font-stretch:110%]"
              >
                {format.number(index + 1)}
              </span>
              <div className="min-w-0">
                <p className="font-semibold">{t(title)}</p>
                <p className="mt-1 text-sm text-ink-2">{t(body)}</p>
              </div>
            </li>
          ))}
        </ol>
      </section>
    </RiseIn>
  );
}
