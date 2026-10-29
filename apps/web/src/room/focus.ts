// Where the page puts the focus after the screen changed under it (#19, #21, #32).

/**
 * Once the screen changed under the focus, it goes to `selector`, after a frame for React
 * to draw it, unless the person already moved it somewhere. The page does not scroll for
 * a target already on screen (`preventScroll`): after a reveal the table, its flips and
 * its result stay where the person was looking, and the PO's decision docks at the bottom
 * of the screen when it fits (#32, `decision-dock.ts`). A target wholly off screen gets
 * the least scroll that shows it (#37, WCAG 2.4.7): the hand after "Start voting" sits
 * under the fold of a laptop's screen, and the focus must never be out of sight.
 */
export function focusSoon(...selectors: string[]) {
  requestAnimationFrame(() => {
    const active = document.activeElement;
    if (active !== null && active !== document.body) return;
    for (const selector of selectors) {
      const target = document.querySelector<HTMLElement>(selector);
      if (target) {
        target.focus({ preventScroll: true });
        const box = target.getBoundingClientRect();
        if (box.bottom <= 0 || box.top >= window.innerHeight) {
          target.scrollIntoView?.({ block: "nearest" });
        }
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
/** The PO's decision after a reveal, in the order `focusAfterReveal` tries it. */
export const AFTER_REVEAL = [
  "[data-record-final]:not([aria-disabled])",
  "[data-final-picker] input:checked",
  "[data-final-picker] input",
  "[data-start-round]",
] as const;

export const focusAfterReveal = () => focusSoon(...AFTER_REVEAL);

/**
 * After a voter's reveal (#28): voters have no decision to make, so the focus goes to the
 * result in the centre. While the round still votes (the PO took the reveal back, and
 * the voter's button left with the focus on it), to the count.
 */
export const AFTER_VOTER_REVEAL = [
  "[data-centre-status='revealed']",
  "[data-centre-status='voting']",
] as const;

export const focusAfterVoterReveal = () => focusSoon(...AFTER_VOTER_REVEAL);
