import { useSyncExternalStore } from "react";
import { PHONE_MAX_WIDTH, type TableVariant } from "./layout.ts";

/** Same breakpoint as the `phone:` variant in styles.css. */
export const PHONE_QUERY = `(max-width: ${PHONE_MAX_WIDTH}px)`;

function subscribe(onChange: () => void): () => void {
  const query = window.matchMedia(PHONE_QUERY);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

const current = (): TableVariant => (window.matchMedia(PHONE_QUERY).matches ? "phone" : "desktop");

/** "phone" at 640 px and below, "desktop" above; follows the viewport as it changes. */
export function useTableVariant(): TableVariant {
  return useSyncExternalStore(subscribe, current, () => "desktop");
}
