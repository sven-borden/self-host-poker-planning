import { MAX_PARTICIPANTS } from "@pp/domain";
import { Link } from "@tanstack/react-router";
import { lazy, Suspense, useCallback, useEffect, useId, useRef, useState } from "react";
import { buttonVariants } from "../components/ui/button.tsx";
import { useT } from "../i18n/hooks.ts";
import { useRoomStore } from "../stores/room-store.ts";
import { JoinForm } from "./join-form.tsx";
import { isRoomFull } from "./room-full.ts";
import { RoomStatus } from "./room-status.tsx";

/** The table and the "You" panel: a chunk of their own, prefetched when the page mounts. */
const loadSeated = () => import("./seated.tsx");
const Seated = lazy(() => loadSeated().then((module) => ({ default: module.Seated })));

/** Where the focus goes after the screen changes under it: joining, leaving, a free seat. */
type FocusTarget = "you" | "join" | null;

/** What the room below its header shows. */
type Screen = "none" | "join" | "full" | "seated";

/**
 * The room below its header (#16): the connection status, then, from the latest snapshot,
 * the join form while the viewer is not in the room (or the room-full screen), else the
 * table and the viewer's own controls. Everything comes from the room store; the server
 * decides, the page renders.
 */
export function RoomView() {
  const t = useT();
  const status = useRoomStore((state) => state.status);
  const room = useRoomStore((state) => state.snapshot?.room);
  const version = useRoomStore((state) => state.snapshot?.version);
  // The version the server answered `room_full` at; any newer snapshot asks again.
  const [refusedAt, setRefusedAt] = useState<number | null>(null);
  // Set just before the screen changes, and cleared once the new screen took the focus.
  const [focus, setFocus] = useState<FocusTarget>(null);
  const focused = useCallback(() => setFocus(null), []);
  /** Said politely when the screen changes on its own (a seat freed up). */
  const [notice, setNotice] = useState("");

  useEffect(() => {
    // A failed prefetch is not an error yet: rendering the table asks again.
    loadSeated().catch(() => {});
  }, []);

  const ready = room !== undefined && status !== "error";
  const me = ready ? room.participants.find((p) => p.id === room.you) : undefined;
  const full = ready && (isRoomFull(room) || (refusedAt !== null && refusedAt === version));
  const screen: Screen = !ready ? "none" : me !== undefined ? "seated" : full ? "full" : "join";

  // Someone left while the room-full screen showed: the form replaces it, so the focus
  // moves to the name field and the change is announced.
  const shown = useRef(screen);
  useEffect(() => {
    const before = shown.current;
    shown.current = screen;
    if (before === "full" && screen === "join") {
      setFocus("join");
      setNotice(t("room.seatFree"));
    } else if (screen !== "join") {
      setNotice("");
    }
  }, [screen, t]);

  return (
    <>
      {/* The connection and the people count sit in the header (`RoomPresence`). */}
      <RoomStatus presence={false} />
      <p role="status" data-room-notice className="sr-only">
        {notice}
      </p>
      {ready && screen === "full" ? <RoomFull /> : null}
      {ready && screen === "join" ? (
        <JoinForm
          observersCount={room.settings.observersCount}
          focusOnMount={focus === "join"}
          onFocused={focused}
          onJoining={(joining) => setFocus(joining ? "you" : null)}
          onFull={() => setRefusedAt(version ?? null)}
        />
      ) : null}
      {ready && me !== undefined ? (
        <Suspense fallback={null}>
          <Seated
            room={room}
            me={me}
            focusOnMount={focus === "you"}
            onFocused={focused}
            onLeaving={(leaving) => setFocus(leaving ? "join" : null)}
          />
        </Suspense>
      ) : null}
    </>
  );
}

/**
 * Nobody can join: 16 people already count. The screen follows the room, so it turns
 * back into the join form as soon as someone leaves.
 */
function RoomFull() {
  const t = useT();
  const heading = useId();
  const ref = useRef<HTMLElement>(null);
  // Announced and focused once, when the refusal or the full room first shows.
  useEffect(() => ref.current?.focus(), []);
  return (
    <section
      ref={ref}
      tabIndex={-1}
      aria-labelledby={heading}
      data-room-full
      className="max-w-xl rounded-xl border border-line bg-surface p-5 outline-none sm:p-7"
    >
      <h2 id={heading} className="text-2xl font-[760] [font-stretch:110%]">
        {t("seat.fullTitle")}
      </h2>
      <p role="status" className="mt-2 text-ink-2">
        {t("seat.fullBody", { max: MAX_PARTICIPANTS })}
      </p>
      <Link to="/" className={buttonVariants({ variant: "outline", className: "mt-6" })}>
        {t("room.backHome")}
      </Link>
    </section>
  );
}
