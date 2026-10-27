import { SquareIcon } from "lucide-react";
import { useId, useState } from "react";
import { Button } from "../components/ui/button.tsx";
import { Input } from "../components/ui/input.tsx";
import { useT } from "../i18n/hooks.ts";
import type { CommandInput } from "../realtime/room-connection.ts";
import { EXTEND_SECONDS, parseDuration, shortDuration, TIMER_PRESETS } from "./timer-view.ts";

export interface TimerMenuProps {
  /** A timer runs: the lengths start it again, and a phone gets "+30 s" and "Stop" here. */
  running: boolean;
  /** A phone's table: its centre has no room for "+30 s" and "Stop", so they are here. */
  compact: boolean;
  /** A timer command is on its way; another press waits. */
  busy: boolean;
  /** Sends the command; the menu closes and the focus goes back to the chip. */
  onCommand: (command: CommandInput) => void;
}

/**
 * The PO's timer menu (#27), a lazy chunk opened from the chip in the table's centre: the
 * presets (30 s, 60 s, 2 min) and a custom length (5 s to 60 min, typed as seconds or
 * m:ss); while a timer runs, the same lengths start it again, and on a phone "+30 s" and
 * "Stop" come first. Every control is 44 px tall.
 */
export default function TimerMenu({ running, compact, busy, onCommand }: TimerMenuProps) {
  const t = useT();
  const ids = { heading: useId(), field: useId(), hint: useId(), error: useId() };
  const [typed, setTyped] = useState("");
  // How many wrong lengths in a row were tried: each try mounts a new alert, so a screen
  // reader says it again, also for the same length twice. 0: none, or typing since.
  const [tries, setTries] = useState(0);
  const bad = tries > 0;
  const start = (seconds: number) => {
    if (!busy) onCommand({ type: "startTimer", payload: { seconds } });
  };

  return (
    <div className="flex flex-col gap-3 text-sm">
      {running && compact ? (
        <div className="grid grid-cols-2 gap-2">
          <Button
            variant="outline"
            className="h-11"
            data-menu-extend
            aria-disabled={busy || undefined}
            onClick={() => {
              if (!busy) onCommand({ type: "extendTimer", payload: { seconds: EXTEND_SECONDS } });
            }}
          >
            {t("timer.add")}
          </Button>
          <Button
            variant="outline"
            className="h-11"
            data-menu-stop
            aria-disabled={busy || undefined}
            onClick={() => {
              if (!busy) onCommand({ type: "stopTimer" });
            }}
          >
            <SquareIcon aria-hidden className="size-3 fill-current" />
            <span aria-hidden="true">{t("timer.stop")}</span>
            <span className="sr-only">{t("timer.stopSpoken")}</span>
          </Button>
        </div>
      ) : null}
      <fieldset
        aria-labelledby={ids.heading}
        className="m-0 flex min-w-0 flex-col gap-2 border-0 p-0"
      >
        <p
          id={ids.heading}
          className="m-0 font-mono text-xs tracking-[0.08em] text-ink-2 uppercase"
        >
          {t(running ? "timer.restart" : "timer.start")}
        </p>
        <div className="grid grid-cols-3 gap-2">
          {TIMER_PRESETS.map((seconds) => (
            <Button
              key={seconds}
              variant="outline"
              className="h-11 px-2 tabular-nums"
              data-timer-preset={seconds}
              aria-disabled={busy || undefined}
              onClick={() => start(seconds)}
            >
              {shortDuration(t, seconds)}
            </Button>
          ))}
        </div>
        <form
          className="flex items-end gap-2"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            const seconds = parseDuration(typed);
            setTries(seconds === null ? (n) => n + 1 : 0);
            if (seconds !== null) start(seconds);
          }}
        >
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <label htmlFor={ids.field} className="text-xs font-medium text-ink-2">
              {t("timer.customLabel")}
            </label>
            <Input
              id={ids.field}
              data-timer-custom
              value={typed}
              inputMode="text"
              autoComplete="off"
              spellCheck={false}
              placeholder="1:30"
              aria-invalid={bad || undefined}
              aria-describedby={bad ? `${ids.hint} ${ids.error}` : ids.hint}
              onChange={(event) => {
                setTyped(event.target.value);
                setTries(0);
              }}
              className="tabular-nums"
            />
          </div>
          <Button type="submit" className="h-11" aria-disabled={busy || undefined}>
            {t("timer.customStart")}
          </Button>
        </form>
        <p id={ids.hint} className="m-0 text-xs text-ink-2">
          {t("settings.timerCustomHint")}
        </p>
        {bad ? (
          <p key={tries} id={ids.error} role="alert" className="m-0 text-xs text-ink">
            {t("settings.timerCustomBad")}
          </p>
        ) : null}
      </fieldset>
    </div>
  );
}
