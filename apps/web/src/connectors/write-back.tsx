import type { ConnectorName, RoundView } from "@pp/protocol";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "../components/ui/button.tsx";
import { useT } from "../i18n/hooks.ts";
import { RoomApiError } from "../rooms/api.ts";
import { connectorMessage, ROUND_SYSTEMS, SYSTEM_NAMES } from "./connector.ts";
import { ConnectorAlert } from "./connector-alert.tsx";
import { writeBack } from "./connector-api.ts";
import { takeFinalPress } from "./final-press.ts";

/** One round's estimate on its way to the tracker. */
interface Line {
  round: number;
  label: string;
  card: string;
  state: "waiting" | "writing" | "written" | "failed" | "kept";
  code?: string;
  retryAfter?: number;
}

/** A final with no number, or an item with no estimate: a press cannot change it, no "Try again". */
const OUTCOME_CODES: ReadonlySet<string> = new Set([
  "connector_not_numeric",
  "connector_no_estimate_field",
]);

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
 * sends is the round's number.
 *
 * Only a final this very tab recorded goes by itself (`final-press.ts`): the write carries the
 * PO's token, so nothing but the PO's own press here may start it. Any other final, whoever set
 * it and however it got here, waits for a press. The rule holds here and not in a parent, which
 * can only know who is PO now: a tab asleep through a hand-over never saw the role leave.
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

  const revealed =
    round?.phase === "revealed" && round.system === ROUND_SYSTEMS[name] ? round : null;
  const number = round?.number;
  useEffect(() => {
    if (revealed === null || revealed.final === undefined) return;
    const { final, number: asked, startedAt } = revealed;
    const pressed = takeFinalPress(code, revealed, final);
    const id = `${asked}:${startedAt}:${final}`;
    if (!pressed && sent.current === id) return;
    sent.current = id;
    const target = { round: asked, label: subjectLabel(revealed), card: final };
    if (pressed) void send(target);
    else {
      setLines((now) => [
        ...now.filter((each) => each.round !== asked),
        { ...target, state: "waiting" },
      ]);
    }
  }, [code, revealed, send]);

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
            <ConnectorAlert>
              {t("connector.write.failed", { item: line.label, card: line.card, system })}{" "}
              {connectorMessage(t, line.code ?? "unknown", name, line.retryAfter)}
            </ConnectorAlert>
          ) : (
            <p role="status" className="m-0 text-ink-2">
              {line.state === "writing"
                ? t("connector.write.writing", { item: line.label, card: line.card, system })
                : line.state === "waiting"
                  ? t("connector.write.waiting", { item: line.label, card: line.card, system })
                  : t("connector.write.written", { item: line.label, card: line.card, system })}
            </p>
          )}
          {line.state === "waiting" ? (
            <Button variant="outline" data-write-now onClick={() => void send(line)}>
              {t("connector.write.history", { system })}
            </Button>
          ) : null}
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
