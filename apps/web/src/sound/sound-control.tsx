import { Volume2Icon, VolumeXIcon } from "lucide-react";
import { useId, useRef, useSyncExternalStore } from "react";
import { Button } from "../components/ui/button.tsx";
import { Popover, PopoverContent, PopoverTrigger } from "../components/ui/popover.tsx";
import { Switch } from "../components/ui/switch.tsx";
import { useT } from "../i18n/hooks.ts";
import { HapticsRow } from "../room/haptics-row.tsx";
import { useSoundEffects } from "./sound-effects.ts";
import { preview, soundRunning, subscribeSound } from "./sound-engine.ts";
import { setSoundPrefs, useSoundPrefs } from "./sound-prefs.ts";

/** A slider dragged across its length plays its preview this often, not at every step. */
const PREVIEW_GAP_MS = 180;

const running = () => soundRunning();

/**
 * The person's sound effects (#44): a speaker in the top bar that opens a switch and a
 * volume. Off until they turn it on; the choice stays on this device. The switch is a
 * gesture, so turning it on is heard at once. After a reload a browser lets nothing play
 * before the next gesture: the button then says so, and the first click or key starts it.
 */
export default function SoundControl() {
  const t = useT();
  const ids = { on: useId(), hint: useId(), volume: useId() };
  const { on, volume } = useSoundPrefs();
  useSoundEffects(on, volume);
  const started = useSyncExternalStore(subscribeSound, running, () => false);
  const lastPreview = useRef(0);
  const state = !on ? "off" : started ? "on" : "waiting";
  const label = t(`sound.${state}`);
  const level = t("sound.level", { level: volume });

  function toggle(next: boolean) {
    setSoundPrefs({ on: next });
    if (next) preview();
  }

  function changeVolume(next: number) {
    setSoundPrefs({ volume: next });
    const now = performance.now();
    if (now - lastPreview.current < PREVIEW_GAP_MS) return;
    lastPreview.current = now;
    preview();
  }

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          aria-label={label}
          title={label}
          data-sound={state}
          className="shrink-0 data-[sound=waiting]:text-ink-2"
        >
          {on && volume > 0 ? <Volume2Icon aria-hidden /> : <VolumeXIcon aria-hidden />}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        aria-label={t("sound.title")}
        data-sound-panel
        className="flex w-72 max-w-[calc(100vw-2rem)] flex-col gap-3 border-line bg-surface text-ink"
      >
        <div className="flex items-center justify-between gap-3">
          <label htmlFor={ids.on} className="font-medium">
            {t("sound.enable")}
          </label>
          <Switch
            id={ids.on}
            checked={on}
            aria-describedby={ids.hint}
            // 44 px to touch, whatever the switch draws (design brief).
            className="relative after:absolute after:-inset-x-2 after:-inset-y-3.5"
            onCheckedChange={toggle}
          />
        </div>
        <p id={ids.hint} className="m-0 text-sm text-ink-2">
          {t("sound.hint")}
        </p>
        <div className="flex flex-col">
          <div className="flex items-baseline justify-between gap-3">
            <label htmlFor={ids.volume} className="font-medium">
              {t("sound.volume")}
            </label>
            {/* For the eye: the slider says its own value, and a live region would say it twice. */}
            <span aria-hidden="true" data-sound-level className="text-sm text-ink-2 tabular-nums">
              {level}
            </span>
          </div>
          <input
            id={ids.volume}
            type="range"
            min={0}
            max={100}
            step={5}
            value={Math.round(volume * 100)}
            aria-valuetext={level}
            disabled={!on}
            data-sound-volume
            className="h-11 w-full cursor-pointer accent-brass disabled:cursor-not-allowed disabled:opacity-50"
            onChange={(event) => changeVolume(Number(event.target.value) / 100)}
          />
        </div>
        <HapticsRow />
      </PopoverContent>
    </Popover>
  );
}
