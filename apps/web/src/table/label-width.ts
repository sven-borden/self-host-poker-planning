import { useSyncExternalStore } from "react";

// How wide a card label is drawn (#26 review): measured in the page, in Archivo ExtraBold
// at the card's width axis, so a custom label such as "WWWW", "ÆÆÆÆ" or "½½½½" fits by
// its real width instead of an estimate per letter. Canvas `measureText` was the first
// idea, but a canvas font takes only keyword widths (75 %, 112.5 %), not the faces' 110 %
// and 70 %; a hidden span with the faces' own classes measures exactly what is drawn,
// emoji in their own font included.

/** The size the probe measures at: widths scale linearly with the font size. */
const PROBE_PX = 100;

/** Widths in em by `stretch|label`, kept once the faces' font has loaded. */
const widths = new Map<string, number>();

let probe: HTMLSpanElement | null = null;

function probeSpan(): HTMLSpanElement | null {
  if (typeof document === "undefined" || !document.fonts || !document.body) return null;
  if (probe?.isConnected) return probe;
  probe = document.createElement("span");
  probe.setAttribute("aria-hidden", "true");
  probe.dataset.labelProbe = "";
  // The faces' font (CARD_FACE): the display family, extra bold.
  probe.className = "font-display font-extrabold";
  probe.style.cssText = `position:fixed;left:-10000px;top:0;visibility:hidden;white-space:pre;font-size:${PROBE_PX}px;line-height:1;pointer-events:none`;
  document.body.append(probe);
  return probe;
}

/**
 * The width of `label` in ems of the faces' font at `stretch` % width, or null when it
 * cannot be measured yet: no DOM (tests), or the font has not loaded. Probing puts the
 * text in the page, which makes the browser load the font; `useLabelFonts` re-renders
 * the cards once it has.
 */
export function measuredEms(label: string, stretch: 70 | 110): number | null {
  const key = `${stretch}|${label}`;
  const known = widths.get(key);
  if (known !== undefined) return known;
  const span = probeSpan();
  if (span === null) return null;
  span.style.fontStretch = `${stretch}%`;
  span.textContent = label;
  const family = getComputedStyle(span).fontFamily;
  if (!family || !document.fonts.check(`800 ${PROBE_PX}px ${family}`, label)) return null;
  const width = span.getBoundingClientRect().width / PROBE_PX;
  if (!(width > 0)) return null;
  widths.set(key, width);
  return width;
}

let loads = 0;
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  if (typeof document === "undefined" || !document.fonts) return () => {};
  if (listeners.size === 0) document.fonts.addEventListener("loadingdone", onLoaded);
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) document.fonts.removeEventListener("loadingdone", onLoaded);
  };
}

function onLoaded() {
  loads += 1;
  for (const listener of listeners) listener();
}

/** Re-renders a card label once a font finishes loading, so it is measured in it. */
export function useLabelFonts(): number {
  return useSyncExternalStore(
    subscribe,
    () => loads,
    () => 0,
  );
}
