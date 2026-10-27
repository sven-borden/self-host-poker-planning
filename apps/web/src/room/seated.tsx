import type { ParticipantView, RoomView as RoomSnapshotView } from "@pp/protocol";
import { useT } from "../i18n/hooks.ts";
import { TableStage } from "../table/table-stage.tsx";
import { LiveAnnouncer } from "./live-announcer.tsx";
import { tableData } from "./table-data.ts";
import { YouControls } from "./you-controls.tsx";

interface SeatedProps {
  room: RoomSnapshotView;
  /** The viewer as the snapshot lists them. */
  me: ParticipantView;
  focusOnMount: boolean;
  onFocused: () => void;
  onLeaving: (leaving: boolean) => void;
}

/**
 * The room once the viewer is in it: the table from #13, filled from the snapshot (who is
 * here, away or voted, the PO and the viewer, #17), the live region that announces it,
 * and the viewer's own panel. A chunk of its own (`RoomView` loads it lazily and
 * prefetches it when the page mounts): the table only shows once a snapshot has arrived,
 * so the chunk loads beside the socket and stays out of the room route's initial budget.
 * The table's centre (`TableStage` children) is free for #18's status.
 */
export function Seated({ room, me, focusOnMount, onFocused, onLeaving }: SeatedProps) {
  const t = useT();
  const { people, observers, looks } = tableData(room);
  return (
    <div className="flex flex-col gap-6">
      <section aria-label={t("room.tableHeading")} data-room-table>
        <TableStage people={people} observers={observers} />
        <LiveAnnouncer />
      </section>
      <YouControls
        me={me}
        look={looks.get(me.id)}
        focusOnMount={focusOnMount}
        onFocused={onFocused}
        onLeaving={onLeaving}
      />
    </div>
  );
}
