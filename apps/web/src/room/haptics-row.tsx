import { useId } from "react";
import { Switch } from "../components/ui/switch.tsx";
import { useT } from "../i18n/hooks.ts";
import { canVibrate, setHapticsOn, useHapticsOn } from "./haptics-prefs.ts";

/** The vibration's switch (#46), in the speaker's popover, only where something can vibrate. */
export function HapticsRow() {
  const t = useT();
  const ids = { on: useId(), hint: useId() };
  const on = useHapticsOn();
  if (!canVibrate()) return null;
  return (
    <>
      <div className="flex items-center justify-between gap-3">
        <label htmlFor={ids.on} className="font-medium">
          {t("haptics.enable")}
        </label>
        <Switch
          id={ids.on}
          checked={on}
          aria-describedby={ids.hint}
          // 44 px to touch, whatever the switch draws (design brief).
          className="relative after:absolute after:-inset-x-2 after:-inset-y-3.5"
          onCheckedChange={setHapticsOn}
        />
      </div>
      <p id={ids.hint} className="m-0 text-sm text-ink-2">
        {t("haptics.hint")}
      </p>
    </>
  );
}
