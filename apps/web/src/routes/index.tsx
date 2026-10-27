import { createFileRoute } from "@tanstack/react-router";
import { useT } from "../i18n/hooks.ts";
import { RiseIn } from "../motion/motion.tsx";
import { CreateRoomCard } from "../rooms/create-room-card.tsx";

export const Route = createFileRoute("/")({
  component: Home,
});

function Home() {
  const t = useT();
  return (
    <RiseIn className="max-w-2xl">
      <p className="font-mono text-xs tracking-[0.08em] text-ink-2 uppercase">{t("app.tagline")}</p>
      <h1 className="mt-3 text-[clamp(30px,4.4vw,48px)] font-[820] tracking-[-0.01em] [font-stretch:116%]">
        {t("home.title")}
      </h1>
      <p className="mt-5 max-w-prose text-ink-2">{t("home.lede")}</p>
      <CreateRoomCard className="mt-10" />
    </RiseIn>
  );
}
