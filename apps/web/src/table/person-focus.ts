import { useLayoutEffect, useRef } from "react";

/** Every person's button around the table and in the observers' row, in page order. */
export const personTriggers = () => [
  ...document.querySelectorAll<HTMLElement>("[data-room-table] [data-person-trigger]"),
];

/**
 * After someone's button left the page (removed by the PO, or gone on their own while
 * their popover was open), the focus went with it: it goes to the button that took their
 * place in the page's order (or the last one), once the table has drawn the room without
 * them, unless something else took the focus meanwhile.
 */
export function focusAfterRemoval(id: string, index: number, frames = 10) {
  requestAnimationFrame(() => {
    const list = personTriggers();
    if (list.some((el) => el.dataset.personTrigger === id)) {
      if (frames > 0) focusAfterRemoval(id, index, frames - 1);
      return;
    }
    const active = document.activeElement;
    if (active !== null && active !== document.body && active.isConnected) return;
    list[Math.min(Math.max(index, 0), list.length - 1)]?.focus({ preventScroll: true });
  });
}

/**
 * A seat or an observer whose popover is open when it unmounts (the person left, went
 * away for good or was removed by another tab of the PO) takes the focus with it: it
 * lands on the button that took their place, as after a removal.
 */
export function useFocusAfterRemoval(id: string, open: boolean) {
  const state = useRef({ open, index: -1 });
  useLayoutEffect(() => {
    state.current.open = open;
    if (open) {
      state.current.index = personTriggers().findIndex((el) => el.dataset.personTrigger === id);
    }
  }, [id, open]);
  useLayoutEffect(
    () => () => {
      const { open: wasOpen, index } = state.current;
      if (!wasOpen) return;
      const now = personTriggers().findIndex((el) => el.dataset.personTrigger === id);
      focusAfterRemoval(id, now >= 0 ? now : index);
    },
    [id],
  );
}
