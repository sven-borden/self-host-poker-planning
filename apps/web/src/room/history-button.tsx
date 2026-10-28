import { HistoryIcon } from "lucide-react";
import { useRef, useState } from "react";
import { Button } from "../components/ui/button.tsx";
import { useT } from "../i18n/hooks.ts";
import { useRoomStore } from "../stores/room-store.ts";

type PanelModule = typeof import("./history-panel.tsx");

/** The panel's code: a chunk of its own, loaded on the first open. */
const loadPanel = () => import("./history-panel.tsx");

/**
 * The room header's "History" button (#33), beside "Room settings" or "Room rules", for
 * everyone in the room: voters, observers and the PO, never someone still on the join
 * form (the server refuses them too). The first press loads the panel's chunk, which then
 * stays mounted (closed) so the sheet can animate out and in again; a failed load says so
 * in a toast and leaves the page as it was, as the settings button does.
 */
/** `roomName`: the room's name for the export files (#34), null without one. */
export function RoomHistoryButton({ roomName }: { roomName: string | null }) {
  const t = useT();
  const inRoom = useRoomStore(
    (state) => state.status !== "error" && (state.snapshot?.room.you ?? null) !== null,
  );
  const button = useRef<HTMLButtonElement>(null);
  const [panel, setPanel] = useState<PanelModule | null>(null);
  const [open, setOpen] = useState(false);
  if (!inRoom) return null;

  async function show() {
    if (panel !== null) {
      setOpen(true);
      return;
    }
    try {
      const module = await loadPanel();
      setPanel(module);
      setOpen(true);
    } catch {
      const message = t("history.loadFailed");
      import("sonner")
        .then(({ toast }) => toast(message, { id: "history-failed" }))
        .catch(() => {});
    }
  }

  const Panel = panel?.HistoryPanel;
  return (
    <>
      <Button
        ref={button}
        variant="outline"
        aria-haspopup="dialog"
        aria-expanded={open}
        data-history-open
        // An icon below 900 px, as "Room rules" is: its name stays for screen readers.
        className="shrink-0 max-[900px]:size-11 max-[900px]:has-[>svg]:px-0"
        onClick={show}
      >
        <HistoryIcon aria-hidden />
        <span className="max-[900px]:sr-only">{t("history.open")}</span>
      </Button>
      {Panel ? (
        <Panel open={open} onOpenChange={setOpen} returnFocus={button} roomName={roomName} />
      ) : null}
    </>
  );
}
