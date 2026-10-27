import type { ParticipantView, RoomView as RoomSnapshotView } from "@pp/protocol";
import { useT } from "../i18n/hooks.ts";
import { TableStage } from "../table/table-stage.tsx";
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
 * The room once the viewer is in it: the table from #13, filled from the snapshot, and
 * the viewer's own panel. A chunk of its own (`RoomView` loads it lazily and prefetches it
 * when the page mounts): the table only shows once a snapshot has arrived, so the chunk
 * loads beside the socket and stays out of the room route's initial budget.
 */
export function Seated({ room, me, focusOnMount, onFocused, onLeaving }: SeatedProps) {
  const t = useT();
  const { people, observers } = tableData(room);
  return (
    <div className="flex flex-col gap-6">
      <section aria-label={t("room.tableHeading")} data-room-table>
        <TableStage people={people} observers={observers} />
      </section>
      <YouControls
        me={me}
        focusOnMount={focusOnMount}
        onFocused={onFocused}
        onLeaving={onLeaving}
      />
    </div>
  );
}
