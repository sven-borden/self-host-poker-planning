import { type RefObject, useLayoutEffect, useState } from "react";
import { dockFits } from "./hand-dock.ts";

// The PO's decision after a reveal (#32) docked at the bottom of the screen while its place
// in the page, under the table, is out of view: the PO sees "Record 8" and "Next round"
// beside the table and the subject field, and the reveal never has to scroll the page to
// them. On a desktop the whole bar docks (the picker, "Record", "Next round", "Vote again",
// one row); on a phone only the action row, since a docked picker would hide too much. It
// docks only when the table's centre, with the result, stays in sight above it at the top
// of the page; otherwise the bar stays in the page, as #22's hand does.

/** A phone: the `phone:` variant in styles.css. There only the action row docks. */
export const PHONE_QUERY = "(max-width: 640px)";

/** What must stay in sight above the docked bar: the table's centre, and its result. */
const KEPT_CLEAR =
  "[data-room-table] [data-centre], [data-room-table] [data-centre-status='revealed']";

/** The lowest edge of the table's centre and its result, from the page's top. */
function clearBottom(): number {
  let bottom = 0;
  for (const element of document.querySelectorAll(KEPT_CLEAR)) {
    bottom = Math.max(bottom, element.getBoundingClientRect().bottom + window.scrollY);
  }
  return bottom;
}

/**
 * Whether the decision docks: `bar` on a desktop, `actions` on a phone, when the screen
 * leaves the centre and its result clear above it at the top of the page (`dockFits`).
 * Measured again whenever the page, the docking part or the centre changes size (a
 * rotation, a recorded final, a larger text size, fonts). The docking part's padding and
 * border are the same docked or not and a sticky element moves nothing around it, so the
 * measure cannot flip the state back and forth. While docked, the page's
 * `--decision-dock` holds its height, the scroll padding that keeps a focused control
 * above it (WCAG 2.4.11).
 */
export function useDecisionDock(
  bar: RefObject<HTMLElement | null>,
  actions: RefObject<HTMLElement | null>,
): boolean {
  const [docked, setDocked] = useState(false);
  const [part, setPart] = useState<HTMLElement | null>(null);

  useLayoutEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const phone = window.matchMedia(PHONE_QUERY);
    const observer =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => measure());
    function measure() {
      const element = phone.matches ? actions.current : bar.current;
      // Nothing laid out (a test without layout): nothing to dock.
      if (!element || element.offsetHeight === 0) {
        setDocked(false);
        return;
      }
      for (const centre of document.querySelectorAll(KEPT_CLEAR)) observer?.observe(centre);
      observer?.observe(element);
      setPart(element);
      setDocked(
        dockFits(clearBottom(), element.offsetHeight, document.documentElement.clientHeight),
      );
    }
    measure();
    observer?.observe(document.body);
    window.addEventListener("resize", measure);
    phone.addEventListener("change", measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", measure);
      phone.removeEventListener("change", measure);
    };
  }, [bar, actions]);

  useLayoutEffect(() => {
    if (!docked || part === null) return;
    const root = document.documentElement;
    const keep = () => root.style.setProperty("--decision-dock", `${part.offsetHeight}px`);
    keep();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(keep);
    observer?.observe(part);
    return () => {
      observer?.disconnect();
      root.style.removeProperty("--decision-dock");
    };
  }, [docked, part]);

  return docked;
}
