import { useEffect } from "react";
import { serverTime } from "../realtime/server-clock.ts";
import { useRoomStore } from "../stores/room-store.ts";
import { prefersReducedMotion } from "../table/reveal-motion.ts";
import { type Cue, soundCues, timerCues } from "./sound-cues.ts";
import {
  hush,
  play,
  setVolume,
  shut,
  soundRunning,
  subscribeSound,
  unlock,
} from "./sound-engine.ts";

/**
 * What a browser counts as a gesture: a press of the mouse, a key, the end of a touch (a
 * touch's `pointerdown` does not count). All of them: the first one starts the sound.
 */
const GESTURES = ["pointerdown", "pointerup", "keydown", "touchend"] as const;

const heard = ({ sound, afterMs, detune }: Cue) => play(sound, afterMs, detune);

/** One round in one phase with one deadline: another one drops what is still to come. */
function roundMoment() {
  const round = useRoomStore.getState().snapshot?.room.round ?? null;
  if (round === null) return { key: "", deadline: null };
  const deadline = round.phase === "voting" ? (round.deadlineAt ?? null) : null;
  return {
    key: `${round.number}:${round.startedAt}:${round.phase}:${deadline}`,
    deadline,
  };
}

/**
 * The room's sounds while they are `on`: a snapshot's cues, as they arrive, and the timer's
 * last seconds, laid out ahead on the audio clock. A hidden tab's timers run late, and a
 * hidden tab is where these are wanted. A later round, reveal or deadline takes back what
 * the last one laid out. The ticks of a timer already running are laid out as soon as the
 * sound starts. Follows the room store, not renders, as `LiveAnnouncer` does: a render can
 * merge two snapshots.
 */
export function useSoundEffects(on: boolean, volume: number) {
  useEffect(() => setVolume(volume), [volume]);

  useEffect(() => {
    if (!on) return;
    let laid: string | null = null;
    const layOut = (again = false) => {
      const { key, deadline } = roundMoment();
      if (key === laid && !again) return;
      laid = key;
      hush();
      if (deadline !== null) timerCues(deadline, serverTime()).forEach(heard);
    };

    const unfollow = useRoomStore.subscribe((state, before) => {
      const next = state.snapshot;
      if (!next || next === before.snapshot) return;
      // Before the cues: a reveal takes back the ticks, never its own flicks.
      layOut();
      const previous = before.snapshot?.room.code === next.room.code ? before.snapshot.room : null;
      soundCues(next.room, next.causes, previous, prefersReducedMotion()).forEach(heard);
    });
    const unwatch = subscribeSound(() => {
      if (soundRunning()) layOut(true);
    });
    for (const gesture of GESTURES) {
      window.addEventListener(gesture, unlock, { capture: true, passive: true });
    }
    layOut(true);

    return () => {
      for (const gesture of GESTURES) {
        window.removeEventListener(gesture, unlock, { capture: true });
      }
      unwatch();
      unfollow();
      shut();
    };
  }, [on]);
}
