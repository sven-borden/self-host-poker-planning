import { MAX_QUEUE_ITEMS } from "@pp/domain";
import type {
  ConnectionView,
  ConnectorImportView,
  ConnectorName,
  ConnectorSiteView,
} from "@pp/protocol";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Button } from "../components/ui/button.tsx";
import { useT } from "../i18n/hooks.ts";
import type { TFunction } from "../i18n/i18n.ts";
import { RoomApiError } from "../rooms/api.ts";
import { SYSTEM_NAMES } from "./connector.ts";
import { fetchConnection, fetchSites } from "./connector-api.ts";

// What the trackers' sections share. A file of its own, and not one section importing the other, so
// that each section's chunk loads or fails by itself.

export const FIELD =
  "min-h-11 w-full min-w-0 rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 dark:bg-line/30";
export const LABEL = "text-sm font-medium";
export const HINT = "m-0 text-sm text-ink-2";

/** A refusal: its code, and how long the tracker asked to wait. */
export interface Problem {
  code: string;
  retryAfter?: number;
}

export function problemOf(error: unknown): Problem {
  if (!(error instanceof RoomApiError)) return { code: "unknown" };
  return {
    code: error.code,
    ...(error.retryAfter === undefined ? {} : { retryAfter: error.retryAfter }),
  };
}

/**
 * After a change that took away the control that opened it: the focus goes to its `selector`,
 * once that is drawn, and not to the sheet's root, where the sheet's focus trap leaves it. A focus
 * the person already moved somewhere stays there.
 */
export function returnFocus(section: HTMLElement | null, selector: string, frames = 30) {
  requestAnimationFrame(() => {
    const active = document.activeElement;
    const lost =
      active === null || active === document.body || active.getAttribute("role") === "dialog";
    if (!lost && !section?.contains(active)) return;
    const target = section?.querySelector<HTMLElement>(selector);
    if (target) target.focus();
    else if (frames > 0) returnFocus(section, selector, frames - 1);
  });
}

/** What the sheet says after an import: every count that is not zero, in one line. */
export function importReport(t: TFunction, view: ConnectorImportView): string {
  const parts = [view.added > 0 ? t("queue.added", { count: view.added }) : t("queue.addedNone")];
  if (view.duplicates > 0) parts.push(t("queue.duplicates", { count: view.duplicates }));
  if (view.shortened > 0) parts.push(t("queue.shortened", { count: view.shortened }));
  if (view.leftOut > 0) parts.push(t("connector.leftOut", { count: view.leftOut }));
  if (view.beyond === null) parts.push(t("connector.beyondUnknown", { max: MAX_QUEUE_ITEMS }));
  else if (view.beyond > 0) {
    parts.push(t("connector.beyond", { count: view.beyond, max: MAX_QUEUE_ITEMS }));
  }
  return parts.join(" ");
}

/** A person's connection to a tracker, and how a change at the server or a refusal lands on it. */
export function useConnection(name: ConnectorName, signedIn: boolean) {
  const [connection, setConnection] = useState<ConnectionView | null>(null);
  const [problem, setProblem] = useState<Problem | null>(null);

  const load = useCallback(async () => {
    try {
      setConnection(await fetchConnection(name));
    } catch (error) {
      setProblem(problemOf(error));
    }
  }, [name]);

  useEffect(() => {
    if (signedIn) void load();
  }, [load, signedIn]);

  /** Every refusal comes here. A grant found dead took the row: back to "Connect", wherever. */
  const report = useCallback(
    (found: Problem | null) => {
      setProblem(found);
      if (found?.code === "connector_reconnect") void load();
    },
    [load],
  );

  /** A change at the server, then a fresh look at the connection. True when it went through. */
  async function change(act: () => Promise<void>): Promise<boolean> {
    setProblem(null);
    try {
      await act();
      await load();
      return true;
    } catch (error) {
      report(problemOf(error));
      return false;
    }
  }

  return { connection, problem, setProblem, load, report, change };
}

export function SitePicker({
  name,
  current,
  words,
  onPick,
  onProblem,
}: {
  name: ConnectorName;
  current: string | undefined;
  /** What a site is called at this tracker, when it is not a site. */
  words?: { label: string; save: string; none: string };
  onPick: (id: string) => Promise<void>;
  onProblem: (problem: Problem) => void;
}) {
  const t = useT();
  const id = useId();
  const system = SYSTEM_NAMES[name];
  const [sites, setSites] = useState<readonly ConnectorSiteView[] | null>(null);
  const [picked, setPicked] = useState(current ?? "");
  const report = useRef(onProblem);
  report.current = onProblem;

  useEffect(() => {
    let live = true;
    fetchSites(name)
      .then((list) => {
        if (!live) return;
        setSites(list);
        setPicked((now) => now || (list[0]?.id ?? ""));
      })
      .catch((error: unknown) => {
        if (live) report.current(problemOf(error));
      });
    return () => {
      live = false;
    };
  }, [name]);

  if (sites === null) return null;
  if (sites.length === 0) {
    return <p className={HINT}>{words?.none ?? t("connector.noSites", { system })}</p>;
  }
  return (
    <form
      noValidate
      data-connector-sites
      className="flex flex-col gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        event.stopPropagation();
        if (picked !== "") void onPick(picked);
      }}
    >
      <label htmlFor={id} className={LABEL}>
        {words?.label ?? t("connector.site")}
      </label>
      <select
        id={id}
        data-connector-site
        className={FIELD}
        value={picked}
        onChange={(event) => setPicked(event.target.value)}
      >
        {sites.map((site) => (
          <option key={site.id} value={site.id}>
            {site.name}
          </option>
        ))}
      </select>
      <Button type="submit" variant="outline" className="self-start">
        {words?.save ?? t("connector.siteSave")}
      </Button>
    </form>
  );
}
