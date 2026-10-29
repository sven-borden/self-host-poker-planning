/**
 * Page views to Umami (#40), only when the server put Umami's tracker in the page
 * (`observabilityTags` in apps/server/src/observability.ts); otherwise nothing happens.
 * The tracker's automatic tracking is off: it would send the address, and a room's
 * address carries its code, a bearer capability (architecture section 11). Each view is
 * sent from here instead, named after its route (`/r/:code`), without a query string; the
 * referrer is another site's origin on the first view, else nothing. The tracker loads
 * `async`, so a view before it is there waits for it; a blocked tracker sends nothing.
 */
import { hideRoomCodes } from "@pp/domain";

/** What Umami's tracker sends for a view; `track` passes its own to our function. */
export interface UmamiPayload {
  url?: string;
  referrer?: string;
  title?: string;
  [field: string]: unknown;
}

interface Umami {
  track(view: (payload: UmamiPayload) => UmamiPayload): unknown;
}

declare global {
  interface Window {
    umami?: Umami;
  }
}

/** The part of the app's router this needs. */
export interface PageViewRouter {
  subscribe(event: "onResolved", listener: (event: { pathChanged: boolean }) => void): unknown;
  readonly state: { readonly matches: readonly { readonly routeId: string }[] };
}

/** Views kept while the tracker loads; more would be a page stuck without it. */
const WAITING_MAX = 10;

/** A route as Umami sees it: `/r/:code` for `/r/$code`; no route is `/not-found`. */
export function viewedPath(routeId: string | undefined): string {
  if (!routeId || routeId === "__root__") return "/not-found";
  return hideRoomCodes(routeId.replace(/\$(\w+)/g, ":$1"));
}

/** Another site's origin, for the first view's referrer; this site or none is "". */
export function externalOrigin(referrer: string, origin: string): string {
  if (!URL.canParse(referrer)) return "";
  const from = new URL(referrer).origin;
  return from === origin || from === "null" ? "" : from;
}

/** Sends a view per page the router shows, from the first one on. Call before it loads. */
export function trackPageViews(router: PageViewRouter, win: Window = window): void {
  const tracker = win.document.querySelector<HTMLScriptElement>("script[data-website-id]");
  if (!tracker) return;
  const origin = win.location.origin;
  let referrer = externalOrigin(win.document.referrer, origin);
  const waiting: string[] = [];
  const send = (path: string) => {
    const from = referrer;
    referrer = "";
    win.umami?.track((payload) => ({
      ...payload,
      url: `${origin}${path}`,
      referrer: from,
      title: hideRoomCodes(String(payload.title ?? "")),
    }));
  };
  tracker.addEventListener("load", () => waiting.splice(0).forEach(send), { once: true });
  router.subscribe("onResolved", ({ pathChanged }) => {
    if (!pathChanged) return;
    const path = viewedPath(router.state.matches.at(-1)?.routeId);
    if (win.umami) send(path);
    else if (waiting.length < WAITING_MAX) waiting.push(path);
  });
}
