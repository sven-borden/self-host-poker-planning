// Motion's animation features without layout animations (domAnimation, about half of
// domMax), loaded as a separate chunk the first time an animated component mounts, so they
// never count against the initial JavaScript budget (docs/02-architecture.md, "Budgets").
export { domAnimation as default } from "motion/react";
