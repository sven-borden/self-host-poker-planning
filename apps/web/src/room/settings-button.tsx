import { ListChecksIcon, SlidersHorizontalIcon } from "lucide-react";
import { useRef, useState } from "react";
import { Button } from "../components/ui/button.tsx";
import { useT } from "../i18n/hooks.ts";
import { useRoomStore } from "../stores/room-store.ts";

type PanelModule = typeof import("./settings-panel.tsx");

/** The panel's code: a chunk of its own, loaded on the first open. */
const loadPanel = () => import("./settings-panel.tsx");

/**
 * The room header's "Room settings" button for the PO, "Room rules" for everyone else
 * (#25). It shows once a snapshot is there; the first press loads the panel's chunk, which
 * then stays mounted (closed) so the sheet can animate out and in again. A failed load (an
 * old chunk gone after a redeploy) says so in a toast and leaves the page as it was.
 */
export function RoomSettingsButton() {
  const t = useT();
  const room = useRoomStore((state) =>
    state.status === "error" ? undefined : state.snapshot?.room,
  );
  const button = useRef<HTMLButtonElement>(null);
  const [panel, setPanel] = useState<PanelModule | null>(null);
  const [open, setOpen] = useState(false);
  if (room === undefined) return null;
  const owner = room.you !== null && room.you === room.ownerId;
  const label = t(owner ? "settings.openOwner" : "settings.openOthers");

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
      const message = t("settings.loadFailed");
      // The toaster is lazy too; when it cannot load either, the page is out of date and
      // a reload is the answer whatever this button says.
      import("sonner")
        .then(({ toast }) => toast(message, { id: "settings-failed" }))
        .catch(() => {});
    }
  }

  const Panel = panel?.SettingsPanel;
  return (
    <>
      <Button
        ref={button}
        variant="outline"
        aria-haspopup="dialog"
        aria-expanded={open}
        data-settings-open={owner ? "owner" : "rules"}
        // An icon below 900 px, as "Copy the link" is on a phone: two labelled buttons
        // would squeeze a long room name. The name stays, for screen readers.
        className="shrink-0 max-[900px]:size-11 max-[900px]:has-[>svg]:px-0"
        onClick={show}
      >
        {owner ? <SlidersHorizontalIcon aria-hidden /> : <ListChecksIcon aria-hidden />}
        <span className="max-[900px]:sr-only">{label}</span>
      </Button>
      {Panel ? <Panel open={open} onOpenChange={setOpen} returnFocus={button} /> : null}
    </>
  );
}
