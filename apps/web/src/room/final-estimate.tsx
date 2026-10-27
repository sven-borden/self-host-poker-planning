import { CheckIcon } from "lucide-react";
import { type KeyboardEvent, useId, useRef, useState } from "react";
import { Button } from "../components/ui/button.tsx";
import { useT } from "../i18n/hooks.ts";
import { cn } from "../lib/utils.ts";
import { commandSender } from "../realtime/room-connection.ts";
import { CARD_FACE, CardValue, cardLabel } from "../table/cards.tsx";
import type { NextRound } from "./next-round.tsx";
import { type FinalChoice, finalChoice, type RevealedRound } from "./results-view.ts";
import { focusSoon } from "./round-centre.tsx";

// The PO's decision after a reveal (#32), right under the table: the final estimate
// (a radio group of the round's cards, the suggestion preselected), "Record 8", then
// "Next round" and "Vote again". In that order for the keyboard too: the result is read in
// the centre, then the PO records, then moves on. The table's centre shows the recorded
// final to everyone (`results.tsx`); this bar is the PO's alone.

interface DecisionProps {
  round: RevealedRound;
  /** The PO's next round (#21): its draft subject, sent by "Next round". */
  next: NextRound;
  /** A refused command, as an error code, or null when a new attempt begins. */
  onFailure: (code: string | null) => void;
}

/** A held Enter or Space repeats: only a fresh press records or starts anything. */
function dropRepeats(event: KeyboardEvent) {
  if (event.repeat && (event.key === "Enter" || event.key === " ")) event.preventDefault();
}

/**
 * Recording is explicit: nothing is sent until the PO presses "Record". The suggested card
 * is preselected, so recording it takes one press; on a tie, or with nothing to count,
 * nothing is, and the button waits for a pick. Once recorded the button reads "Recorded"
 * until the PO picks another card, which changes the final while the round stays revealed.
 * "Vote again" starts a new round on the same subject (the domain's `revote`): the revealed
 * round stays in history with its votes, so it asks for no confirmation.
 */
export function Decision({ round, next, onFailure }: DecisionProps) {
  const t = useT();
  const ids = { name: useId(), hint: useId() };
  const choice = finalChoice(round);
  /** The PO's own pick, until the server records it: then the picker follows `final`. */
  const [picked, setPicked] = useState<string | null>(null);
  const selected = picked ?? choice.preselected;
  const recorded = selected !== null && selected === round.final;
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);

  async function send(command: Parameters<ReturnType<typeof commandSender>>[0]) {
    // Focusable while busy (aria-disabled), so a second press lands here and is dropped.
    if (pending.current) return null;
    pending.current = true;
    setBusy(true);
    onFailure(null);
    try {
      const ack = await commandSender()(command);
      if (!ack.ok) onFailure(ack.code);
      return ack.ok;
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }

  async function record() {
    if (selected === null || recorded) return;
    if (await send({ type: "setFinal", payload: { card: selected } })) setPicked(null);
  }

  async function revote() {
    // The bar leaves with the revealed round: the focus goes to the hand, as after "Next round".
    if (await send({ type: "revote" })) {
      focusSoon("[data-hand] [tabindex='0']", "[data-centre-status='voting']");
    }
  }

  return (
    <div
      data-decision
      className="mt-4 flex flex-wrap items-end justify-center gap-x-6 gap-y-3 phone:mt-3"
    >
      <Picker
        choice={choice}
        name={ids.name}
        selected={selected}
        describedBy={selected === null ? ids.hint : undefined}
        onPick={setPicked}
      />
      <div className="flex flex-wrap items-center justify-center gap-2">
        <Button
          data-record-final
          aria-disabled={selected === null || recorded || busy || undefined}
          onKeyDown={dropRepeats}
          onClick={() => void record()}
          className="aria-disabled:cursor-default aria-disabled:opacity-60"
        >
          {recorded ? (
            <>
              <CheckIcon aria-hidden />
              {t("final.recorded")}
            </>
          ) : selected === null ? (
            t("final.recordNothing")
          ) : (
            t("final.record", { card: cardLabel(t, selected) })
          )}
        </Button>
        <Button
          data-start-round
          variant="outline"
          aria-disabled={next.busy || busy || undefined}
          onKeyDown={dropRepeats}
          onClick={() => {
            if (!busy) void next.start();
          }}
        >
          {t("round.next")}
        </Button>
        <Button
          data-revote
          variant="ghost"
          aria-disabled={busy || next.busy || undefined}
          onKeyDown={dropRepeats}
          onClick={() => {
            if (!next.busy) void revote();
          }}
        >
          {t("round.revote")}
        </Button>
      </div>
      {selected === null ? (
        <p id={ids.hint} className="m-0 w-full text-center text-sm text-ink-2">
          {t("final.pick")}
        </p>
      ) : null}
    </div>
  );
}

interface PickerProps {
  choice: FinalChoice;
  name: string;
  selected: string | null;
  describedBy: string | undefined;
  onPick: (card: string) => void;
}

/**
 * A native radio group with a visible label: arrow keys move and pick, Tab leaves it. Each
 * radio covers its card, so a tap or a click lands on the input itself. Cards are 36 × 48
 * (32 × 44 on phones, a whole touch target) and wrap when the deck is long. The suggested
 * card and the tied cards say so to screen readers; a tie is marked on the cards as well.
 */
function Picker({ choice, name, selected, describedBy, onPick }: PickerProps) {
  const t = useT();
  return (
    <fieldset data-final-picker aria-describedby={describedBy} className="m-0 min-w-0 border-0 p-0">
      <legend className="mb-2 w-full p-0 text-center text-sm font-medium">
        {t("final.label")}
      </legend>
      <div className="flex flex-wrap justify-center gap-1.5 pt-1.5 phone:gap-1">
        {choice.cards.map((card) => {
          const tied = choice.tied.includes(card);
          const label = cardLabel(t, card);
          return (
            <label
              key={card}
              data-final-card={card}
              data-tied={tied || undefined}
              data-suggested={card === choice.suggested || undefined}
              className="relative block"
            >
              <input
                type="radio"
                name={name}
                value={card}
                checked={selected === card}
                onChange={() => onPick(card)}
                aria-label={
                  tied
                    ? t("final.tied", { card: label })
                    : card === choice.suggested
                      ? t("final.suggested", { card: label })
                      : label
                }
                className="peer absolute inset-0 z-10 m-0 size-full cursor-pointer appearance-none rounded-[6px] opacity-0"
              />
              <span
                aria-hidden="true"
                className={cn(
                  CARD_FACE,
                  "relative grid h-12 w-9 place-items-center rounded-[6px] text-[15px]/none shadow-sm phone:h-11 phone:w-8",
                  "transition-[translate] duration-200 ease-standard peer-hover:-translate-y-0.5",
                  // The pick: lifted, with the hand's brass ring (an outline, kept in forced colours).
                  "peer-checked:-translate-y-1 peer-checked:shadow-md peer-checked:outline-2 peer-checked:outline-offset-1 peer-checked:outline-brass",
                  "peer-focus-visible:ring-[3px] peer-focus-visible:ring-ring/50",
                )}
              >
                <CardValue value={card} room={1.75} />
              </span>
              {tied ? (
                <span
                  aria-hidden="true"
                  data-tie-mark
                  className="pointer-events-none absolute -top-1.5 left-1/2 z-20 -translate-x-1/2 rounded-full bg-brass-soft px-1 text-[9px]/[12px] font-semibold whitespace-nowrap text-brass-ink"
                >
                  {t("results.tie")}
                </span>
              ) : null}
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}
