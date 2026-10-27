import type { RoomView } from "@pp/protocol";
import { useState } from "react";
import { Button } from "../components/ui/button.tsx";
import { useT } from "../i18n/hooks.ts";
import { sendCommand } from "../realtime/room-connection.ts";
import { voteCount } from "./table-data.ts";

interface RoundCentreProps {
  /** The room as the viewer sees it, their unconfirmed pick included. */
  room: RoomView;
  /** A refused start, as an error code, or null when a new attempt begins. */
  onFailure: (code: string | null) => void;
}

/**
 * The status in the middle of the table (#18). Voting: how many have voted out of how
 * many can vote (#19 adds the reveal button here). Lobby or revealed: a minimal start
 * button for the PO, which sends `startRound` without a subject, and a calm line for
 * everyone else. #21 replaces `StartRound` with "Next round" and its subject field; #20
 * puts the results here after a reveal.
 */
export function RoundCentre({ room, onFailure }: RoundCentreProps) {
  const t = useT();
  const round = room.round;
  if (round?.phase === "voting") {
    const { count, total } = voteCount(room);
    return (
      <p data-centre-status="voting" tabIndex={-1} className="m-0 outline-none">
        {t("table.votedSoFar", { count, total })}
      </p>
    );
  }
  if (room.you !== null && room.you === room.ownerId) {
    return <StartRound again={round !== null} onFailure={onFailure} />;
  }
  return (
    <p data-centre-status={round === null ? "lobby" : "revealed"} className="m-0">
      {round === null ? t("round.waiting") : t("round.revealed")}
    </p>
  );
}

/**
 * The button is gone once the round starts, and the focus with it: it goes to the hand's
 * tab stop, or to the centre's status for a PO without a hand. The snapshot is already in
 * the store when the ack resolves; the frame waits for React to draw it.
 */
function focusAfterStart() {
  requestAnimationFrame(() => {
    // Someone who already moved on keeps their focus.
    const active = document.activeElement;
    if (active !== null && active !== document.body) return;
    const target =
      document.querySelector<HTMLElement>("[data-hand] [tabindex='0']") ??
      document.querySelector<HTMLElement>("[data-centre-status='voting']");
    target?.focus();
  });
}

function StartRound({
  again,
  onFailure,
}: {
  again: boolean;
  onFailure: (code: string | null) => void;
}) {
  const t = useT();
  const [busy, setBusy] = useState(false);

  async function start() {
    // Focusable while busy (aria-disabled), so a second press lands here.
    if (busy) return;
    setBusy(true);
    onFailure(null);
    try {
      const ack = await sendCommand({ type: "startRound", payload: { subject: { kind: "none" } } });
      if (ack.ok) focusAfterStart();
      else onFailure(ack.code);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Button
      data-start-round
      variant="outline"
      aria-disabled={busy || undefined}
      onClick={start}
      className="h-auto min-h-11 max-w-full border-card-edge bg-card-face px-3 py-1.5 text-[12.5px]/tight font-semibold whitespace-normal text-card-ink shadow-md hover:bg-card-face hover:text-card-ink aria-disabled:opacity-60 in-data-[variant=phone]:px-1.5 in-data-[variant=phone]:text-[11px]/tight dark:bg-card-face dark:hover:bg-card-face"
    >
      {again ? t("round.next") : t("round.start")}
    </Button>
  );
}
