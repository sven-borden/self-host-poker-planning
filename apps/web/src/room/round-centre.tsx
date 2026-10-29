import type { RoomView } from "@pp/protocol";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Button } from "../components/ui/button.tsx";
import { useT } from "../i18n/hooks.ts";
import type { TFunction } from "../i18n/i18n.ts";
import { commandSender } from "../realtime/room-connection.ts";
import { failureMessage } from "./failure.ts";
import { focusAfterReveal, focusAfterVoterReveal } from "./focus.ts";
import type { NextRound } from "./next-round.tsx";
import { CentreResult, type RevealMotion } from "./results-chunk.tsx";
import { mayReveal, voteCount } from "./table-data.ts";
import {
  TimerChip,
  TimerControls,
  useCountdown,
  useLastSecondsWarning,
  useTimeUpPing,
} from "./timer.tsx";

interface RoundCentreProps {
  /** The room as the viewer sees it, their unconfirmed pick included. */
  room: RoomView;
  /** A refused reveal, as an error code, or null when a new attempt begins. */
  onFailure: (code: string | null) => void;
  /** The PO's first round (#21): the subject field's draft, sent by "Start voting". */
  next: NextRound;
  /** How the results arrive after a reveal (#20): live, and when the cards are settled. */
  reveal?: RevealMotion;
  /**
   * The id of the line under the table that says why a voter's reveal waits (#28: an
   * anonymous round with fewer than two cards down), or null when it does not wait.
   */
  wait?: string | null;
}

/**
 * The PO's buttons in the centre, drawn as a card face (warm face, card ink, 44 px tall).
 * Sized in px, like everything in the centre: the layout places the table in px, so a
 * larger text setting (rem) must not grow the centre into the slot cards (#37). On a phone
 * the face is 32 px tall and an invisible `::after` keeps the 44 px touch target, as the
 * timer's chip does, so the PO's stack (timer, count, button) fits inside the ring of slot
 * cards. On a dense phone table (11 to 16 people), whose ring is wider, the label keeps one
 * line ("Karten aufdecken") and may run wider than the centre's box, which centres it;
 * with fewer people the side cards come closer, and it wraps inside the box.
 * e2e/text-size.spec.ts and timer.spec.ts check that it stays clear of the cards.
 */
const CENTRE_BUTTON =
  "relative h-auto min-h-[44px] max-w-full border-card-edge bg-card-face px-[12px] py-[6px] text-[12.5px]/tight font-semibold whitespace-normal text-card-ink shadow-md hover:bg-card-face hover:text-card-ink aria-disabled:opacity-60 in-data-[variant=phone]:min-h-[32px] in-data-[variant=phone]:px-[4px] in-data-[variant=phone]:py-[4px] in-data-[variant=phone]:text-[10.5px]/tight in-data-[dense=phone]:max-w-none in-data-[dense=phone]:whitespace-nowrap in-data-[variant=phone]:after:absolute in-data-[variant=phone]:after:inset-x-0 in-data-[variant=phone]:after:-inset-y-[6px] dark:bg-card-face dark:hover:bg-card-face";

/**
 * The status in the middle of the table (#18). Voting: how many have voted out of how
 * many can vote, and for the PO the reveal button (#19, also the key R). Lobby: "Start
 * voting" for the PO and a calm line for everyone else. Revealed: the result (#20,
 * `CentreResult`, from the results chunk; the result as a sentence until it has loaded)
 * and the recorded final estimate (#32), the same for everyone; the PO's "Next round"
 * sits under the table with the final estimate's picker (`final-estimate.tsx`). "Start
 * voting" and "Next round" start the round with the subject in the PO's field above the
 * table (#21, `next-round.tsx`); a voting round offers neither, so the PO never abandons
 * one by a click.
 */
export function RoundCentre({
  room,
  onFailure,
  next,
  reveal = { live: false, settle: 0 },
  wait = null,
}: RoundCentreProps) {
  const t = useT();
  const round = room.round;
  const owner = room.you !== null && room.you === room.ownerId;
  if (round?.phase === "voting") {
    return <VotingCentre room={room} owner={owner} onFailure={onFailure} wait={wait} />;
  }
  if (round === null) {
    return owner ? (
      <StartRound next={next} />
    ) : (
      <p data-centre-status="lobby" className="m-0">
        {t("round.waiting")}
      </p>
    );
  }
  // After the reveal the PO's controls sit under the table (#32, `final-estimate.tsx`): the
  // centre shows the result, and the final estimate once recorded, the same for everyone.
  return <CentreResult room={room} motion={reveal} />;
}

export { focusAfterReveal, focusSoon } from "./focus.ts";

/**
 * What a refusal in the centre says under the table. `not_allowed` comes only from a
 * reveal there: a voter pressed "Reveal cards" as the PO took the reveal back (#28).
 */
