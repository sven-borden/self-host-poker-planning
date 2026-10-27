import { type RefObject, useLayoutEffect, useState } from "react";

// The hand docked at the bottom of an upright phone while the team votes (#22). It docks
// only when the screen is tall enough: at the top of the page, the table (the PO's "Reveal
// cards" in its centre, the viewer's seat and slot at its bottom) must end above the docked
// hand. Otherwise the hand stays in the page, under the table, and covers nothing.

/** An upright phone: the `thumb:` variant in styles.css. */
export const THUMB_QUERY = "(max-width: 640px) and (min-height: 520px)";

/** What must never lie under the docked hand: the table, and the viewer's seat and slot. */
const KEPT_CLEAR = "[data-room-table] [data-stage], [data-room-table] [data-you]";

/**
 * Whether the docked hand leaves room for what lies above it at the top of the page:
 * `clearBottom`, the lowest edge that must stay in sight, measured from the page's top,
 * ends at or above the dock's top edge.
 */
export function dockFits(clearBottom: number, dockHeight: number, viewport: number): boolean {
  return clearBottom + dockHeight <= viewport;
}

/**
 * The hand panel's height once docked. Docked, its hint is for screen readers only and its
 * bottom border goes; in the page it shows both, so they are taken off. The padding is the
 * same either way (styles in `Seated`), so the measure does not depend on the state.
 */
function dockHeight(panel: HTMLElement, docked: boolean): number {
  if (docked) return panel.offsetHeight;
  const hint = panel.querySelector<HTMLElement>("[data-hand-hint]");
  const border = Number.parseFloat(getComputedStyle(panel).borderBottomWidth) || 0;
  return panel.offsetHeight - (hint?.offsetHeight ?? 0) - border;
}

/** The lowest edge of what must stay clear of the dock, from the page's top. */
function clearBottom(): number {
  let bottom = 0;
  for (const element of document.querySelectorAll(KEPT_CLEAR)) {
    bottom = Math.max(bottom, element.getBoundingClientRect().bottom + window.scrollY);
  }
  return bottom;
}

/**
 * Whether the hand docks: `wanted` (the hand is playable) on an upright phone whose screen
 * leaves the table clear above the dock (`dockFits`). Measured again whenever the page or
 * the panel changes size (a rotation, a longer subject, a larger text size, fonts). The
 * position of a sticky element does not change the layout around it, so the measure
 * cannot flip the state back and forth. While docked, the page's `--hand-dock` holds the
 * dock's height, the scroll padding that keeps a focused seat or button above it.
 */
export function useHandDock(wanted: boolean, panel: RefObject<HTMLElement | null>): boolean {
  const [fits, setFits] = useState(false);
  const docked = wanted && fits;

  useLayoutEffect(() => {
    if (!wanted || typeof window.matchMedia !== "function") return;
    const upright = window.matchMedia(THUMB_QUERY);
    const measure = () => {
      const element = panel.current;
      if (!element || !upright.matches) {
        setFits(false);
        return;
      }
      const height = dockHeight(element, element.hasAttribute("data-hand-dock"));
      const viewport = document.documentElement.clientHeight;
      setFits(dockFits(clearBottom(), height, viewport));
    };
    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(document.body);
    if (panel.current) observer?.observe(panel.current);
    window.addEventListener("resize", measure);
    upright.addEventListener("change", measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", measure);
      upright.removeEventListener("change", measure);
    };
  }, [wanted, panel]);

  useLayoutEffect(() => {
    const element = panel.current;
    if (!docked || !element) return;
    const root = document.documentElement;
    const keep = () => root.style.setProperty("--hand-dock", `${element.offsetHeight}px`);
    keep();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(keep);
    observer?.observe(element);
    return () => {
      observer?.disconnect();
      root.style.removeProperty("--hand-dock");
    };
  }, [docked, panel]);

  return docked;
}

/**
 * Whether a box lies wholly in sight: on screen, and above the docked hand when there is
 * one. A vote's flight lands only on a slot in sight (#22).
 */
export function inSight(
  box: { top: number; bottom: number },
  viewport: number,
  dock: { top: number } | null,
): boolean {
  return box.top >= 0 && box.bottom <= (dock ? Math.min(dock.top, viewport) : viewport);
}
