import { CheckIcon } from "lucide-react";
import { type FocusEvent, type KeyboardEvent, useId, useRef, useState } from "react";
import { Button } from "../components/ui/button.tsx";
import { useT } from "../i18n/hooks.ts";
import { cn } from "../lib/utils.ts";
import { commandSender } from "../realtime/room-connection.ts";
import { CARD_FACE, CardValue, cardLabel } from "../table/cards.tsx";
import { PLACED_FOCUS_GUARD_MS } from "../table/hand.tsx";
import { useDecisionDock } from "./decision-dock.ts";
import type { NextRound } from "./next-round.tsx";
import { type FinalChoice, finalChoice, type RevealedRound } from "./results-view.ts";
import { focusSoon } from "./round-centre.tsx";

// The PO's decision after a reveal (#32), right under the table: the final estimate
// (a radio group of the round's cards, the suggestion preselected), "Record 8", then
// "Next round" and "Vote again". In that order for the keyboard too: the result is read in
// the centre, then the PO records, then moves on. The table's centre shows the recorded
// final to everyone (`results.tsx`); this bar is the PO's alone. While its place in the
// page is out of view it docks at the bottom of the screen (`useDecisionDock`): the whole
// bar on a desktop, the action row alone on a phone.

interface DecisionProps {
  round: RevealedRound;
  /** The PO's next round (#21): its draft subject, sent by "Next round". */
  next: NextRound;
  /** A refused command, as an error code, or null when a new attempt begins. */
  onFailure: (code: string | null) => void;
}

const isPress = (key: string) => key === "Enter" || key === " ";

/** Docked, the bar is a sheet on the bottom edge, as #22 docks the hand. */
const DOCKED =
  "sticky bottom-0 z-20 rounded-b-none border-line border-b-transparent bg-surface shadow-panel";

/** On a phone the three actions share one row: each may wrap to two lines, never below 44 px. */
const ACTION =
  "phone:h-auto phone:min-h-11 phone:min-w-0 phone:px-2 phone:py-1.5 phone:text-[13px]/tight phone:whitespace-normal";

/**
 * Recording is explicit: nothing is sent until the PO presses "Record". The suggested card
 * is preselected, so recording it takes one press; on a tie, or with nothing to count,
 * nothing is, and the button waits for a pick. Once recorded the button reads "Recorded"
 * until the PO picks another card, which changes the final while the round stays revealed.
 * "Vote again" starts a new round on the same subject (the domain's `revote`): the revealed
 * round stays in history with its votes, so it asks for no confirmation.
 *
 * Keys: a held Enter or Space never presses twice, and when the page itself put the focus
 * in the bar (after the reveal, `relatedTarget` null) they do nothing for
 * `PLACED_FOCUS_GUARD_MS`, as in the hand (#21): the second press of a double Enter on
 * "Reveal cards" would otherwise record the suggestion. "Next round" pressed while a
 * record is on its way is sent behind it: one socket keeps the order, so the record lands
 * first.
 */
