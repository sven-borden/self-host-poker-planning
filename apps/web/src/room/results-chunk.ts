import { lazy } from "react";

// The results (#20) are a chunk of their own: `Seated` prefetches it while a round is on,
// so it is there by the reveal, and neither the room route nor the `seated` chunk carries
// it (docs/02-architecture.md, "Budgets").

export const loadResults = () => import("./results.tsx");

export const CentreResult = lazy(() =>
  loadResults().then((module) => ({ default: module.CentreResult })),
);

export const ResultsPanel = lazy(() =>
  loadResults().then((module) => ({ default: module.ResultsPanel })),
);

export type { RevealMotion } from "./results.tsx";
