import { useEffect } from "react";
import { useRoomStore } from "../stores/room-store.ts";
import { taskQueue } from "./sound-effects.ts";
import { endLoop, soundRunning, startLoop, subscribeSound } from "./sound-engine.ts";
import type { Mood } from "./sound-prefs.ts";

const phaseOf = (state: ReturnType<typeof useRoomStore.getState>) =>
  state.snapshot?.room.round?.phase ?? null;

/**
 * The background music while it is `on` (#45, ADR-021): the mood's loop, for as long as the
 * round the viewer sees is in voting. It is rendered once the context runs, not before: a
 * page nobody touched does no work for a sound it may never play. So the compositions load
 * here and not with the control, and a failed load costs the music, never the page. Nothing
 * waits for a gesture: the first one finds out whether voting is open then. It keeps playing
 * in a hidden tab, and whatever a timer does.
 */
export function useBackgroundMusic(on: boolean, mood: Mood) {
  useEffect(() => {
    if (!on) return;
    let loop: AudioBuffer | null = null;
    let asked = false;
    let over = false;

    const follow = () => {
      if (phaseOf(useRoomStore.getState()) !== "voting") endLoop();
      else if (loop !== null) startLoop(loop);
    };
    const render = () => {
      if (asked || !soundRunning()) return;
      asked = true;
      import("./music-render.ts")
        .then(({ renderLoop }) => renderLoop(mood))
        .then(
          (rendered) => {
            if (over) return;
            loop = rendered;
            follow();
          },
          () => {},
        );
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
    render();

    return () => {
      over = true;
      unwatch();
      unfollow();
      tasks.close();
      endLoop();
    };
  }, [on, mood]);
}
