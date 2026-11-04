import { ListOrderedIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { reloadAction } from "../components/shell/reload-action.ts";
import { Button } from "../components/ui/button.tsx";
import { clearConnectorResult, connectorResult } from "../connectors/connector.ts";
import { useT } from "../i18n/hooks.ts";
import { loadCopy } from "../i18n/i18n.ts";

type PanelModule = typeof import("./queue-panel.tsx");

/**
 * The panel's code and its words in the page's language (U6): a chunk each, loaded on the first
 * open, and the panel shows once both are in, so it never shows a key or English first.
 */
const loadPanel = () =>
  Promise.all([import("./queue-panel.tsx"), loadCopy("queue")]).then(([module]) => module);

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

  // Back from a tracker (#54): the sheet the PO left from opens, and says how it went.
  useEffect(() => {
    if (connectorResult() === null) return;
    loadPanel()
      .then((module) => {
        setPanel(module);
        setOpen(true);
      })
      .catch(() => {});
  }, []);

  function changeOpen(next: boolean) {
    if (!next) clearConnectorResult();
    setOpen(next);
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
      {Panel ? <Panel open={open} onOpenChange={changeOpen} returnFocus={button} /> : null}
    </>
  );
}
