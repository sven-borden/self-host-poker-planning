import type { ConnectorName, RoundView } from "@pp/protocol";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "../components/ui/button.tsx";
import { useT } from "../i18n/hooks.ts";
import { RoomApiError } from "../rooms/api.ts";
import { connectorMessage, SYSTEM_NAMES } from "./connector.ts";
import { writeBack } from "./connector-api.ts";

/** One round's estimate on its way to the tracker. */
interface Line {
  round: number;
  label: string;
  card: string;
  state: "writing" | "written" | "failed" | "kept";
  code?: string;
  retryAfter?: number;
}

/** A final with no number stays here for a reason a press cannot change: no "Try again". */
const OUTCOME_CODES: ReadonlySet<string> = new Set(["connector_not_numeric"]);

function subjectLabel(round: RoundView): string {
  const { subject } = round;
  if (subject.kind === "link") return subject.key ?? subject.title ?? subject.url;
  return subject.kind === "title" ? subject.text : "";
}

/**
 * The estimates of rounds that came from a tracker (#54, ADR-030), under the table, for the PO:
 * a recorded final goes to the tracker by itself, and this says how it went. Nothing here touches
 * the round: a failure stays as a line with "Try again" while the room moves on, and a countdown
 * to the next item changes nothing. The server reads the final and the item itself: all this
 * sends is the round's number. Writing twice is harmless, so two tabs or a reload may.
 */
export function WriteBackLines({
  code,
  round,
  name = "jira",
}: {
  code: string;
  round: RoundView | null;
  name?: ConnectorName;
}) {
  const t = useT();
  const [lines, setLines] = useState<readonly Line[]>([]);
  const sent = useRef("");
  const system = SYSTEM_NAMES[name];

  const send = useCallback(
    async (target: Pick<Line, "round" | "label" | "card">) => {
      const put = (line: Line) =>
        setLines((now) => [...now.filter((each) => each.round !== line.round), line]);
      put({ ...target, state: "writing" });
      try {
        await writeBack(name, code, target.round);
        put({ ...target, state: "written" });
      } catch (error) {
        const failure = error instanceof RoomApiError ? error : new RoomApiError("unknown");
        put({
          ...target,
          state: OUTCOME_CODES.has(failure.code) ? "kept" : "failed",
          code: failure.code,
          ...(failure.retryAfter === undefined ? {} : { retryAfter: failure.retryAfter }),
        });
      }
    },
    [code, name],
  );

  const final = round?.phase === "revealed" ? round.final : undefined;
  const number = round?.number;
  const fromTracker = round?.system === "jira";
  const label = round === null ? "" : subjectLabel(round);
  useEffect(() => {
    if (!fromTracker || final === undefined || number === undefined) return;
    const id = `${number}:${final}`;
    if (sent.current === id) return;
    sent.current = id;
    void send({ round: number, label, card: final });
  }, [fromTracker, final, number, label, send]);

  // A word of success belongs to the round it speaks of; a failure stays until it is dealt with.
  useEffect(() => {
    setLines((now) =>
      now.filter(
        (line) => line.round === number || line.state === "failed" || line.state === "writing",
      ),
    );
  }, [number]);

  if (lines.length === 0) return null;
  return (
    <ul data-write-back className="m-0 mt-3 flex list-none flex-col items-center gap-1 p-0">
      {lines.map((line) => (
        <li
          key={line.round}
          data-write-line={line.state}
          className="flex flex-wrap items-center justify-center gap-x-2 text-center text-sm"
        >
          {line.state === "failed" || line.state === "kept" ? (
            <p role="alert" className="m-0">
              {t("connector.write.failed", { item: line.label, card: line.card, system })}{" "}
              {connectorMessage(t, line.code ?? "unknown", name, line.retryAfter)}
            </p>
          ) : (
            <p role="status" className="m-0 text-ink-2">
              {line.state === "writing"
                ? t("connector.write.writing", { item: line.label, card: line.card, system })
                : t("connector.write.written", { item: line.label, card: line.card, system })}
            </p>
          )}
          {line.state === "failed" ? (
            <>
              <Button variant="outline" data-write-retry onClick={() => void send(line)}>
                {t("connector.write.retry")}
              </Button>
              <Button
                variant="ghost"
                data-write-dismiss
                onClick={() => setLines((now) => now.filter((each) => each.round !== line.round))}
              >
                {t("connector.write.dismiss")}
              </Button>
            </>
          ) : null}
        </li>
      ))}
    </ul>
  );
}
