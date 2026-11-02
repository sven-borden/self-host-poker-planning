import { useEffect } from "react";
import { serverTime } from "../realtime/server-clock.ts";
import { useRoomStore } from "../stores/room-store.ts";
import { prefersReducedMotion } from "../table/reveal-motion.ts";
import { type Cue, soundCues, timerCues } from "./sound-cues.ts";
import {
  hush,
  keep,
  play,
  release,
  setVolume,
  soundRunning,
  subscribeSound,
  unlock,
} from "./sound-engine.ts";

/**
 * What a browser counts as a gesture: a press of the mouse, a key, the end of a touch (a
 * touch's `pointerdown` does not count). All of them: the first one starts the sound.
 */
export const GESTURES = ["pointerdown", "pointerup", "keydown", "touchend"] as const;

const heard = ({ sound, afterMs, detune }: Cue) => play(sound, afterMs, detune);

/**
 * Runs work in a task of its own, in order. A snapshot arrives in the task that draws it,
 * and a reveal's already sits at the 50 ms a mid-range phone may spend (#43, ADR-019), while
 * laying out sixteen flicks and a chord takes 7 ms there. A message rather than a timer: a
 * hidden tab holds its timers back by up to a second, and a hidden tab is where sound is
 * wanted. Time lost to the wait comes off each cue, so the flicks stay with the flips.
 */
export function taskQueue() {
  const { port1, port2 } = new MessageChannel();
  const waiting: Array<() => void> = [];
  port1.onmessage = () => waiting.shift()?.();
  return {
    run(work: () => void) {
      waiting.push(work);
      port2.postMessage(null);
    },
    close() {
      port1.close();
      port2.close();
    },
  };
}

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
 * Keeps the audio while something `wanted` it, the effects or the music: the first gesture
 * starts it, and it is given back when neither wants it any more. Call it after the hooks
 * that play: effects clean up in order, and the music has to start falling away first.
 */
export function useAudioWhile(wanted: boolean, volume: number) {
  useEffect(() => setVolume(volume), [volume]);

  useEffect(() => {
    if (!wanted) return;
    keep();
    for (const gesture of GESTURES) {
      window.addEventListener(gesture, unlock, { capture: true, passive: true });
    }
    return () => {
      for (const gesture of GESTURES) {
        window.removeEventListener(gesture, unlock, { capture: true });
      }
      release();
    };
  }, [wanted]);
}

/**
 * The room's sounds while they are `on`: a snapshot's cues, as they arrive, and the timer's
 * last seconds, laid out ahead on the audio clock. A hidden tab's timers run late, and a
 * hidden tab is where these are wanted. A later round, reveal or deadline takes back what
 * the last one laid out. The ticks of a timer already running are laid out as soon as the
 * sound starts. Follows the room store, not renders, as `LiveAnnouncer` does: a render can
 * merge two snapshots.
 */
export function useSoundEffects(on: boolean) {
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

    const tasks = taskQueue();
    const unfollow = useRoomStore.subscribe((state, before) => {
      const next = state.snapshot;
      if (!next || next === before.snapshot) return;
      const previous = before.snapshot?.room.code === next.room.code ? before.snapshot.room : null;
      const arrived = performance.now();
      tasks.run(() => {
        // Before the cues: a reveal takes back the ticks, never its own flicks.
        layOut();
        const late = performance.now() - arrived;
        for (const cue of soundCues(next.room, next.causes, previous, prefersReducedMotion())) {
          heard({ ...cue, afterMs: Math.max(0, cue.afterMs - late) });
        }
      });
    });
    const unwatch = subscribeSound(() => {
      if (soundRunning()) layOut(true);
    });
    layOut(true);

    return () => {
      // The music may keep the context: the ticks still to come must not outlive the switch.
      hush();
      unwatch();
      unfollow();
      tasks.close();
    };
  }, [on]);
}
