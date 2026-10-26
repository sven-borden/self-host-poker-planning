// Motion's animation features, loaded as a separate chunk after first render so they do
// not count against the initial JavaScript budget (docs/02-architecture.md, "Budgets").
// domMax includes layout animations, which the hand-to-seat travel needs.
export { domMax as default } from "motion/react";
