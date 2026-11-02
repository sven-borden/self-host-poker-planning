import { MAX_QUEUE_ITEMS } from "@pp/domain";
import {
  type ConnectionView,
  type ConnectorBoardView,
  type ConnectorFieldView,
  type ConnectorImportView,
  type ConnectorName,
  type ConnectorSiteView,
  type ConnectorSprintView,
  MAX_JQL_LENGTH,
} from "@pp/protocol";
import { type FormEvent, useCallback, useEffect, useId, useRef, useState } from "react";
import { Button } from "../components/ui/button.tsx";
import { useT } from "../i18n/hooks.ts";
import type { TFunction } from "../i18n/i18n.ts";
import { RoomApiError } from "../rooms/api.ts";
import { isSignedIn, useIdentityStore } from "../stores/identity-store.ts";
import { useRoomStore } from "../stores/room-store.ts";
import { connectorMessage, connectorResult, SYSTEM_NAMES } from "./connector.ts";
import { ConnectorAlert } from "./connector-alert.tsx";
import {
  chooseField,
  chooseSite,
  disconnect,
  fetchBoards,
  fetchConnection,
  fetchFields,
  fetchSites,
  fetchSprints,
  importItems,
  startConnection,
} from "./connector-api.ts";

/** Where a person removes the grant Atlassian keeps: 3LO has no revoke endpoint. */
const GRANTS_URL = "https://id.atlassian.com/manage-profile/apps";

const FIELD =
  "min-h-11 w-full min-w-0 rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 dark:bg-line/30";
const LABEL = "text-sm font-medium";
const HINT = "m-0 text-sm text-ink-2";

/** What the section says of a connection that came back. */
const RESULT_MESSAGES = {
  connected: "connector.result.connected",
  cancelled: "connector.result.cancelled",
  expired: "connector.result.expired",
  failed: "connector.result.failed",
} as const;

/** A refusal: its code, and how long the tracker asked to wait. */
interface Problem {
  code: string;
  retryAfter?: number;
}