export function Decision({ round, next, onFailure }: DecisionProps) {
  const t = useT();
  const ids = { name: useId(), hint: useId() };
  const choice = finalChoice(round);
  /** The PO's own pick, until the server records it: then the picker follows `final`. */
  const [picked, setPicked] = useState<string | null>(null);
  const selected = picked ?? choice.preselected;
  const recorded = selected !== null && selected === round.final;
  const [recording, setRecording] = useState(false);
  const [revoting, setRevoting] = useState(false);
  const pending = useRef({ record: false, revote: false });
  const guardUntil = useRef(0);
  const swallowSpace = useRef(false);
  const bar = useRef<HTMLDivElement>(null);
  const actions = useRef<HTMLDivElement>(null);
  const docked = useDecisionDock(bar, actions);
  /** A round is on its way: nothing may start another, or record on the old one. */
  const starting = next.busy || revoting;

  async function record() {
    // Focusable while busy (aria-disabled), so a second press lands here and is dropped.
    if (selected === null || recorded || pending.current.record || starting) return;
    pending.current.record = true;
    setRecording(true);
    onFailure(null);
    try {
      const ack = await commandSender()({ type: "setFinal", payload: { card: selected } });
      if (ack.ok) setPicked(null);
      else onFailure(ack.code);
    } finally {
      pending.current.record = false;
      setRecording(false);
    }
  }

  async function revote() {
    if (pending.current.revote || next.busy) return;
    pending.current.revote = true;
    setRevoting(true);
    onFailure(null);
    try {
      const ack = await commandSender()({ type: "revote" });
      // The bar leaves with the revealed round: the focus goes to the hand, as after "Next round".
      if (ack.ok) focusSoon("[data-hand] [tabindex='0']", "[data-centre-status='voting']");
      else onFailure(ack.code);
    } finally {
      pending.current.revote = false;
      setRevoting(false);
    }
  }

  function onFocus(event: FocusEvent<HTMLDivElement>) {
    // No element lost the focus to the bar: the page moved it here (after the reveal), or
    // the person came from nowhere. A key still on its way is not meant for the bar.
    if (event.relatedTarget === null) {
      guardUntil.current = performance.now() + PLACED_FOCUS_GUARD_MS;
    }
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (!isPress(event.key)) return;
    // A held key repeats its keydown, and each would press again.
    if (event.repeat || performance.now() < guardUntil.current) {
      event.preventDefault();
      if (!event.repeat && event.key === " ") swallowSpace.current = true;
    }
  }

  function onKeyUp(event: KeyboardEvent<HTMLDivElement>) {
    // A button presses on Space's keyup: one whose keydown was ignored does not.
    if (event.key === " " && swallowSpace.current) {
      swallowSpace.current = false;
      event.preventDefault();
    }
  }

  return (
    // On a phone the bar is no box of its own (`contents`): its parts sit in the table's
    // section, so the action row alone can dock, anywhere along the section.
    // biome-ignore lint/a11y/noStaticElementInteractions: the handlers only guard the keys of the radios and buttons inside.
    <div
      ref={bar}
      data-decision
      data-decision-dock={docked || undefined}
      onFocus={onFocus}
      onKeyDown={onKeyDown}
      onKeyUp={onKeyUp}
      className={cn(
        "mt-4 flex flex-wrap items-end justify-center gap-x-6 gap-y-2 rounded-xl border border-transparent px-4 pt-2 pb-[max(0.75rem,env(safe-area-inset-bottom))]",
        docked && DOCKED,
        "phone:contents",
      )}
    >
      <Picker
        choice={choice}
        name={ids.name}
        selected={selected}
        describedBy={selected === null ? ids.hint : undefined}
        onPick={setPicked}
      />
      {selected === null ? (
        <p
          id={ids.hint}
          className="order-last m-0 w-full text-center text-sm text-ink-2 phone:mt-2"
        >
          {t("final.pick")}
        </p>
      ) : null}
      <div
        ref={actions}
        data-decision-actions
        className={cn(
          "flex flex-wrap items-center justify-center gap-2",
          // On a phone: one row of three, padded like the docked hand above the home indicator.
          "phone:mt-3 phone:grid phone:grid-cols-3 phone:rounded-xl phone:border phone:border-transparent phone:px-2 phone:pt-2 phone:pb-[max(0.5rem,env(safe-area-inset-bottom))]",
          docked &&
            "phone:sticky phone:bottom-0 phone:z-20 phone:rounded-b-none phone:border-line phone:border-b-transparent phone:bg-surface phone:shadow-panel",
        )}
      >
        <Button
          data-record-final
          aria-disabled={selected === null || recorded || recording || starting || undefined}
          onClick={() => void record()}
          className={cn(ACTION, "aria-disabled:cursor-default aria-disabled:opacity-60")}
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
          aria-disabled={starting || undefined}
          onClick={() => {
            if (!revoting) void next.start();
          }}
          className={ACTION}
        >
          {t("round.next")}
        </Button>
        <Button
          data-revote
          variant="ghost"
          aria-disabled={starting || undefined}
          onClick={() => void revote()}
          className={ACTION}
        >
          {t("round.revote")}
        </Button>
      </div>
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
 * (32 × 44 on phones, a whole touch target, 8 px apart) and wrap into rows when the deck is
 * long, never scrolling sideways. The suggested card and the tied cards say so to screen
 * readers; a tie is marked on the cards as well. The pick lifts with a brass ring on the
 * card; the keyboard focus is an outline around the whole card (its label), in the ink
 * colour, so the two never look alike and the focus stays visible in forced colours, also
 * on a card that is not picked.
 */
function Picker({ choice, name, selected, describedBy, onPick }: PickerProps) {
  const t = useT();
  return (
    <fieldset data-final-picker aria-describedby={describedBy} className="m-0 min-w-0 border-0 p-0">
      <legend className="mb-2 w-full p-0 text-center text-sm font-medium">
        {t("final.label")}
      </legend>
      <div className="flex flex-wrap justify-center gap-1.5 pt-1.5 phone:gap-2">
        {choice.cards.map((card) => {
          const tied = choice.tied.includes(card);
          const label = cardLabel(t, card);
          return (
            <label
              key={card}
              data-final-card={card}
              data-tied={tied || undefined}
              data-suggested={card === choice.suggested || undefined}
              className={cn(
                "relative block rounded-[8px] transition-[translate] duration-200 ease-standard has-checked:-translate-y-1",
                "has-focus-visible:outline-2 has-focus-visible:outline-offset-2 has-focus-visible:outline-ink",
              )}
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
                  // The pick: lifted (the label), with the hand's brass ring (an outline, kept
                  // in forced colours).
                  "peer-checked:shadow-md peer-checked:outline-2 peer-checked:outline-offset-1 peer-checked:outline-brass",
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
