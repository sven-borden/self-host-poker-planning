import type { RoomView } from "@pp/protocol";
import { type ComponentProps, useEffect, useState } from "react";
import { useT } from "../i18n/hooks.ts";
import { revealSummary, summarySentence } from "./results-view.ts";
import { PlayedCards } from "./revealed-cards.tsx";

// The results (#20) are a chunk of their own: `Seated` loads the module itself while a
// round is on, so it is in memory by the reveal and the results draw at once, without a
// Suspense fallback in between; neither the room route nor the `seated` chunk carries it
// (docs/02-architecture.md, "Budgets"). A chunk that cannot load (offline, or an old one
// gone after a redeploy) never hides the round: the centre says the result in a sentence,
// an anonymous round lists its cards under the table (named rounds have them on the
// seats), and the next reveal tries the chunk again.

type Results = typeof import("./results.tsx");

let loaded: Results | null = null;
let loading: Promise<Results | null> | null = null;

/** The results' module, loaded once; after a failure the next call tries again. */
export function loadResults(): Promise<Results | null> {
  if (loaded !== null) return Promise.resolve(loaded);
  loading ??= import("./results.tsx").then(
    (module) => {
      loaded = module;
      return module;
    },
    () => {
      loading = null;
      return null;
    },
  );
  return loading;
}

/** Loads the module ahead of the reveal; a failure waits for the reveal to try again. */
export const prefetchResults = () => {
  void loadResults();
};

/**
 * The module, at once when it is already loaded. Otherwise each mount (a reveal) loads it,
 * trying again after an earlier failure; `failed` once this attempt could not.
 */
function useResults(): { module: Results | null; failed: boolean } {
  const [state, setState] = useState(() => ({ module: loaded, failed: false }));
  useEffect(() => {
    if (state.module !== null) return;
    let mounted = true;
    void loadResults().then((module) => {
      if (mounted) setState({ module, failed: module === null });
    });
    return () => {
      mounted = false;
    };
  }, [state.module]);
  return state;
}

/** The centre until the results have loaded, or when they cannot: the result as a sentence. */
export function CentreFallback({ room }: { room: RoomView }) {
  const t = useT();
  const round = room.round;
  return (
    <p data-centre-status="revealed" data-centre-fallback className="m-0">
      {round?.phase === "revealed" ? summarySentence(t, revealSummary(round)) : t("round.revealed")}
    </p>
  );
}

export function CentreResult(props: ComponentProps<Results["CentreResult"]>) {
  const { module } = useResults();
  if (module === null) return <CentreFallback room={props.room} />;
  const Loaded = module.CentreResult;
  return <Loaded {...props} />;
}

/**
 * The panel, or once it cannot load: an anonymous round's cards in deck order (they show
 * nowhere else), and nothing for a named round, whose seats show its cards.
 */
export function ResultsPanel(props: ComponentProps<Results["ResultsPanel"]>) {
  const { module, failed } = useResults();
  if (module !== null) {
    const Loaded = module.ResultsPanel;
    return <Loaded {...props} />;
  }
  const round = props.room.round;
  if (!failed || round?.phase !== "revealed" || !round.anonymous) return null;
  return round.cards.length > 0 ? <PlayedCards cards={round.cards} /> : null;
}

export type { RevealMotion } from "./results.tsx";
