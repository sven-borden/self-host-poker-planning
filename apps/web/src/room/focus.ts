// Where the page puts the focus after the screen changed under it (#19, #21, #32).

/**
 * Once the screen changed under the focus, it goes to `selector`, after a frame for React
 * to draw it, unless the person already moved it somewhere. The page never scrolls for it
 * (`preventScroll`): after a reveal the table, its flips and its result stay where the
 * person was looking, and the PO's decision docks at the bottom of the screen when it
 * fits (#32, `decision-dock.ts`).
 */
export function focusSoon(...selectors: string[]) {
  requestAnimationFrame(() => {
    const active = document.activeElement;
    if (active !== null && active !== document.body) return;
    for (const selector of selectors) {
      const target = document.querySelector<HTMLElement>(selector);
      if (target) {
        target.focus({ preventScroll: true });
        return;
      }
    }
  });
}

/**
 * After the reveal the PO's next step is the final estimate (#32): the focus goes to
 * "Record 8" when a card is preselected, so one press records the suggestion; else to the
 * picker, where the PO picks; then to "Next round" if neither is there.
 */
export const focusAfterReveal = () =>
  focusSoon(
    "[data-record-final]:not([aria-disabled])",
    "[data-final-picker] input:checked",
    "[data-final-picker] input",
    "[data-start-round]",
  );
