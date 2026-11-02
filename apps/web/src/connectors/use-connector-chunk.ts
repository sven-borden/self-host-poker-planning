import type { ConnectorName } from "@pp/protocol";
import { useEffect, useState } from "react";
import { reloadAction } from "../components/shell/reload-action.ts";
import { useT } from "../i18n/hooks.ts";
import { SYSTEM_NAMES } from "./connector.ts";

/**
 * A tracker's chunk, once it is `wanted`. Not `lazy`: a chunk that cannot load, as on a tab left
 * open across a deploy, must not reach the error boundary and take the room with it, since
 * estimating never depends on a tracker. A failed load says so in a toast, and the page goes on.
 */
export function useConnectorChunk<T>(
  wanted: boolean,
  load: () => Promise<T>,
  name: ConnectorName = "jira",
): T | null {
  const t = useT();
  const [chunk, setChunk] = useState<T | null>(null);
  useEffect(() => {
    if (!wanted) return;
    let live = true;
    load().then(
      (module) => {
        if (live) setChunk(() => module);
      },
      () => {
        if (!live) return;
        const message = t("connector.loadFailed", { system: SYSTEM_NAMES[name] });
        import("sonner")
          .then(({ toast }) => toast(message, { id: "connector-failed", action: reloadAction(t) }))
          .catch(() => {});
      },
    );
    return () => {
      live = false;
    };
  }, [wanted, load, t, name]);
  return chunk;
}
