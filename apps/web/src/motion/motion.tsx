import { type HTMLMotionProps, LazyMotion, MotionConfig, m, useReducedMotion } from "motion/react";
import type { ReactNode } from "react";

// Motion with a job (docs/03-design-brief.md, "Motion spec"): short, interruptible, and
// replaced by 120 ms cross-fades when the person asks for reduced motion.

/** The design brief's easing: cubic-bezier(.2, .8, .2, 1). */
export const EASE_STANDARD = [0.2, 0.8, 0.2, 1] as const;

/** Duration of the cross-fade that replaces any travel under reduced motion, in seconds. */
export const REDUCED_FADE_SECONDS = 0.12;

const loadFeatures = () => import("./features.ts").then((module) => module.default);

/**
 * Wraps the app once. Every Motion component honours `prefers-reduced-motion` for
 * transforms and layout, and the animation features load lazily: use `m.div` (not
 * `motion.div`, which `strict` refuses) so the full Motion bundle stays out of the
 * initial chunk.
 */
export function AppMotionConfig({ children }: { children: ReactNode }) {
  return (
    <LazyMotion features={loadFeatures} strict>
      <MotionConfig reducedMotion="user">{children}</MotionConfig>
    </LazyMotion>
  );
}

/** True when the person asked for reduced motion; components then cross-fade instead. */
export function usePrefersReducedMotion(): boolean {
  return useReducedMotion() ?? false;
}

type RiseInProps = Omit<HTMLMotionProps<"div">, "initial" | "animate" | "transition"> & {
  /** Delay before the element appears, in seconds (for staggering). */
  delay?: number;
};

/**
 * Rises 12 px and fades in over 260 ms, like the hand dealing in. Under reduced motion it
 * only cross-fades for 120 ms, with no travel.
 */
export function RiseIn({ delay = 0, ...props }: RiseInProps) {
  const reduced = usePrefersReducedMotion();
  return (
    <m.div
      initial={reduced ? { opacity: 0 } : { opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={
        reduced
          ? { duration: REDUCED_FADE_SECONDS }
          : { duration: 0.26, ease: EASE_STANDARD, delay }
      }
      {...props}
    />
  );
}