export function centreFailureMessage(t: TFunction, code: string): string {
  return code === "not_allowed" ? t("round.revealOwnerOnly") : failureMessage(t, code);
}

/**
 * The centre while Voting: the timer when one runs (#27: the ring and the time left, or
 * "Time is up"), the count, and for the PO the timer's controls above the count and
 * "Reveal cards" under it. Under "anyone who votes" (#28) a voter's centre holds the same
 * "Reveal cards", where the PO's sits, under the timer's chip and the count. Without a
 * timer, anyone else reads the count alone.
 */
function VotingCentre({
  room,
  owner,
  onFailure,
  wait,
}: {
  room: RoomView;
  owner: boolean;
  onFailure: (code: string | null) => void;
  wait: string | null;
}) {
  const t = useT();
  const countdown = useCountdown(room.round);
  useLastSecondsWarning(countdown);
  useTimeUpPing(countdown);
  const { count, total } = voteCount(room);
  const reveals = mayReveal(room);
  const status = (
    // On a phone the count keeps the centre box's 68 px, however wide the timer above it.
    <p
      data-centre-status="voting"
      tabIndex={-1}
      className="m-0 outline-none in-data-[variant=phone]:max-w-[68px]"
    >
      {t("table.votedSoFar", { count, total })}
    </p>
  );
  if (!reveals) {
    if (countdown.state.kind === "none") return status;
    return (
      <div className="flex flex-col items-center gap-[6px] in-data-[variant=phone]:gap-[4px]">
        <TimerChip countdown={countdown} />
        {status}
      </div>
    );
  }
  return (
    <div className="flex flex-col items-center gap-[6px] in-data-[variant=phone]:gap-[2px] in-data-[variant=phone]:text-[10px]/tight">
      {owner ? (
        <TimerControls countdown={countdown} onFailure={onFailure} />
      ) : countdown.state.kind === "none" ? null : (
        <TimerChip countdown={countdown} />
      )}
      {status}
      <RevealButton owner={owner} onFailure={onFailure} wait={wait} />
    </div>
  );
}

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
 * "Reveal cards", for the PO while Voting (#19): always allowed, whoever has voted; and
 * under "anyone who votes" for every voter (#28). The key R does the same while the
 * button is on screen and the focus is on the table or the hand (`isRevealKey`); the
 * button's title says so. A refusal shows under the table (`not_allowed`: the PO took the
 * reveal back meanwhile, `centreFailureMessage`); `not_voting` says nothing, since the
 * round revealed itself in the meantime (the last vote) or a new one began. When the
 * button leaves while it has the focus (pressed, the last vote revealed the round, or the
 * PO took the reveal back), the focus goes to the PO's decision under the table
 * (`focusAfterReveal`), or for a voter to the result in the centre, else the count
 * (`focusAfterVoterReveal`). A voter's button in an anonymous round waits for a second
 * card (`wait`, #28): it stays in place, `aria-disabled` and described by the line under
 * the table that says why, and a press or R does nothing.
 */
function RevealButton({
  owner,
  onFailure,
  wait,
}: {
  owner: boolean;
  onFailure: (code: string | null) => void;
  wait: string | null;
}) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const button = useRef<HTMLButtonElement>(null);
  const focusAfter = useRef(focusAfterReveal);
  focusAfter.current = owner ? focusAfterReveal : focusAfterVoterReveal;
  const waiting = useRef(wait !== null);
  waiting.current = wait !== null;

  const reveal = useCallback(async () => {
    // Focusable while busy or waiting (aria-disabled), so a press lands here and is dropped.
    if (pending.current || waiting.current) return;
    pending.current = true;
    setBusy(true);
    onFailure(null);
    const send = commandSender();
    try {
      const ack = await send({ type: "reveal" });
      if (ack.ok) focusAfter.current();
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
      if (element !== null && document.activeElement === element) focusAfter.current();
    };
  }, []);

  return (
    <Button
      ref={button}
      data-reveal
      variant="outline"
      aria-keyshortcuts="R"
      title={t("round.revealKey")}
      aria-disabled={busy || wait !== null || undefined}
      aria-describedby={wait ?? undefined}
      onClick={() => void reveal()}
      className={CENTRE_BUTTON}
    >
      {t("round.reveal")}
    </Button>
  );
}

/** "Start voting": sends the PO's draft subject (`useNextRound`). */
function StartRound({ next }: { next: NextRound }) {
  const t = useT();
  return (
    <Button
      data-start-round
      variant="outline"
      aria-disabled={next.busy || undefined}
      onClick={() => void next.start()}
      className={CENTRE_BUTTON}
    >
      {t("round.start")}
    </Button>
  );
}
