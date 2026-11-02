import { Volume2Icon, VolumeXIcon } from "lucide-react";
import { useId, useRef, useSyncExternalStore } from "react";
import { Button } from "../components/ui/button.tsx";
import { Popover, PopoverContent, PopoverTrigger } from "../components/ui/popover.tsx";
import { SEGMENT } from "../components/ui/segment.ts";
import { Switch } from "../components/ui/switch.tsx";
import { useT } from "../i18n/hooks.ts";
import { useBackgroundMusic } from "./background-music.ts";
import { useAudioWhile, useSoundEffects } from "./sound-effects.ts";
import { preview, soundRunning, subscribeSound, unlock } from "./sound-engine.ts";
import { MOODS, setSoundPrefs, useSoundPrefs } from "./sound-prefs.ts";

/** A slider dragged across its length plays its preview this often, not at every step. */
const PREVIEW_GAP_MS = 180;
/** 44 px to touch, whatever the switch draws (design brief). */
const SWITCH_TARGET = "relative after:absolute after:-inset-x-2 after:-inset-y-3.5";

const running = () => soundRunning();

/**
 * The person's sound (#44, #45): a speaker in the top bar that opens two switches, the sound
 * effects and the background music, the music's mood and one volume. Off until they turn
 * something on; the choices stay on this device. A switch is a gesture, so the effects are
 * heard at once, and the music as soon as it is rendered, if voting is open. After a reload
 * a browser lets nothing play before the next gesture: the button then says so, and the
 * first click or key starts it.
 */
export default function SoundControl() {
  const t = useT();
  const ids = {
    on: useId(),
    hint: useId(),
    music: useId(),
    musicHint: useId(),
    mood: useId(),
    volume: useId(),
  };
  const { on, volume, music, mood } = useSoundPrefs();
  const audible = on || music;
  useSoundEffects(on);
  useBackgroundMusic(music, mood);
  useAudioWhile(audible, volume);
  const started = useSyncExternalStore(subscribeSound, running, () => false);
  const lastPreview = useRef(0);
  const state = !audible ? "off" : started ? "on" : "waiting";
  const label = t(`sound.${state}`);
  const level = t("sound.level", { level: volume });

  function toggle(next: boolean) {
    setSoundPrefs({ on: next });
    if (next) preview();
  }

  function toggleMusic(next: boolean) {
    setSoundPrefs({ music: next });
    if (next) unlock();
  }

  function changeVolume(next: number) {
    setSoundPrefs({ volume: next });
    // The test of the sound is a sound effect: with only the music on, the music says it.
    if (!on) return;
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
          {audible && volume > 0 ? <Volume2Icon aria-hidden /> : <VolumeXIcon aria-hidden />}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        aria-label={t("sound.title")}
        data-sound-panel
        className="flex max-h-(--radix-popover-content-available-height) w-72 max-w-[calc(100vw-2rem)] flex-col gap-3 overflow-y-auto border-line bg-surface text-ink"
      >
        <div className="flex items-center justify-between gap-3">
          <label htmlFor={ids.on} className="font-medium">
            {t("sound.enable")}
          </label>
          <Switch
            id={ids.on}
            checked={on}
            aria-describedby={ids.hint}
            className={SWITCH_TARGET}
            onCheckedChange={toggle}
          />
        </div>
        <p id={ids.hint} className="m-0 text-sm text-ink-2">
          {t("sound.hint")}
        </p>
        <div className="flex items-center justify-between gap-3">
          <label htmlFor={ids.music} className="font-medium">
            {t("sound.musicEnable")}
          </label>
          <Switch
            id={ids.music}
            checked={music}
            aria-describedby={ids.musicHint}
            className={SWITCH_TARGET}
            onCheckedChange={toggleMusic}
          />
        </div>
        <p id={ids.musicHint} className="m-0 text-sm text-ink-2">
          {t("sound.musicHint")}
        </p>
        <div className="flex flex-col gap-1">
          <span id={ids.mood} className="font-medium">
            {t("sound.mood")}
          </span>
          <div
            role="radiogroup"
            aria-labelledby={ids.mood}
            className="flex flex-wrap gap-2"
          >
            {MOODS.map((choice) => (
              <label
                key={choice}
                className={`${SEGMENT} has-disabled:cursor-not-allowed has-disabled:opacity-50`}
              >
                <input
                  type="radio"
                  name={ids.mood}
                  value={choice}
                  checked={mood === choice}
                  disabled={!music}
                  onChange={() => setSoundPrefs({ mood: choice })}
                  // The whole segment is the radio: a click or a tap lands on it.
                  className="absolute inset-0 m-0 cursor-pointer appearance-none rounded-md opacity-0 disabled:cursor-not-allowed"
                />
                {t(`sound.moods.${choice}`)}
              </label>
            ))}
          </div>
        </div>
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
            disabled={!audible}
            data-sound-volume
            className="h-11 w-full cursor-pointer accent-brass disabled:cursor-not-allowed disabled:opacity-50"
            onChange={(event) => changeVolume(Number(event.target.value) / 100)}
          />
        </div>
      </PopoverContent>
    </Popover>
  );
}
