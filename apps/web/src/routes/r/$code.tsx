import { createFileRoute, Link } from "@tanstack/react-router";
import { LinkIcon, LockIcon } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { Button, buttonVariants } from "../../components/ui/button.tsx";
import { Input } from "../../components/ui/input.tsx";
import { errorMessage } from "../../i18n/errors.ts";
import { useT } from "../../i18n/hooks.ts";
import { RiseIn } from "../../motion/motion.tsx";
import { openRoom } from "../../realtime/room-connection.ts";
import { RoomHistoryButton } from "../../room/history-button.tsx";
import { loadJoinPassword } from "../../room/load-join-password.ts";
import { RoomPresence } from "../../room/room-status.tsx";
import { RoomView } from "../../room/room-view.tsx";
import { RoomSettingsButton } from "../../room/settings-button.tsx";
import { fetchRoomHeader, RoomApiError, type RoomHeader } from "../../rooms/api.ts";
import { RoomNotFound } from "../../rooms/room-not-found.tsx";
import { useRoomStore } from "../../stores/room-store.ts";

export const Route = createFileRoute("/r/$code")({
  component: RoomPage,
});

type HeaderState =
  | { status: "loading" }
  | { status: "ready"; header: RoomHeader }
  | { status: "error"; code: string; retentionDays?: number | undefined };

