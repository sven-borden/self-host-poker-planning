import { useEffect } from "react";
import { useT } from "../../i18n/hooks.ts";

/**
 * Names the browser tab after the page ("Room not found · Poker Planning") while the
 * component is shown, and gives the previous title back when it goes. Never pass a room
 * code: it is a bearer capability, and tab titles end up in history, bookmarks and
 * screen shares (docs/02-architecture.md, section 11).
 */
export function usePageTitle(page: string) {
  const t = useT();
  const title = `${page} · ${t("app.name")}`;
  useEffect(() => {
    const previous = document.title;
    document.title = title;
    return () => {
      document.title = previous;
    };
  }, [title]);
}
