import type { RoomView } from "@pp/protocol";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Button } from "../components/ui/button.tsx";
import { useT } from "../i18n/hooks.ts";
import { commandSender, sendCommand } from "../realtime/room-connection.ts";
import { CentreResult, type RevealMotion } from "./results-chunk.tsx";
import { voteCount } from "./table-data.ts";

interface RoundCentreProps {
  /** The room as the viewer sees it, their unconfirmed pick included. */
  room: RoomView;
  /** A refused start or reveal, as an error code, or null when a new attempt begins. */
  onFailure: (code: string | null) => void;
  /** How the results arrive after a reveal (#20): live, and when the cards are settled. */
  reveal?: RevealMotion;
}

/** The PO's buttons in the centre, drawn as a card face (warm face, card ink, 44 px tall). */
const CENTRE_BUTTON =
  "h-auto min-h-11 max-w-full border-card-edge bg-card-face px-3 py-1.5 text-[12.5px]/tight font-semibold whitespace-normal text-card-ink shadow-md hover:bg-card-face hover:text-card-ink aria-disabled:opacity-60 in-data-[variant=phone]:px-1.5 in-data-[variant=phone]:text-[11px]/tight dark:bg-card-face dark:hover:bg-card-face";

/**
 * The status in the middle of the table (#18). Voting: how many have voted out of how
 * many can vote, and for the PO the reveal button (#19, also the key R). Lobby: a minimal
 * start button for the PO, which sends `startRound` without a subject, and a calm line for
 * everyone else. Revealed: the result (#20, `CentreResult`, from the results chunk; the
 * result as a sentence until it has loaded), and for the PO "Next round" under it. #21 replaces
 * `StartRound` with "Next round" and its subject field.
 */
export function RoundCentre({
  room,
  onFailure,
  reveal = { live: false, settle: 0 },
}: RoundCentreProps) {
  const t = useT();
  const round = room.round;
  const owner = room.you !== null && room.you === room.ownerId;
  if (round?.phase === "voting") {
    const { count, total } = voteCount(room);
    const status = (
      <p data-centre-status="voting" tabIndex={-1} className="m-0 outline-none">
        {t("table.votedSoFar", { count, total })}
      </p>
    );
    if (!owner) return status;
    return (
      <div className="flex flex-col items-center gap-1.5 in-data-[variant=phone]:gap-0.5 in-data-[variant=phone]:text-[10px]/tight">
        {status}
        <RevealButton onFailure={onFailure} />
      </div>
    );
  }
  if (round === null) {
    return owner ? (
      <StartRound again={false} onFailure={onFailure} />
    ) : (
      <p data-centre-status="lobby" className="m-0">
        {t("round.waiting")}
      </p>
    );
  }
  const result = <CentreResult room={room} compact={owner} motion={reveal} />;
  if (!owner) return result;
  // The seam #21 replaces: "Next round" under the result.
  return (
    <div className="flex flex-col items-center gap-1.5 in-data-[variant=phone]:gap-0.5">
      {result}
      <StartRound again onFailure={onFailure} />
    </div>
  );
}

/**
 * Once the screen changed under the focus, it goes to `selector`, after a frame for React
 * to draw it, unless the person already moved it somewhere.
 */
function focusSoon(...selectors: string[]) {
  requestAnimationFrame(() => {
    const active = document.activeElement;
    if (active !== null && active !== document.body) return;
    for (const selector of selectors) {
      const target = document.querySelector<HTMLElement>(selector);
      if (target) {
        target.focus();
        return;
      }
    }
  });
}

/**
 * The button is gone once the round starts, and the focus with it: it goes to the hand's
 * tab stop, or to the centre's status for a PO without a hand. The snapshot is already in
 * the store when the ack resolves; the frame waits for React to draw it.
 */
const focusAfterStart = () =>
  focusSoon("[data-hand] [tabindex='0']", "[data-centre-status='voting']");

/** After the reveal the PO's next step is the next round: the focus goes to its button. */
const focusAfterReveal = () => focusSoon("[data-start-round]");

/** Fields where R is a letter being typed, not the reveal. */
const NOT_TYPING = new Set([
  "button",
  "checkbox",
  "radio",
  "submit",
  "reset",
  "range",
  "color",
  "file",
  "image",
]);

/** Where R reveals: the table (its centre included) and the hand. */
const REVEAL_SCOPE = "[data-room-table], [data-room-hand]";

/** Where R belongs to something else: menus, listboxes, dialogs and popovers. */
const OTHER_WIDGETS =
  "[role='menu'], [role='menubar'], [role='listbox'], [role='dialog'], [role='alertdialog']";

/** Typing in a field, where R is a letter. */
function isField(target: HTMLElement): boolean {
  if (target.isContentEditable) return true;
  if (target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return true;
  return target instanceof HTMLInputElement && !NOT_TYPING.has(target.type);
}

/**
 * The key R alone reveals (docs/03-design-brief.md, "Accessibility"), but only while the
 * focus is on the table, its centre or the hand: a single-key shortcut scoped to the
 * part of the page it acts on (WCAG 2.1.4), so R on the header, the page or the PO's
 * panel does nothing. Never with a modifier, a held key's repeats, inside a field where
 * it is a letter, in a menu, listbox, dialog or popover (a seat's), while an input method
 * composes, or when something else already used the key.
 */
export function isRevealKey(event: KeyboardEvent): boolean {
  if (event.key !== "r" && event.key !== "R") return false;
  if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return false;
  if (event.repeat || event.isComposing || event.defaultPrevented) return false;
  const target = event.target;
  if (!(target instanceof HTMLElement) || isField(target)) return false;
  return target.closest(REVEAL_SCOPE) !== null && target.closest(OTHER_WIDGETS) === null;
}

/**
 * "Reveal cards", for the PO while Voting (#19): always allowed, whoever has voted. The
 * key R does the same while the button is on screen and the focus is on the table or the
 * hand (`isRevealKey`); the button's title says so. A refusal shows under the table;
 * `not_voting` says nothing, since the round revealed itself in the meantime (the last
 * vote) or a new one began. When the button leaves with the voting round while it has the
 * focus (pressed, or the last vote revealed the round), the focus goes to "Next round".
 */
function RevealButton({ onFailure }: { onFailure: (code: string | null) => void }) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const button = useRef<HTMLButtonElement>(null);

  const reveal = useCallback(async () => {
    // Focusable while busy (aria-disabled), so a second press lands here and is dropped.
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    onFailure(null);
    const send = commandSender();
    try {
      const ack = await send({ type: "reveal" });
      if (ack.ok) focusAfterReveal();
      else if (ack.code !== "not_voting") onFailure(ack.code);
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }, [onFailure]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!isRevealKey(event)) return;
      event.preventDefault();
      void reveal();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [reveal]);

  // A layout cleanup runs while the button is still in the document, focus included.
  useLayoutEffect(() => {
    const element = button.current;
    return () => {
      if (element !== null && document.activeElement === element) focusAfterReveal();
    };
  }, []);

  return (
    <Button
      ref={button}
      data-reveal
      variant="outline"
      aria-keyshortcuts="R"
      title={t("round.revealKey")}
      aria-disabled={busy || undefined}
      onClick={() => void reveal()}
      className={CENTRE_BUTTON}
    >
      {t("round.reveal")}
    </Button>
  );
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
      className={CENTRE_BUTTON}
    >
      {again ? t("round.next") : t("round.start")}
    </Button>
  );
}