/**
 * The room page: its header (#14), the room's name and code from `GET /api/rooms/:code`
 * and the link to share, then the room itself, followed over its socket (#15) once the
 * header says the room exists. The slot holds the join form or the table (#16, #17). An
 * unknown code shows `RoomNotFound` (#24), from the header fetch here or from the
 * socket's `enter` (`RoomHeaderView`).
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
        setState(
          error instanceof RoomApiError
            ? { status: "error", code: error.code, retentionDays: error.retentionDays }
            : { status: "error", code: "internal" },
        ),
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
  if (state.status === "error" && state.code === "room_not_found") {
    return <RoomNotFound retentionDays={state.retentionDays} />;
  }
  if (state.status === "error") {
    return (
      <RiseIn className="max-w-2xl">
        <h1 className="text-3xl font-[760] break-words [font-stretch:110%] sm:text-4xl">
          {t("room.title", { code })}
        </h1>
        <p className="mt-4 text-ink-2" role="alert">
          {state.code === "network" ? t("common.network") : errorMessage(t, state.code)}
        </p>
        <div className="mt-8 flex flex-wrap gap-3">
          <Button onClick={() => setAttempt((n) => n + 1)}>{t("room.retry")}</Button>
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
  /** What the toast would have said, when the toast cannot be shown. */
  const [note, setNote] = useState<string | null>(null);
  const url = `${window.location.origin}/r/${header.code}`;

  // Follows the room over its socket while the page is open.
  useEffect(() => openRoom(header.code), [header.code]);

  useEffect(() => {
    // The link is there to be copied by hand: focused and fully selected.
    if (showLink) {
      linkInput.current?.focus();
      linkInput.current?.select();
    }
  }, [showLink]);

  // The room went away between the header and the socket's enter (the purge, or a
  // deletion): the same page as an unknown code, without the code. The store's code is
  // checked so that a room left behind never answers for this one.
  const gone = useRoomStore(
    (state) =>
      state.code === header.code && state.status === "error" && state.error === "room_not_found",
  );
  // The room's password (#31): the live snapshot's word once there is one, the header's
  // before (and while the page asks for it, when it holds no snapshot).
  const live = useRoomStore((state) =>
    state.code === header.code && state.snapshot
      ? state.snapshot.room.settings.hasPassword === true
      : null,
  );
  const locked = useRoomStore((state) => state.code === header.code && state.status === "locked");
  const hasPassword = live ?? (header.hasPassword || locked);
  // The join form's password block is a lazy chunk: fetched now, it is there when asked.
  useEffect(() => {
    if (header.hasPassword) loadJoinPassword().catch(() => {});
  }, [header.hasPassword]);
  if (gone) return <RoomNotFound />;

  async function copyLink() {
    let copied = false;
    try {
      // Missing outside a secure context (an http address on a LAN), refused when the
      // browser denies the permission.
      if (!navigator.clipboard) throw new Error("no clipboard");
      await navigator.clipboard.writeText(url);
      copied = true;
    } catch {
      setShowLink(true);
    }
    // In a room with a password the link alone does not let anyone in: say so.
    const message = !copied
      ? t("room.copyFailed")
      : hasPassword
        ? t("password.linkCopied")
        : t("room.linkCopied");
    try {
      // The toaster is a lazy chunk, so the toasts are too: after a redeploy the import can
      // fail, and the message is then shown in the page.
      const { toast } = await import("sonner");
      if (copied) toast.success(message, { id: "link-copied" });
      else toast(message, { id: "link-copy-failed" });
      setNote(null);
    } catch {
      setNote(message);
    }
  }

  return (
    // The header names the room, then gives its code, the connection and the people count
    // on one line (`RoomPresence`). On a phone (#22) it is compact: the name one size
    // smaller, the copy-link button an icon beside it (its name stays "Copy the link"), and
    // the code's label for screen readers only, so the code, the connection and the
    // count share the line under them.
    <RiseIn data-room-page className="flex flex-col gap-10 phone:gap-2 squat:gap-3">
      <header className="flex items-start justify-between gap-3 sm:items-end sm:gap-5 phone:grid phone:grid-cols-[minmax(0,1fr)_auto] phone:items-center phone:gap-y-1">
        {/* On a phone its two lines join the grid: the name beside the button, then the line under both. */}
        <div className="min-w-0 phone:contents">
          {/* overflow-hidden: whatever the name stacks above or below its letters stays inside. */}
          <h1 className="overflow-hidden py-1 text-3xl font-[760] break-words [font-stretch:110%] sm:text-4xl squat:text-2xl phone:col-start-1 phone:row-start-1 phone:py-0.5 phone:text-xl">
            {header.name !== null ? (
              <bdi>{header.name}</bdi>
            ) : (
              t("room.title", { code: header.code })
            )}
            {hasPassword ? (
              // A lock beside the name, named for screen readers (#31).
              <span
                role="img"
                data-room-lock
                aria-label={t("password.roomHas")}
                title={t("password.roomHas")}
                className="ml-2 inline-flex align-baseline text-ink-2"
              >
                <LockIcon aria-hidden className="size-[0.6em] translate-y-[0.05em]" />
              </span>
            ) : null}
          </h1>
          <div className="mt-4 flex flex-wrap items-baseline gap-x-4 gap-y-1 squat:mt-1 phone:col-span-2 phone:mt-0 phone:text-sm">
            <dl className="m-0 flex items-baseline gap-x-3">
              <dt className="font-mono text-xs tracking-[0.08em] text-ink-2 uppercase phone:sr-only">
                {t("room.codeLabel")}
              </dt>
              <dd
                data-room-code
                className="m-0 rounded-md bg-surface-2 px-2 py-0.5 font-mono text-sm"
              >
                {header.code}
              </dd>
            </dl>
            <RoomPresence />
          </div>
        </div>
        {/* The header's actions: the link to share, the history (#33) and the room's settings or
            rules (#25). */}
        <div className="flex shrink-0 flex-wrap justify-end gap-2 phone:col-start-2 phone:row-start-1 phone:flex-nowrap">
          <Button
            variant="outline"
            className="shrink-0 phone:size-11 phone:has-[>svg]:px-0"
            onClick={copyLink}
          >
            <LinkIcon aria-hidden />
            <span className="phone:sr-only">{t("room.copyLink")}</span>
          </Button>
          <RoomHistoryButton />
          <RoomSettingsButton />
        </div>
      </header>
      {note && (
        <p role="status" className="max-w-xl text-sm text-ink-2">
          {note}
        </p>
      )}
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
      {/* The room itself: the join form, or the table and the viewer's controls (#16). */}
      <div data-room-slot className="flex flex-col gap-6 phone:gap-3">
        <RoomView />
      </div>
    </RiseIn>
  );
}
