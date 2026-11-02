import type { ConnectorName, HistoryRoundView } from "@pp/protocol";
import { useState } from "react";
import { Button } from "../components/ui/button.tsx";
import { useT } from "../i18n/hooks.ts";
import { RoomApiError } from "../rooms/api.ts";
import { useRoomStore } from "../stores/room-store.ts";
import { connectorMessage, connectorOn, SYSTEM_NAMES } from "./connector.ts";
import { ConnectorAlert } from "./connector-alert.tsx";
import { writeBack } from "./connector-api.ts";

/**
 * "Write to Jira" on a past round, for the PO (#54, ADR-030): the way back to an estimate after a
 * reload took the room's line for it away. The server reads the final from the round's row.
 */
export function HistoryWrite({
  round,
  name = "jira",
}: {
  round: HistoryRoundView;
  name?: ConnectorName;
}) {
  const t = useT();
  const code = useRoomStore((state) => state.snapshot?.room.code);
  const isOwner = useRoomStore((state) => {
    const room = state.snapshot?.room;
    return room !== undefined && room.ownerId === room.you;
  });
  const [state, setState] = useState<"idle" | "writing" | "written">("idle");
  const [problem, setProblem] = useState<{ code: string; retryAfter?: number } | null>(null);
  const system = SYSTEM_NAMES[name];
  if (!isOwner || code === undefined || round.final === null) return null;
  if (round.system !== "jira" || !connectorOn(name)) return null;

  async function write(room: string) {
    setState("writing");
    setProblem(null);
    try {
      await writeBack(name, room, round.number);
      setState("written");
    } catch (error) {
      setState("idle");
      const failure = error instanceof RoomApiError ? error : new RoomApiError("unknown");
      setProblem({
        code: failure.code,
        ...(failure.retryAfter === undefined ? {} : { retryAfter: failure.retryAfter }),
      });
    }
  }

  return (
    <div data-history-write className="flex flex-col items-start gap-1">
      {state === "written" ? (
        <p role="status" className="m-0 text-sm text-ink-2">
          {t("connector.write.done", { system })}
        </p>
      ) : (
        <Button
          variant="outline"
          aria-disabled={state === "writing" || undefined}
          onClick={() => {
            if (state === "idle") void write(code);
          }}
        >
          {t("connector.write.history", { system })}
        </Button>
      )}
      {problem === null ? null : (
        <ConnectorAlert>
          {connectorMessage(t, problem.code, name, problem.retryAfter)}
        </ConnectorAlert>
      )}
    </div>
  );
}
