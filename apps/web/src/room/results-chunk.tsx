import { lazy } from "react";
import { useT } from "../i18n/hooks.ts";

// The results (#20) are a chunk of their own: `Seated` prefetches it while a round is on,
// so it is there by the reveal, and neither the room route nor the `seated` chunk carries
// it (docs/02-architecture.md, "Budgets"). A chunk that cannot load (offline, or an old
// one gone after a redeploy) never breaks the room: the centre says "Cards revealed" and
// the panel stays away, while the seats still show the cards.

export const loadResults = () => import("./results.tsx");

/** Fetches the chunk ahead of the reveal; a failure is left to the lazy components. */
export const prefetchResults = () => {
  loadResults().catch(() => {});
};

/** The centre until the results have loaded, or when they cannot. */
export function CentreFallback() {
  const t = useT();
  return (
    <p data-centre-status="revealed" className="m-0">
      {t("round.revealed")}
    </p>
  );
}

const Nothing = () => null;

export const CentreResult = lazy(async () => {
  const module = await loadResults().catch(() => null);
  return { default: module?.CentreResult ?? CentreFallback };
});

export const ResultsPanel = lazy(async () => {
  const module = await loadResults().catch(() => null);
  return { default: module?.ResultsPanel ?? Nothing };
});

export type { RevealMotion } from "./results.tsx";
