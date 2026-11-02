import { useEffect } from "react";
import { useRoomStore } from "../stores/room-store.ts";
import { GESTURES, taskQueue } from "./sound-effects.ts";
import { endLoop, soundRunning, startLoop, subscribeSound } from "./sound-engine.ts";
import type { Mood } from "./sound-prefs.ts";

const phaseOf = (state: ReturnType<typeof useRoomStore.getState>) =>
  state.snapshot?.room.round?.phase ?? null;
const voting = () => phaseOf(useRoomStore.getState()) === "voting";

/** How long a render may wait for a quiet moment, in ms: a busy room is no reason to skip it. */
const IDLE_WAIT_MS = 1000;

/** Runs `work` when the page has a moment: a first gesture may be the one that reveals. */
function whenIdle(work: () => void) {
  if (typeof requestIdleCallback === "function") {
    requestIdleCallback(work, { timeout: IDLE_WAIT_MS });
  } else {
    setTimeout(work);
  }
}

/**
 * The background music while it is `on` (#45, ADR-021): the mood's loop, for as long as the
 * round the viewer sees is in voting. It is rendered once the context runs, not before: a
 * page nobody touched does no work for a sound it may never play. So the compositions load
 * here and not with the control, and a failed load costs the music, never the page: the next
 * gesture or round asks again. Nothing waits for a gesture: the first one finds out whether
 * voting is open then. It keeps playing in a hidden tab, and whatever a timer does.
 *
 * The mood's effect leaves the loop alone: the old mood plays on until the new one is
 * rendered, and `startLoop` fades one under the other. Only `on` going away ends it.
 */
export function useBackgroundMusic(on: boolean, mood: Mood) {
  useEffect(() => {
    if (!on) return;
    let loop: AudioBuffer | null = null;
    let asked = false;
    let over = false;

    const render = () => {
      if (asked || !soundRunning()) return;
      asked = true;
      whenIdle(() => {
        if (over) return;
        import("./music-render.ts")
          .then(({ renderLoop }) => renderLoop(mood))
          .then(
            (rendered) => {
              if (over) return;
              loop = rendered;
              follow();
            },
            () => {
              asked = false;
            },
          );
      });
    };
    const follow = () => {
      if (!voting()) endLoop();
      else if (loop !== null) startLoop(loop);
      else render();
    };

    // In a task of its own, as the sound effects are: not in a reveal's commit (ADR-019).
    const tasks = taskQueue();
    const unfollow = useRoomStore.subscribe((state, before) => {
      if (phaseOf(state) !== phaseOf(before)) tasks.run(follow);
    });
    const unwatch = subscribeSound(() => {
      render();
      follow();
    });
    // A running context says nothing when a gesture comes: only a failed render needs to hear.
    for (const gesture of GESTURES) {
      window.addEventListener(gesture, render, { capture: true, passive: true });
    }
    render();
    // The last mood's queue may have closed on a phase change still to be followed.
    tasks.run(() => {
      if (!voting()) endLoop();
    });

    return () => {
      over = true;
      for (const gesture of GESTURES) {
        window.removeEventListener(gesture, render, { capture: true });
      }
      unwatch();
      unfollow();
      tasks.close();
    };
  }, [on, mood]);

  useEffect(() => (on ? endLoop : undefined), [on]);
}
