import { ListOrderedIcon } from "lucide-react";
import { useRef, useState } from "react";
import { reloadAction } from "../components/shell/reload-action.ts";
import { Button } from "../components/ui/button.tsx";
import { useT } from "../i18n/hooks.ts";

type PanelModule = typeof import("./queue-panel.tsx");

/** The panel's code: a chunk of its own, loaded on the first open. */
const loadPanel = () => import("./queue-panel.tsx");

/**
 * "Queue", beside the PO's subject field (#52): where the next round's subject is chosen.
 * Only the PO has the field, so only the PO has this; everyone else's room looks as it
 * did. The first press loads the panel's chunk, as "History" does, and a failed load says
 * so in a toast. `count`: how many items wait, shown once there are any.
 */
export function RoomQueueButton({ count }: { count: number }) {
  const t = useT();
  const button = useRef<HTMLButtonElement>(null);
  const [panel, setPanel] = useState<PanelModule | null>(null);
  const [open, setOpen] = useState(false);

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
      const message = t("queue.loadFailed");
      import("sonner")
        .then(({ toast }) => toast(message, { id: "queue-failed", action: reloadAction(t) }))
        .catch(() => {});
    }
  }

  const Panel = panel?.QueuePanel;
  return (
    <>
      <Button
        ref={button}
        type="button"
        variant="outline"
        aria-haspopup="dialog"
        aria-expanded={open}
        data-queue-open
        // An icon below 900 px, as "History" is: its name stays for screen readers.
        className="shrink-0 max-[900px]:min-w-11 max-[900px]:px-2"
        onClick={show}
      >
        <ListOrderedIcon aria-hidden />
        <span className="max-[900px]:sr-only">{t("queue.open")}</span>
        {count > 0 ? (
          <>
            <span aria-hidden data-queue-count className="font-mono text-xs tabular-nums">
              {count}
            </span>
            {/* The space keeps the name and the count apart in the button's name. */}{" "}
            <span className="sr-only">{t("queue.count", { count })}</span>
          </>
        ) : null}
      </Button>
      {Panel ? <Panel open={open} onOpenChange={setOpen} returnFocus={button} /> : null}
    </>
  );
}
