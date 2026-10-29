import { afterEach, describe, expect, it, vi } from "vitest";
import {
  externalOrigin,
  type PageViewRouter,
  trackPageViews,
  type UmamiPayload,
  viewedPath,
} from "./page-views.ts";

/** A router whose page the test sets, and which tells its listener on `show`. */
function fakeRouter() {
  let listener: ((event: { pathChanged: boolean }) => void) | undefined;
  const state = { matches: [{ routeId: "__root__" }] };
  const router: PageViewRouter = {
    subscribe: (_event, next) => {
      listener = next;
    },
    state,
  };
  const show = (routeId: string, pathChanged = true) => {
    state.matches = [{ routeId: "__root__" }, { routeId }];
    listener?.({ pathChanged });
  };
  return { router, show, subscribed: () => listener !== undefined };
}

/** Umami's tracker in the page, as the server writes it, and what it sends. */
function addTracker() {
  const script = document.createElement("script");
  script.dataset.websiteId = "6639e935-21ce-47c9-89d2-da5d28b7dc15";
  document.head.append(script);
  const sent: UmamiPayload[] = [];
  const load = () => {
    window.umami = {
      track: (view) =>
        sent.push(
          view({ website: "w", url: window.location.href, referrer: "", title: document.title }),
        ),
    };
    script.dispatchEvent(new Event("load"));
  };
  return { sent, load };
}

afterEach(() => {
  for (const script of document.querySelectorAll("script")) script.remove();
  delete window.umami;
  vi.restoreAllMocks();
});

describe("page views (#40)", () => {
  it("name a page after its route, never its code", () => {
    expect(viewedPath("/")).toBe("/");
    expect(viewedPath("/r/$code")).toBe("/r/:code");
    expect(viewedPath("/dev/table")).toBe("/dev/table");
    expect(viewedPath("__root__")).toBe("/not-found");
    expect(viewedPath(undefined)).toBe("/not-found");
  });

  it("keep another site's origin as the referrer, never this site's address", () => {
    const here = "http://localhost:3000";
    expect(externalOrigin("https://acme.atlassian.net/browse/PP-12?x=1", here)).toBe(
      "https://acme.atlassian.net",
    );
    expect(externalOrigin(`${here}/r/Abc1234567`, here)).toBe("");
    expect(externalOrigin("", here)).toBe("");
    expect(externalOrigin("not a url", here)).toBe("");
  });

  it("do nothing without Umami's tracker in the page", () => {
    const { router, show, subscribed } = fakeRouter();
    trackPageViews(router);
    show("/r/$code");
    expect(subscribed()).toBe(false);
  });

  it("send each new page as its route, waiting for the tracker to load", () => {
    window.history.replaceState(null, "", "/r/Abc1234567?from=link#x");
    document.title = "Poker Planning";
    vi.spyOn(document, "referrer", "get").mockReturnValue(
      "https://acme.atlassian.net/browse/PP-12",
    );
    const tracker = addTracker();
    const { router, show } = fakeRouter();
    trackPageViews(router);
    show("/r/$code");
    expect(tracker.sent).toEqual([]);
    tracker.load();
    show("/r/$code", false);
    show("/");
    show("/r/$code");
    expect(tracker.sent).toEqual([
      {
        website: "w",
        url: `${window.location.origin}/r/:code`,
        referrer: "https://acme.atlassian.net",
        title: "Poker Planning",
      },
      { website: "w", url: `${window.location.origin}/`, referrer: "", title: "Poker Planning" },
      {
        website: "w",
        url: `${window.location.origin}/r/:code`,
        referrer: "",
        title: "Poker Planning",
      },
    ]);
    expect(JSON.stringify(tracker.sent)).not.toMatch(/Abc1234567|from=link|PP-12/);
  });
});