function problemOf(error: unknown): Problem {
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
function returnFocus(section: HTMLElement | null, selector: string, frames = 30) {
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

/**
 * The tracker's part of the queue's sheet (#54, ADR-030), a chunk of its own: connect, pick a site
 * and the estimate's field, import. Every step asks the server, and the page holds names and
 * numbers only. Connecting leaves the page; the sheet opens again on the way back and says how
 * it went. The room's code is sent to this server alone: it stays out of the tracker's address.
 */
export function ConnectorSection({ name = "jira" }: { name?: ConnectorName }) {
  const t = useT();
  const signedIn = useIdentityStore(isSignedIn);
  const code = useRoomStore((state) => state.snapshot?.room.code);
  const system = SYSTEM_NAMES[name];
  const [connection, setConnection] = useState<ConnectionView | null>(null);
  const [problem, setProblem] = useState<Problem | null>(null);
  const [busy, setBusy] = useState(false);
  const [result] = useState(connectorResult);
  const section = useRef<HTMLElement>(null);

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

  async function connect() {
    if (code === undefined || busy) return;
    setProblem(null);
    setBusy(true);
    try {
      window.location.assign(await startConnection(name, code));
    } catch (error) {
      setProblem(problemOf(error));
      setBusy(false);
    }
  }

  return (
    <section
      ref={section}
      data-connector={name}
      className="flex flex-col gap-3 border-b border-line px-4 py-3"
    >
      <h3 className="m-0 text-base font-semibold">{system}</h3>
      {result === null ? null : (
        <p role="status" data-connector-result={result} className="m-0 text-sm">
          {t(RESULT_MESSAGES[result], { system })}
        </p>
      )}
      {problem === null ? null : (
        <ConnectorAlert data-connector-problem={problem.code}>
          {connectorMessage(t, problem.code, name, problem.retryAfter)}
        </ConnectorAlert>
      )}
      {!signedIn ? (
        <p data-connector-sign-in className={HINT}>
          {t("connector.signIn", { system })}
        </p>
      ) : connection === null ? null : !connection.connected ? (
        <>
          <p className={HINT}>{t("connector.lede")}</p>
          <Button
            variant="outline"
            data-connector-connect
            aria-disabled={busy || undefined}
            className="self-start"
            onClick={() => void connect()}
          >
            {t("connector.connect", { system })}
          </Button>
        </>
      ) : (
        <Connected
          name={name}
          code={code}
          connection={connection}
          change={change}
          onProblem={report}
          returnTo={(selector) => returnFocus(section.current, selector)}
        />
      )}
    </section>
  );
}

interface ConnectedProps {
  name: ConnectorName;
  code: string | undefined;
  connection: ConnectionView;
  change: (act: () => Promise<void>) => Promise<boolean>;
  onProblem: (problem: Problem | null) => void;
  returnTo: (selector: string) => void;
}

function Connected({ name, code, connection, change, onProblem, returnTo }: ConnectedProps) {
  const t = useT();
  const system = SYSTEM_NAMES[name];
  const [changingSite, setChangingSite] = useState(false);
  const site = connection.site;
  return (
    <>
      {site === undefined || changingSite ? (
        <SitePicker
          name={name}
          current={site?.id}
          onPick={async (id) => {
            const saved = await change(async () => {
              await chooseSite(name, id);
              setChangingSite(false);
            });
            if (saved) returnTo("[data-connector-site-change]");
          }}
          onProblem={onProblem}
        />
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <p data-connector-site-name className="m-0 min-w-0 text-sm break-words">
            {t("connector.connectedTo", { site: site.name })}
          </p>
          <Button variant="ghost" data-connector-site-change onClick={() => setChangingSite(true)}>
            {t("connector.siteChange")}
          </Button>
        </div>
      )}
      {site === undefined || changingSite ? null : (
        <>
          <FieldPicker
            key={site.id}
            name={name}
            current={connection.field}
            onPick={(id) => change(() => chooseField(name, id))}
            onSaved={() => returnTo("[data-connector-field-change]")}
            onProblem={onProblem}
          />
          {code === undefined ? null : <ImportForm name={name} code={code} onProblem={onProblem} />}
        </>
      )}
      <div className="flex flex-col items-start gap-1">
        <Button
          variant="ghost"
          data-connector-disconnect
          onClick={async () => {
            if (await change(() => disconnect(name))) returnTo("[data-connector-connect]");
          }}
        >
          {t("connector.disconnect")}
        </Button>
        <p className={HINT}>
          {t("connector.disconnectNote", { system })}{" "}
          <a
            href={GRANTS_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="text-spruce underline underline-offset-2"
          >
            {t("connector.grantsLink")}
          </a>
        </p>
      </div>
    </>
  );
}

function SitePicker({
  name,
  current,
  onPick,
  onProblem,
}: {
  name: ConnectorName;
  current: string | undefined;
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
  if (sites.length === 0) return <p className={HINT}>{t("connector.noSites", { system })}</p>;
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
        {t("connector.site")}
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
        {t("connector.siteSave")}
      </Button>
    </form>
  );
}

function FieldPicker({
  name,
  current,
  onPick,
  onSaved,
  onProblem,
}: {
  name: ConnectorName;
  current: ConnectorFieldView | undefined;
  onPick: (id: string) => Promise<boolean>;
  onSaved: () => void;
  onProblem: (problem: Problem) => void;
}) {
  const t = useT();
  const ids = { field: useId(), hint: useId() };
  const [open, setOpen] = useState(current === undefined);
  const [fields, setFields] = useState<readonly ConnectorFieldView[] | null>(null);
  const [picked, setPicked] = useState(current?.id ?? "");
  const report = useRef(onProblem);
  report.current = onProblem;

  useEffect(() => {
    if (!open) return;
    let live = true;
    fetchFields(name)
      .then(({ fields: list, guess }) => {
        if (!live) return;
        setFields(list);
        setPicked((now) => now || guess || (list[0]?.id ?? ""));
      })
      .catch((error: unknown) => {
        if (live) report.current(problemOf(error));
      });
    return () => {
      live = false;
    };
  }, [name, open]);

  if (!open) {
    return (
      <div className="flex flex-wrap items-center gap-2">
        <p data-connector-field-name className="m-0 min-w-0 text-sm break-words">
          {t("connector.fieldIs", { field: current?.name ?? "" })}
        </p>
        <Button variant="ghost" data-connector-field-change onClick={() => setOpen(true)}>
          {t("connector.fieldChange")}
        </Button>
      </div>
    );
  }
  if (fields === null) return null;
  if (fields.length === 0) return <p className={HINT}>{t("connector.fieldNone")}</p>;
  return (
    <form
      noValidate
      data-connector-fields
      className="flex flex-col gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        event.stopPropagation();
        if (picked === "") return;
        void onPick(picked).then((saved) => {
          if (!saved) return;
          setOpen(false);
          onSaved();
        });
      }}
    >
      <label htmlFor={ids.field} className={LABEL}>
        {t("connector.field")}
      </label>
      <select
        id={ids.field}
        data-connector-field
        aria-describedby={ids.hint}
        className={FIELD}
        value={picked}
        onChange={(event) => setPicked(event.target.value)}
      >
        {fields.map((field) => (
          <option key={field.id} value={field.id}>
            {field.name}
          </option>
        ))}
      </select>
      <p id={ids.hint} className={HINT}>
        {t("connector.fieldHint")}
      </p>
      <Button type="submit" variant="outline" className="self-start">
        {t("connector.fieldSave")}
      </Button>
    </form>
  );
}

type ImportMode = "sprint" | "jql";

function ImportForm({
  name,
  code,
  onProblem,
}: {
  name: ConnectorName;
  code: string;
  onProblem: (problem: Problem | null) => void;
}) {
  const t = useT();
  const ids = { jql: useId(), hint: useId(), mode: useId() };
  const [mode, setMode] = useState<ImportMode>("sprint");
  const [jql, setJql] = useState("");
  const [sprint, setSprint] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [report, setReport] = useState<string | null>(null);
  const pending = useRef(false);

  async function run(event: FormEvent) {
    event.preventDefault();
    // Inside the subject field's form in React's tree: a submit must not start a round.
    event.stopPropagation();
    if (pending.current) return;
    const query = mode === "jql" ? { jql: jql.trim() } : sprint === null ? null : { sprint };
    if (query === null || ("jql" in query && query.jql === "")) {
      setReport(t("connector.nothingAsked"));
      return;
    }
    pending.current = true;
    setBusy(true);
    setReport(null);
    onProblem(null);
    try {
      setReport(importReport(t, await importItems(name, code, query)));
    } catch (error) {
      onProblem(problemOf(error));
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }

  return (
    <form noValidate data-connector-import onSubmit={run} className="flex flex-col gap-2">
      <fieldset className="m-0 flex flex-wrap gap-x-4 gap-y-1 border-0 p-0">
        <legend className={`${LABEL} mb-1 p-0`}>{t("connector.importFrom")}</legend>
        {(["sprint", "jql"] as const).map((each) => (
          <label key={each} className="flex min-h-11 items-center gap-2 text-sm">
            <input
              type="radio"
              name={ids.mode}
              data-connector-mode={each}
              checked={mode === each}
              onChange={() => setMode(each)}
            />
            {each === "sprint" ? t("connector.bySprint") : t("connector.byJql")}
          </label>
        ))}
      </fieldset>
      {mode === "sprint" ? (
        <SprintPicker name={name} onPick={setSprint} onProblem={onProblem} />
      ) : (
        <>
          <label htmlFor={ids.jql} className={LABEL}>
            {t("connector.jql")}
          </label>
          <textarea
            id={ids.jql}
            data-connector-jql
            rows={3}
            maxLength={MAX_JQL_LENGTH}
            value={jql}
            aria-describedby={ids.hint}
            spellCheck={false}
            autoComplete="off"
            onChange={(event) => setJql(event.target.value)}
            className={`${FIELD} resize-y font-mono`}
          />
          <p id={ids.hint} className={HINT}>
            {t("connector.jqlHint")}
          </p>
        </>
      )}
      <Button
        type="submit"
        data-connector-run
        aria-disabled={busy || undefined}
        className="self-start"
      >
        {busy ? t("connector.importing") : t("connector.import")}
      </Button>
      <div role="status" data-connector-report className="text-sm">
        {report}
      </div>
    </form>
  );
}

function SprintPicker({
  name,
  onPick,
  onProblem,
}: {
  name: ConnectorName;
  onPick: (sprint: number | null) => void;
  onProblem: (problem: Problem | null) => void;
}) {
  const t = useT();
  const ids = { board: useId(), sprint: useId(), filter: useId() };
  const [boards, setBoards] = useState<readonly ConnectorBoardView[] | null>(null);
  const [more, setMore] = useState(false);
  const [filter, setFilter] = useState("");
  const [board, setBoard] = useState<number | null>(null);
  const [sprints, setSprints] = useState<readonly ConnectorSprintView[] | null>(null);
  const report = useRef({ onProblem, onPick });
  report.current = { onProblem, onPick };
  /** A refusal of the last board's sprints, which says nothing about the next board. */
  const refused = useRef(false);

  const find = useCallback(
    async (text: string) => {
      try {
        const found = await fetchBoards(name, text);
        setBoards(found.boards);
        setMore((now) => now || found.more);
        setBoard(found.boards[0]?.id ?? null);
      } catch (error) {
        report.current.onProblem(problemOf(error));
      }
    },
    [name],
  );

  useEffect(() => {
    void find("");
  }, [find]);

  useEffect(() => {
    report.current.onPick(null);
    setSprints(null);
    if (refused.current) {
      refused.current = false;
      report.current.onProblem(null);
    }
    if (board === null) return;
    let live = true;
    fetchSprints(name, board)
      .then((list) => {
        if (!live) return;
        setSprints(list);
        report.current.onPick(list[0]?.id ?? null);
      })
      .catch((error: unknown) => {
        if (!live) return;
        refused.current = true;
        report.current.onProblem(problemOf(error));
      });
    return () => {
      live = false;
    };
  }, [name, board]);

  if (boards === null) return null;
  return (
    <>
      {more ? (
        <>
          <label htmlFor={ids.filter} className={LABEL}>
            {t("connector.boardFilter")}
          </label>
          <div className="flex gap-2">
            <input
              id={ids.filter}
              data-connector-board-filter
              value={filter}
              maxLength={100}
              autoComplete="off"
              onChange={(event) => setFilter(event.target.value)}
              className={FIELD}
            />
            <Button type="button" variant="outline" onClick={() => void find(filter.trim())}>
              {t("connector.boardFind")}
            </Button>
          </div>
        </>
      ) : null}
      {boards.length === 0 ? (
        <p className={HINT}>{t("connector.noBoards")}</p>
      ) : (
        <>
          <label htmlFor={ids.board} className={LABEL}>
            {t("connector.board")}
          </label>
          <select
            id={ids.board}
            data-connector-board
            className={FIELD}
            value={board ?? ""}
            onChange={(event) => setBoard(Number(event.target.value))}
          >
            {boards.map((each) => (
              <option key={each.id} value={each.id}>
                {each.name}
              </option>
            ))}
          </select>
        </>
      )}
      {sprints === null ? null : sprints.length === 0 ? (
        <p className={HINT}>{t("connector.noSprints")}</p>
      ) : (
        <>
          <label htmlFor={ids.sprint} className={LABEL}>
            {t("connector.sprint")}
          </label>
          <select
            id={ids.sprint}
            data-connector-sprint
            className={FIELD}
            onChange={(event) => report.current.onPick(Number(event.target.value))}
          >
            {sprints.map((each) => (
              <option key={each.id} value={each.id}>
                {each.state === "active"
                  ? t("connector.sprintActive", { sprint: each.name })
                  : each.name}
              </option>
            ))}
          </select>
        </>
      )}
    </>
  );
}
