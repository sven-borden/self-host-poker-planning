import { createFileRoute } from "@tanstack/react-router";
import { useId } from "react";
import { Button } from "../components/ui/button.tsx";
import { useT } from "../i18n/i18n-context.tsx";
import { RiseIn } from "../motion/motion.tsx";

export const Route = createFileRoute("/")({
  component: Home,
});

function Home() {
  const t = useT();
  const soonId = useId();
  return (
    <RiseIn className="max-w-2xl">
      <p className="font-mono text-xs tracking-[0.08em] text-ink-2 uppercase">{t("app.tagline")}</p>
      <h1 className="mt-3 text-[clamp(30px,4.4vw,48px)] font-[820] tracking-[-0.01em] [font-stretch:116%]">
        {t("home.title")}
      </h1>
      <p className="mt-5 max-w-prose text-ink-2">{t("home.lede")}</p>
      <div className="mt-10 flex flex-col items-start gap-3">
        {/* Enabled in W1, when the server can create rooms. */}
        <Button size="lg" disabled aria-describedby={soonId}>
          {t("home.createRoom")}
        </Button>
        <p id={soonId} className="text-sm text-ink-2">
          {t("home.createRoomSoon")}
        </p>
      </div>
    </RiseIn>
  );
}
