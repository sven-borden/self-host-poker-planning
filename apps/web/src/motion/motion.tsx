import { LazyMotion, MotionConfig, useReducedMotion } from "motion/react";
import type { ComponentProps, CSSProperties, ReactNode } from "react";
import { cn } from "../lib/utils.ts";

// Motion with a job (docs/03-design-brief.md, "Motion spec"): short, interruptible, and
// replaced by 120 ms cross-fades when the person asks for reduced motion.

/** The design brief's easing: cubic-bezier(.2, .8, .2, 1). */
export const EASE_STANDARD = [0.2, 0.8, 0.2, 1] as const;

/** Duration of the cross-fade that replaces any travel under reduced motion, in seconds. */
export const REDUCED_FADE_SECONDS = 0.12;

const loadAnimation = () => import("./features.ts").then((module) => module.default);
const loadLayout = () => import("./features-max.ts").then((module) => module.default);

/**
 * Wraps the app once: every Motion component honours `prefers-reduced-motion` for
 * transforms and layout. It loads no animation code by itself.
 */
export function AppMotionConfig({ children }: { children: ReactNode }) {
  return <MotionConfig reducedMotion="user">{children}</MotionConfig>;
}

/**
 * Wrap the `m.*` elements of an animated component in this. Motion's features chunk is
 * fetched when the first such component mounts, never at page load; `layout` asks for
 * the larger set with layout animations. Use `m.div`, never `motion.div` (Biome refuses
 * the import, and `strict` throws), so the full Motion bundle stays out of every chunk.
 */
export function MotionFeatures({
  layout = false,
  children,
}: {
  layout?: boolean;
  children: ReactNode;
}) {
  return (
    <LazyMotion features={layout ? loadLayout : loadAnimation} strict>
      {children}
    </LazyMotion>
  );
}

/** True when the person asked for reduced motion; components then cross-fade instead. */
export function usePrefersReducedMotion(): boolean {
  return useReducedMotion() ?? false;
}

type RiseInProps = ComponentProps<"div"> & {
  /** Delay before the element appears, in seconds (for staggering). */
  delay?: number;
};

/**
 * Rises 12 px and fades in over 260 ms, like the hand dealing in. Under reduced motion it
 * only cross-fades for 120 ms, with no travel (styles.css shortens every animation).
 *
 * Pure CSS (tw-animate-css), not Motion: page content must never wait for a JavaScript
 * chunk to become visible. Without the animation the element simply shows.
 */
export function RiseIn({ delay = 0, className, style, ...props }: RiseInProps) {
  const delayStyle: CSSProperties | undefined =
    delay > 0 ? { animationDelay: `${delay}s`, ...style } : style;
  return (
    <div
      className={cn(
        "animate-in fade-in slide-in-from-bottom-3 ease-standard animation-duration-260 fill-mode-backwards",
        "motion-reduce:[--tw-enter-translate-y:0]",
        className,
      )}
      style={delayStyle}
      {...props}
    />
  );
}
