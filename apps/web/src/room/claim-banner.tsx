import { OWNER_CLAIM_AFTER_MS } from "@pp/domain";
import type { ParticipantView, RoomView } from "@pp/protocol";
import { CrownIcon, OctagonXIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "../components/ui/button.tsx";
import { useT } from "../i18n/hooks.ts";
import { commandSender } from "../realtime/room-connection.ts";
import { useRoomStore } from "../stores/room-store.ts";
import { codeOf, failureMessage } from "./failure.ts";
import { focusSoon } from "./round-centre.tsx";

/** How long a refused claim's reason stays, with the button hidden. */
export const CLAIM_REFUSAL_MS = 8000;

interface ClaimBannerProps {
  room: RoomView;
  /** The viewer as the snapshot lists them. */
  me: ParticipantView;
  /** The PO's name as the room shows it ("Ana (2)"), or null when the PO is not in the room. */
  ownerName: string | null;
}

/**
 * The server's clock minus this browser's, from the newest snapshot's `serverNow`: the
 * claim opens by the server's clock, whatever the time on this computer.
 */
function useServerOffset(): number {
  const snapshot = useRoomStore((state) => state.snapshot);
  return useMemo(() => (snapshot ? snapshot.serverNow - Date.now() : 0), [snapshot]);
}

/**
 * The claim (#30, ADR-010): once the PO has been away for two minutes, or at once when
 * the PO is not in the room, everyone else gets a banner above the table, "Ana, the
 * product owner, is away.", with "Claim the product owner role". The server decides: it
 * sends `ownerClaimableAt` only then, and this shows the button from that moment by the
 * server's clock. The first claim wins; for the others the banner goes with the snapshot
 * that names the new PO. A claim refused because the PO is still here (`owner_present`:
 * back, or this clock ran ahead) hides the button and says "Not yet" for a while.
 *
 * The status line stays mounted, empty, while there is nothing to claim, so a screen
 * reader hears the banner when it appears.
 */
export function ClaimBanner({ room, me, ownerName }: ClaimBannerProps) {
  const t = useT();
  const offset = useServerOffset();
  const at = room.ownerClaimableAt;
  const [now, setNow] = useState(() => Date.now());
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const refusalTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // Wakes up when the claim opens by the server's clock.
  useEffect(() => {
    if (at === undefined) return;
    const wait = at - (Date.now() + offset);
    if (wait <= 0) {
      setNow(Date.now());
      return;
    }
    const timer = setTimeout(() => setNow(Date.now()), Math.min(wait + 20, 2 ** 31 - 1));
    return () => clearTimeout(timer);
  }, [at, offset]);

  useEffect(() => () => clearTimeout(refusalTimer.current), []);

  const claimable = at !== undefined && !me.isOwner && now + offset >= at;
  const shown = (claimable && refusal === null) || refusal !== null;

  async function claim() {
    if (busy) return;
    const send = commandSender();
    const ownerBefore = room.ownerId;
    setBusy(true);
    let code: string | null = null;
    try {
      const ack = await send({ type: "claimOwner" });
      if (!ack.ok) code = ack.code;
    } catch (error) {
      code = codeOf(error);
    }
    setBusy(false);
    if (code === null) {
      // The banner goes with the button: the new PO's subject field takes the focus.
      focusSoon("[data-next-subject] input");
      return;
    }
    // Someone else claimed first: the room already shows them, and the live region says so.
    if (
      code === "owner_present" &&
      useRoomStore.getState().snapshot?.room.ownerId !== ownerBefore
    ) {
      return;
    }
    setRefusal(
      code === "owner_present"
        ? t("claim.notYet", { minutes: OWNER_CLAIM_AFTER_MS / 60_000 })
        : failureMessage(t, code),
    );
    clearTimeout(refusalTimer.current);
    refusalTimer.current = setTimeout(() => setRefusal(null), CLAIM_REFUSAL_MS);
  }

  const text =
    claimable && refusal === null
      ? ownerName === null
        ? t("claim.gone")
        : t("claim.away", { name: ownerName })
      : "";

  return (
    <div
      data-claim={shown || undefined}
      className={
        shown
          ? "flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl border border-line bg-surface-2 px-4 py-3"
          : "contents"
      }
    >
      {shown ? (
        <span
          aria-hidden="true"
          className="grid size-7 shrink-0 place-items-center rounded-full bg-brass-soft text-brass-ink"
        >
          <CrownIcon className="size-4" strokeWidth={2.5} />
        </span>
      ) : null}
      <p role="status" className={shown && text !== "" ? "m-0 min-w-0 flex-1" : "sr-only"}>
        {text}
      </p>
      {claimable && refusal === null ? (
        <Button
          className="aria-disabled:pointer-events-none aria-disabled:opacity-50 phone:w-full"
          aria-disabled={busy || undefined}
          onClick={claim}
        >
          {busy ? t("claim.claiming") : t("claim.button")}
        </Button>
      ) : null}
      {refusal !== null ? (
        <p role="alert" className="m-0 flex min-w-0 flex-1 items-start gap-2 text-sm">
          <OctagonXIcon aria-hidden className="mt-0.5 size-4 shrink-0 text-bad" />
          {refusal}
        </p>
      ) : null}
    </div>
  );
}
