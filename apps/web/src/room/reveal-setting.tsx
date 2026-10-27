import type { WhoCanReveal } from "@pp/domain";
import { useEffect, useId, useRef, useState } from "react";
import { useT } from "../i18n/hooks.ts";
import type { ControlProps } from "./settings-panel.tsx";
import { ARROW_SETTLE_MS, SEGMENT } from "./timer-setting.tsx";

const CHOICES: readonly {
  value: WhoCanReveal;
  label: "settings.revealByOwner" | "settings.revealByAnyone";
}[] = [
  { value: "po", label: "settings.revealByOwner" },
  { value: "anyone", label: "settings.revealByAnyone" },
];

/**
 * The PO's "Who can reveal" (#28), in the settings panel's "Voting and reveal" group: "The
 * product owner" or "Anyone who votes", two segments under the hint. Unlike anonymity it
 * applies at once, to the round on the table too: a voter's "Reveal cards" appears or
 * leaves with the next snapshot. A click, a tap or Space sends the choice at once; arrow
 * keys send the one they rest on after `ARROW_SETTLE_MS`, so the room hears one change, as
 * the timer's lengths do (#27).
 */
export function WhoCanRevealControl({
  settings,
  change,
  pending,
  id,
  labelId,
  describedBy,
}: ControlProps) {
  const t = useT();
  const name = useId();
  // A choice the arrow keys rest on, shown at once and sent once they stop.
  const [staged, setStaged] = useState<WhoCanReveal | null>(null);
  const shown = staged ?? settings.whoCanReveal;
  /** The last key went to an arrow: the change it makes waits for the keys to rest. */
  const arrowed = useRef(false);
  /** Sends the staged choice now: when the keys rest, or the panel closes before. */
  const flush = useRef<(() => void) | null>(null);
  const waiting = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(
    () => () => {
      clearTimeout(waiting.current);
      flush.current?.();
    },
    [],
  );

  const send = (who: WhoCanReveal) => {
    flush.current = null;
    setStaged(null);
    if (who !== settings.whoCanReveal) change({ whoCanReveal: who });
  };

  const pick = (who: WhoCanReveal, later: boolean) => {
    if (pending) return;
    clearTimeout(waiting.current);
    flush.current = null;
    if (!later) {
      send(who);
      return;
    }
    setStaged(who);
    flush.current = () => send(who);
    waiting.current = setTimeout(() => flush.current?.(), ARROW_SETTLE_MS);
  };

  return (
    <fieldset
      id={id}
      aria-labelledby={labelId}
      aria-describedby={describedBy}
      aria-busy={pending || undefined}
      role="radiogroup"
      data-who-can-reveal
      className="m-0 flex min-w-0 flex-wrap gap-2 border-0 p-0"
      onKeyDown={(event) => {
        arrowed.current = event.key.startsWith("Arrow");
      }}
      onPointerDown={() => {
        arrowed.current = false;
      }}
    >
      {CHOICES.map((choice) => (
        <label key={choice.value} className={`${SEGMENT} min-w-36`}>
          <input
            type="radio"
            name={name}
            value={choice.value}
            checked={shown === choice.value}
            aria-disabled={pending || undefined}
            onChange={() => {
              const later = arrowed.current;
              arrowed.current = false;
              pick(choice.value, later);
            }}
            // The whole segment is the radio: a click or a tap lands on it.
            className="absolute inset-0 m-0 cursor-pointer appearance-none rounded-md opacity-0"
          />
          {t(choice.label)}
        </label>
      ))}
    </fieldset>
  );
}
