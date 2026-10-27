import { Link } from "@tanstack/react-router";
import { Button, buttonVariants } from "../components/ui/button.tsx";
import { errorMessage } from "../i18n/errors.ts";
import { useT } from "../i18n/hooks.ts";
import { useRoomStore } from "../stores/room-store.ts";

/**
 * Where the connection stands and how many people are in the room, from the latest
 * snapshot, on one line that wraps when it must. The room's header shows it beside the
 * code (#22), so a phone spends one line on it, not two.
 */
export function RoomPresence() {
  const t = useT();
  const status = useRoomStore((state) => state.status);
  const people = useRoomStore((state) => state.snapshot?.room.participants.length);
  return (
    <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
      {/* Announced politely: a reconnect must not interrupt a screen reader mid-sentence. */}
      <p
        role="status"
        className="m-0 inline-flex items-center gap-1.5 text-ink-2"
        data-testid="room-connection"
      >
        {/* On a phone a live room is a dot (CanvasText in forced colours), its word for screen readers; any other state is written out. */}
        {status === "live" ? (
          <span
            aria-hidden="true"
            className="hidden size-2 rounded-full bg-good phone:block forced-colors:bg-[CanvasText]"
          />
        ) : null}
        <span className={status === "live" ? "phone:sr-only" : undefined}>
          {status === "connecting" && t("room.statusConnecting")}
          {status === "live" && t("room.statusLive")}
          {status === "reconnecting" && t("room.statusReconnecting")}
        </span>
      </p>
      {people !== undefined && status !== "error" && (
        <p className="m-0" data-testid="room-people">
          {t("room.people", { count: people })}
        </p>
      )}
    </div>
  );
}

/**
 * The room's state below its header: with `presence`, the line above (`RoomPresence`),
 * then the errors that end the visit (offline, an old app after a redeploy). Being removed
 * by the PO (#30) is not one of them: the page goes back to the join form (`RoomView`).
 */
export function RoomStatus({ presence = true }: { presence?: boolean }) {
  const status = useRoomStore((state) => state.status);
  const error = useRoomStore((state) => state.error);
  const failed = status === "error" && error !== null;
  if (!presence && !failed) return null;
  return (
    <div className="max-w-2xl">
      {presence ? <RoomPresence /> : null}
      {failed ? <RoomError error={error} /> : null}
    </div>
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
  const message = error === "offline" ? t("room.offline") : errorMessage(t, error);
  return (
    <div role="alert" className="mt-6">
      <p>{message}</p>
      <Link to="/" className={buttonVariants({ variant: "outline", className: "mt-6" })}>
        {t("room.backHome")}
      </Link>
    </div>
  );
}
