import { MAX_PARTICIPANTS } from "@pp/domain";
import type { RoomView as RoomSnapshotView } from "@pp/protocol";
import { Link } from "@tanstack/react-router";
import { useEffect, useId, useRef, useState } from "react";
import { buttonVariants } from "../components/ui/button.tsx";
import { useT } from "../i18n/hooks.ts";
import { useRoomStore } from "../stores/room-store.ts";
import { TableStage } from "../table/table-stage.tsx";
import { JoinForm } from "./join-form.tsx";
import { RoomStatus } from "./room-status.tsx";
import { isRoomFull, tableData } from "./table-data.ts";
import { YouControls } from "./you-controls.tsx";

/** Where the focus goes after the screen changes under it: joining or leaving. */
type FocusTarget = "you" | "join" | null;

/**
 * The room below its header (#16): the connection status, then, from the latest snapshot,
 * the join form while the viewer is not in the room (or the room-full screen), else the
 * table and the viewer's own controls. Everything comes from the room store; the server
 * decides, the page renders.
 */
export function RoomView() {
  const status = useRoomStore((state) => state.status);
  const room = useRoomStore((state) => state.snapshot?.room);
  const version = useRoomStore((state) => state.snapshot?.version);
  // The version the server answered `room_full` at; any newer snapshot asks again.
  const [refusedAt, setRefusedAt] = useState<number | null>(null);
  const [focus, setFocus] = useState<FocusTarget>(null);

  const ready = room !== undefined && status !== "error";
  const me = ready ? room.participants.find((p) => p.id === room.you) : undefined;
  return (
    <>
      <RoomStatus />
      {ready && me === undefined ? (
        isRoomFull(room) || (refusedAt !== null && refusedAt === version) ? (
          <RoomFull />
        ) : (
          <JoinForm
            observersCount={room.settings.observersCount}
            focusOnMount={focus === "join"}
            onJoining={(joining) => setFocus(joining ? "you" : null)}
            onFull={() => setRefusedAt(version ?? null)}
          />
        )
      ) : null}
      {ready && me !== undefined ? (
        <div className="flex flex-col gap-6">
          <RoomTable room={room} />
          <YouControls
            me={me}
            focusOnMount={focus === "you"}
            onLeaving={(leaving) => setFocus(leaving ? "join" : null)}
          />
        </div>
      ) : null}
    </>
  );
}

/** The table from #13, filled from the snapshot. */
function RoomTable({ room }: { room: RoomSnapshotView }) {
  const t = useT();
  const { people, observers } = tableData(room);
  return (
    <section aria-label={t("room.tableHeading")} data-room-table>
      <TableStage people={people} observers={observers} />
    </section>
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
        {t("join.fullTitle")}
      </h2>
      <p role="status" className="mt-2 text-ink-2">
        {t("join.fullBody", { max: MAX_PARTICIPANTS })}
      </p>
      <Link to="/" className={buttonVariants({ variant: "outline", className: "mt-6" })}>
        {t("room.backHome")}
      </Link>
    </section>
  );
}
