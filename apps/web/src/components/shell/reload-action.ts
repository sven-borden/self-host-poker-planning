import type { TFunction } from "../../i18n/i18n.ts";

/**
 * The button a toast shows beside copy that asks for a reload. An installed app (#46) runs in
 * a window with no browser controls, and can resume on an old build, so the page offers the
 * reload itself, whatever the display mode.
 */
export function reloadAction(t: TFunction) {
  return { label: t("room.reload"), onClick: () => window.location.reload() };
}
