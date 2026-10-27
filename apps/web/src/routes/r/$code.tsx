import { createFileRoute, Link } from "@tanstack/react-router";
import { LinkIcon } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { Button, buttonVariants } from "../../components/ui/button.tsx";
import { Input } from "../../components/ui/input.tsx";
import { errorMessage } from "../../i18n/errors.ts";
import { useT } from "../../i18n/hooks.ts";
import { RiseIn } from "../../motion/motion.tsx";
import { fetchRoomHeader, RoomApiError, type RoomHeader } from "../../rooms/api.ts";

export const Route = createFileRoute("/r/$code")({
  component: RoomPage,
});

type HeaderState =
  | { status: "loading" }
  | { status: "ready"; header: RoomHeader }
  | { status: "error"; code: string };

/**
 * The room page. For now its header (#14): the room's name and code from
 * `GET /api/rooms/:code`, and the link to share. The room itself (the table, joining)
 * fills the slot below it (#15, #16); #24 designs the full not-found page.
 */
function RoomPage() {
  const { code } = Route.useParams();
  const t = useT();
  const [state, setState] = useState<HeaderState>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `attempt` asks again on "Try again".
  useEffect(() => {
    let current = true;
    setState({ status: "loading" });
    fetchRoomHeader(code).then(
      (header) => current && setState({ status: "ready", header }),
      (error: unknown) =>
        current &&
        setState({
          status: "error",
          code: error instanceof RoomApiError ? error.code : "internal",
        }),
    );
    return () => {
      current = false;
    };
  }, [code, attempt]);

  if (state.status === "loading") {
    return (
      <p role="status" className="text-ink-2">
        {t("room.loading")}
      </p>
    );
  }
  if (state.status === "error") {
    const notFound = state.code === "room_not_found";
    return (
      <RiseIn className="max-w-2xl">
        <h1 className="text-3xl font-[760] [font-stretch:110%] sm:text-4xl">
          {notFound ? t("room.notFoundTitle") : t("room.title", { code })}
        </h1>
        <p className="mt-4 text-ink-2" role={notFound ? undefined : "alert"}>
          {state.code === "network" ? t("common.network") : errorMessage(t, state.code)}
        </p>
        <div className="mt-8 flex flex-wrap gap-3">
          {!notFound && <Button onClick={() => setAttempt((n) => n + 1)}>{t("room.retry")}</Button>}
          <Link to="/" className={buttonVariants({ variant: "outline" })}>
            {t("room.backHome")}
          </Link>
        </div>
      </RiseIn>
    );
  }
  return <RoomHeaderView header={state.header} />;
}

function RoomHeaderView({ header }: { header: RoomHeader }) {
  const t = useT();
  const linkId = useId();
  const linkInput = useRef<HTMLInputElement>(null);
  const [showLink, setShowLink] = useState(false);
  const url = `${window.location.origin}/r/${header.code}`;

  useEffect(() => {
    if (showLink) linkInput.current?.select();
  }, [showLink]);

  async function copyLink() {
    // The toaster is a lazy chunk, so the toasts are too.
    const toasts = import("sonner");
    try {
      // Missing outside a secure context (an http address on a LAN), refused when the
      // browser denies the permission.
      if (!navigator.clipboard) throw new Error("no clipboard");
      await navigator.clipboard.writeText(url);
      const { toast } = await toasts;
      toast.success(t("room.linkCopied"), { id: "link-copied" });
    } catch {
      setShowLink(true);
      linkInput.current?.select();
      const { toast } = await toasts;
      toast(t("room.copyFailed"), { id: "link-copy-failed" });
    }
  }

  return (
    <RiseIn className="flex flex-col gap-10">
      <header className="flex flex-col gap-5 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0">
          <h1 className="text-3xl font-[760] break-words [font-stretch:110%] sm:text-4xl">
            {header.name !== null ? (
              <bdi>{header.name}</bdi>
            ) : (
              t("room.title", { code: header.code })
            )}
          </h1>
          <dl className="mt-4 flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <dt className="font-mono text-xs tracking-[0.08em] text-ink-2 uppercase">
              {t("room.codeLabel")}
            </dt>
            <dd
              data-room-code
              className="m-0 rounded-md bg-surface-2 px-2 py-0.5 font-mono text-sm"
            >
              {header.code}
            </dd>
          </dl>
        </div>
        <Button variant="outline" className="sm:shrink-0" onClick={copyLink}>
          <LinkIcon aria-hidden />
          {t("room.copyLink")}
        </Button>
      </header>
      {showLink && (
        <div className="flex max-w-xl flex-col gap-2">
          <label htmlFor={linkId} className="font-medium">
            {t("room.linkLabel")}
          </label>
          <Input
            id={linkId}
            ref={linkInput}
            readOnly
            value={url}
            className="font-mono"
            onFocus={(event) => event.currentTarget.select()}
          />
        </div>
      )}
      {/* The room itself: the table and joining arrive here (#15, #16). */}
      <section data-room-slot className="rounded-xl border border-line border-dashed p-6">
        <p className="text-ink-2">{t("room.notOpenYet")}</p>
      </section>
    </RiseIn>
  );
}
