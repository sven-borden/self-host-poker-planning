import { useId, useState } from "react";
import { Button } from "../components/ui/button.tsx";
import { Input } from "../components/ui/input.tsx";
import { Switch } from "../components/ui/switch.tsx";
import { useT } from "../i18n/hooks.ts";
import { cn } from "../lib/utils.ts";
import type { ControlProps } from "./settings-panel.tsx";
import { parseDuration, shortDuration, TIMER_PRESETS, typedDuration } from "./timer-view.ts";

type Choice = "off" | (typeof TIMER_PRESETS)[number] | "custom";

const choiceOf = (seconds: number | null): Choice =>
  seconds === null
    ? "off"
    : (TIMER_PRESETS as readonly number[]).includes(seconds)
      ? (seconds as Choice)
      : "custom";

/** A segment of the length picker: a 44 px label with its native radio laid over it. */
const SEGMENT =
  "relative inline-flex h-11 min-w-16 flex-1 cursor-pointer items-center justify-center rounded-md border border-line bg-surface px-2 text-sm font-medium tabular-nums has-checked:border-spruce has-checked:bg-spruce has-checked:text-on-spruce has-focus-visible:outline-2 has-focus-visible:outline-offset-2 has-focus-visible:outline-brass has-aria-disabled:opacity-60 forced-colors:has-checked:border-[Highlight] forced-colors:has-checked:outline-2 forced-colors:has-checked:outline-[Highlight]";

/**
 * The PO's timer setting (#27), in the settings panel's "Voting and reveal" group: the
 * length every round starts with (Off, 30 s, 60 s, 2 min, or a custom length of 5 s to
 * 60 min typed as seconds or m:ss), and whether the cards turn over when it ends (on by
 * default, ADR-011). As the domain does, a new length applies from the next round; the
 * hint says so. A running timer keeps its deadline.
 */
export function TimerSetting({
  settings,
  change,
  pending,
  id,
  labelId,
  describedBy,
}: ControlProps) {
  const t = useT();
  const ids = { name: useId(), custom: useId(), hint: useId(), error: useId(), reveal: useId() };
  const current = settings.timer.seconds;
  const [customOpen, setCustomOpen] = useState(false);
  const shown: Choice = customOpen ? "custom" : choiceOf(current);
  const [typed, setTyped] = useState(() =>
    current !== null && choiceOf(current) === "custom" ? typedDuration(current) : "",
  );
  const [bad, setBad] = useState(false);

  const pick = (choice: Choice) => {
    if (pending) return;
    setBad(false);
    if (choice === "custom") {
      setCustomOpen(true);
      return;
    }
    setCustomOpen(false);
    change({ timer: { seconds: choice === "off" ? null : choice } });
  };

  const setCustom = () => {
    if (pending) return;
    const seconds = parseDuration(typed);
    setBad(seconds === null);
    if (seconds === null) return;
    setCustomOpen(false);
    setTyped(typedDuration(seconds));
    if (seconds !== current) change({ timer: { seconds } });
  };

  const choices: { value: Choice; label: string }[] = [
    { value: "off", label: t("settings.off") },
    ...TIMER_PRESETS.map((seconds) => ({ value: seconds, label: shortDuration(t, seconds) })),
    { value: "custom", label: t("settings.timerCustom") },
  ];

  return (
    <div className="flex flex-col gap-3">
      <fieldset
        id={id}
        aria-labelledby={labelId}
        aria-describedby={describedBy}
        aria-busy={pending || undefined}
        data-timer-lengths
        className="m-0 flex min-w-0 flex-wrap gap-2 border-0 p-0"
      >
        {choices.map((choice) => (
          <label key={choice.value} className={SEGMENT}>
            <input
              type="radio"
              name={ids.name}
              value={String(choice.value)}
              checked={shown === choice.value}
              aria-disabled={pending || undefined}
              onChange={() => pick(choice.value)}
              // The whole segment is the radio: a click or a tap lands on it.
              className="absolute inset-0 m-0 cursor-pointer appearance-none rounded-md opacity-0"
            />
            {choice.label}
          </label>
        ))}
      </fieldset>
      {shown === "custom" ? (
        <form
          noValidate
          className="flex flex-col gap-1"
          onSubmit={(event) => {
            event.preventDefault();
            setCustom();
          }}
        >
          <label htmlFor={ids.custom} className="text-sm font-medium">
            {t("settings.timerCustomLabel")}
          </label>
          <div className="flex gap-2">
            <Input
              id={ids.custom}
              data-timer-setting-custom
              value={typed}
              autoComplete="off"
              spellCheck={false}
              placeholder="1:30"
              aria-invalid={bad || undefined}
              aria-describedby={bad ? `${ids.hint} ${ids.error}` : ids.hint}
              onChange={(event) => {
                setTyped(event.target.value);
                setBad(false);
              }}
              className="max-w-32 tabular-nums"
            />
            <Button
              type="submit"
              variant="outline"
              className="h-11"
              aria-disabled={pending || undefined}
            >
              {t("settings.timerSet")}
            </Button>
          </div>
          <p id={ids.hint} className="m-0 text-sm text-ink-2">
            {t("settings.timerCustomHint")}
          </p>
          {bad ? (
            <p id={ids.error} role="alert" className="m-0 text-sm text-ink">
              {t("settings.timerCustomBad")}
            </p>
          ) : null}
        </form>
      ) : null}
      <div className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-4 gap-y-1">
        <label htmlFor={ids.reveal} className="font-medium">
          {t("settings.timerRevealAtEnd")}
        </label>
        <Switch
          id={ids.reveal}
          data-timer-reveal-at-end
          checked={settings.timer.revealAtEnd}
          aria-describedby={`${ids.reveal}-hint`}
          aria-busy={pending || undefined}
          aria-disabled={pending || undefined}
          className={cn(
            "relative row-span-2 mt-0.5 after:absolute after:-inset-x-2 after:-inset-y-3.5 aria-disabled:opacity-60",
          )}
          onCheckedChange={(on) => {
            if (!pending) change({ timer: { revealAtEnd: on } });
          }}
        />
        <p id={`${ids.reveal}-hint`} className="m-0 text-sm text-ink-2">
          {t("settings.timerRevealAtEndHint")}
        </p>
      </div>
    </div>
  );
}
