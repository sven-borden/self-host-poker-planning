import { Link } from "@tanstack/react-router";
import { Button, buttonVariants } from "../components/ui/button.tsx";
import { errorMessage } from "../i18n/errors.ts";
import { useT } from "../i18n/hooks.ts";
import { useRoomStore } from "../stores/room-store.ts";

// The room page until #16 and #17 bring the join screen and the table: where the
// connection stands and how many people are in the room, from the latest snapshot. The
// table goes where the participant count is now; the status line can stay above it.

export function RoomStatus({ code }: { code: string }) {
  const t = useT();
  const status = useRoomStore((state) => state.status);
  const error = useRoomStore((state) => state.error);
  const people = useRoomStore((state) => state.snapshot?.room.participants.length);

  return (
    <section className="max-w-2xl">
      <h1 className="text-3xl font-[760] [font-stretch:110%] sm:text-4xl">
        {t("room.title", { code })}
      </h1>
      <dl className="mt-6 flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <dt className="font-mono text-xs tracking-[0.08em] text-ink-2 uppercase">
          {t("room.codeLabel")}
        </dt>
        <dd className="m-0 rounded-md bg-surface-2 px-2 py-0.5 font-mono text-sm">{code}</dd>
      </dl>
      {/* Announced politely: a reconnect must not interrupt a screen reader mid-sentence. */}
      <p role="status" className="mt-6 text-ink-2">
        {status === "connecting" && t("room.statusConnecting")}
        {status === "live" && t("room.statusLive")}
        {status === "reconnecting" && t("room.statusReconnecting")}
      </p>
      {people !== undefined && status !== "error" && (
        <p className="mt-2" data-testid="room-people">
          {t("room.people", { count: people })}
        </p>
      )}
      {status === "error" && error !== null && <RoomError error={error} />}
    </section>
  );
}

function RoomError({ error }: { error: string }) {
  const t = useT();
  if (error === "protocol_mismatch") {
    // An old tab after a redeploy: its code no longer speaks the server's protocol.
    return (
      <div role="alert" className="mt-6 rounded-lg border border-line bg-surface p-4">
        <p>{errorMessage(t, error)}</p>
        <Button className="mt-4" onClick={() => window.location.reload()}>
          {t("room.reload")}
        </Button>
      </div>
    );
  }
  const message =
    error === "kicked"
      ? t("room.kicked")
      : error === "offline"
        ? t("room.offline")
        : errorMessage(t, error);
  return (
    <div role="alert" className="mt-6">
      <p>{message}</p>
      <Link to="/" className={buttonVariants({ variant: "outline", className: "mt-6" })}>
        {t("room.backHome")}
      </Link>
    </div>
  );
}
