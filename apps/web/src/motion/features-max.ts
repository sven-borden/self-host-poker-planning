// Motion's full feature set (domMax): domAnimation plus layout animations and drag. Only
// a component that needs a layout animation loads it, through <MotionFeatures layout>.
// Nothing does yet: the hand-to-seat travel (#18) uses the Web Animations API, because
// importing `m` from a lazy chunk cost the room route 12.8 kB (ADR-008, web README).
export { domMax as default } from "motion/react";
