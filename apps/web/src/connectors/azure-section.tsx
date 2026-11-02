import {
  ADO_ORGANIZATION,
  type ConnectionView,
  type ConnectorFieldView,
  type ConnectorSiteView,
  MAX_WIQL_LENGTH,
} from "@pp/protocol";
import { type FormEvent, useEffect, useId, useRef, useState } from "react";
import { Button } from "../components/ui/button.tsx";
import { useT } from "../i18n/hooks.ts";
import { isSignedIn, useIdentityStore } from "../stores/identity-store.ts";
import { useRoomStore } from "../stores/room-store.ts";
import { connectorMessage, SYSTEM_NAMES } from "./connector.ts";
import { ConnectorAlert } from "./connector-alert.tsx";
import {
  chooseSite,
  chooseTypedField,
  clearField,
  connectAzure,
  disconnect,
  fetchSavedQueries,
  fetchTypeFields,
  fetchTypes,
  importItems,
} from "./connector-api.ts";
import {
  FIELD,
  HINT,
  importReport,
  LABEL,
  type Problem,
  problemOf,
  returnFocus,
  SitePicker,
  useConnection,
} from "./connector-section.tsx";

const NAME = "azure-devops";
const SYSTEM = SYSTEM_NAMES[NAME];
const LINK = "text-spruce underline underline-offset-2";

/** Microsoft's guide, for as long as no organisation is typed that the page can link to. */
const TOKENS_GUIDE =
  "https://learn.microsoft.com/azure/devops/organizations/accounts/use-personal-access-tokens-to-authenticate";

/** Where a person makes and revokes tokens: Azure DevOps' own page, in their organisation. */
const tokensPage = (organization: string) =>
  `https://dev.azure.com/${organization}/_usersSettings/tokens`;

/**
 * Azure DevOps in the queue's sheet (#55, ADR-031), a chunk of its own: a person gives an
 * organisation and a token of their own, then picks a project, says where estimates go if not to
 * the field each item's type carries, and imports. The token goes to this server once, in a body,
 * is cleared from the page at that moment, and never comes back: the server holds it sealed, and
 * every other answer here is a name or a number.
 */
export function AzureSection() {
  const t = useT();
  const signedIn = useIdentityStore(isSignedIn);
  const code = useRoomStore((state) => state.snapshot?.room.code);
  const { connection, problem, setProblem, report, change, load } = useConnection(NAME, signedIn);
  const section = useRef<HTMLElement>(null);
  const returnTo = (selector: string) => returnFocus(section.current, selector);

  return (
    <section
      ref={section}
      data-connector={NAME}
      className="flex flex-col gap-3 border-b border-line px-4 py-3"
    >
      <h3 className="m-0 text-base font-semibold">{SYSTEM}</h3>
      {problem === null ? null : (
        <ConnectorAlert data-connector-problem={problem.code}>
          {connectorMessage(t, problem.code, NAME, problem.retryAfter)}
        </ConnectorAlert>
      )}
      {!signedIn ? (
        <p data-connector-sign-in className={HINT}>
          {t("connector.signIn", { system: SYSTEM })}
        </p>
      ) : connection === null ? null : !connection.connected ? (
        <TokenForm
          onProblem={setProblem}
          onConnected={async () => {
            await load();
            returnTo("select, [data-connector-site-change]");
          }}
        />
      ) : (
        <Connected
          code={code}
          connection={connection}
          change={change}
          onProblem={report}
          returnTo={returnTo}
        />
      )}
    </section>
  );
}

function TokenForm({
  onProblem,
  onConnected,
}: {
  onProblem: (problem: Problem | null) => void;
  onConnected: () => Promise<void>;
}) {
  const t = useT();
  const ids = { organization: useId(), token: useId(), place: useId(), scope: useId() };
  const [organization, setOrganization] = useState("");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const name = organization.trim();

  async function send(event: FormEvent) {
    event.preventDefault();
    // Inside the subject field's form in React's tree: a submit must not start a round.
    event.stopPropagation();
    if (pending.current) return;
    if (!ADO_ORGANIZATION.test(name)) {
      onProblem({ code: "connector_bad_organization" });
      return;
    }
    const pasted = token.trim();
    if (pasted === "") {
      onProblem({ code: "connector_bad_token" });
      return;
    }
    pending.current = true;
    setBusy(true);
    setToken("");
    onProblem(null);
    try {
      await connectAzure(name, pasted);
      await onConnected();
    } catch (error) {
      onProblem(problemOf(error));
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }

  return (
    <form noValidate data-connector-token onSubmit={send} className="flex flex-col gap-2">
      <p className={HINT}>{t("connector.azure.lede")}</p>
      <label htmlFor={ids.organization} className={LABEL}>
        {t("connector.azure.organization")}
      </label>
      <input
        id={ids.organization}
        data-connector-organization
        value={organization}
        maxLength={50}
        autoComplete="off"
        autoCapitalize="none"
        spellCheck={false}
        aria-describedby={ids.place}
        onChange={(event) => setOrganization(event.target.value)}
        className={FIELD}
      />
      <p id={ids.place} className={HINT}>
        {t("connector.azure.organizationHint")}
      </p>
      <label htmlFor={ids.token} className={LABEL}>
        {t("connector.azure.token")}
      </label>
      <input
        id={ids.token}
        data-connector-pat
        type="password"
        value={token}
        autoComplete="off"
        autoCapitalize="none"
        spellCheck={false}
        aria-describedby={ids.scope}
        onChange={(event) => setToken(event.target.value)}
        className={FIELD}
      />
      <div id={ids.scope} className="flex flex-col gap-1">
        <p className={HINT}>
          {t("connector.azure.tokenScope")}{" "}
          <a
            data-connector-tokens-link
            href={ADO_ORGANIZATION.test(name) ? tokensPage(name) : TOKENS_GUIDE}
            target="_blank"
            rel="noopener noreferrer"
            className={LINK}
          >
            {t("connector.azure.tokenLink")}
          </a>
        </p>
        <p className={HINT}>{t("connector.azure.tokenUse")}</p>
      </div>
      <Button
        type="submit"
        variant="outline"
        data-connector-connect
        aria-disabled={busy || undefined}
        className="self-start"
      >
        {t("connector.connect", { system: SYSTEM })}
      </Button>
    </form>
  );
}

interface ConnectedProps {
  code: string | undefined;
  connection: ConnectionView;
  change: (act: () => Promise<void>) => Promise<boolean>;
  onProblem: (problem: Problem | null) => void;
  returnTo: (selector: string) => void;
}

function Connected({ code, connection, change, onProblem, returnTo }: ConnectedProps) {
  const t = useT();
  const [changing, setChanging] = useState(false);
  const { site, organization = "" } = connection;
  return (
    <>
      <p data-connector-organization-name className="m-0 min-w-0 text-sm break-words">
        {t("connector.connectedTo", { site: organization })}
      </p>
      {site === undefined || changing ? (
        <SitePicker
          name={NAME}
          current={site?.id}
          words={{
            label: t("connector.azure.project"),
            save: t("connector.azure.projectSave"),
            none: t("connector.azure.noProjects"),
          }}
          onPick={async (id) => {
            const saved = await change(async () => {
              await chooseSite(NAME, id);
              setChanging(false);
            });
            if (saved) returnTo("[data-connector-site-change]");
          }}
          onProblem={onProblem}
        />
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <p data-connector-site-name className="m-0 min-w-0 text-sm break-words">
            {t("connector.azure.projectIs", { project: site.name })}
          </p>
          <Button variant="ghost" data-connector-site-change onClick={() => setChanging(true)}>
            {t("connector.azure.projectChange")}
          </Button>
        </div>
      )}
      {site === undefined || changing ? null : (
        <>
          <FieldChoice
            key={site.id}
            current={connection.field}
            change={change}
            onProblem={onProblem}
            returnTo={returnTo}
          />
          {code === undefined ? null : (
            <ImportForm key={`import-${site.id}`} code={code} onProblem={onProblem} />
          )}
        </>
      )}
      <div className="flex flex-col items-start gap-1">
        <Button
          variant="ghost"
          data-connector-disconnect
          onClick={async () => {
            if (await change(() => disconnect(NAME))) returnTo("[data-connector-organization]");
          }}
        >
          {t("connector.disconnect")}
        </Button>
        <p className={HINT}>
          {t("connector.azure.disconnectNote")}{" "}
          <a
            data-connector-revoke-link
            href={ADO_ORGANIZATION.test(organization) ? tokensPage(organization) : TOKENS_GUIDE}
            target="_blank"
            rel="noopener noreferrer"
            className={LINK}
          >
            {t("connector.azure.revokeLink")}
          </a>
        </p>
      </div>
    </>
  );
}

/**
 * Each item's estimate goes to the field its type carries, and the server reads that for the
 * item. A process of its own can name it otherwise: a person then picks a type, and one of that
 * type's number fields, for this connection.
 */
function FieldChoice({
  current,
  change,
  onProblem,
  returnTo,
}: {
  current: ConnectorFieldView | undefined;
  change: (act: () => Promise<void>) => Promise<boolean>;
  onProblem: (problem: Problem | null) => void;
  returnTo: (selector: string) => void;
}) {
  const t = useT();
  const ids = { type: useId(), field: useId(), hint: useId() };
  const [open, setOpen] = useState(false);
  const [types, setTypes] = useState<readonly string[] | null>(null);
  const [type, setType] = useState("");
  const [fields, setFields] = useState<readonly ConnectorFieldView[] | null>(null);
  const [picked, setPicked] = useState("");
  const report = useRef(onProblem);
  report.current = onProblem;

  useEffect(() => {
    if (!open) return;
    let live = true;
    fetchTypes(NAME)
      .then((list) => {
        if (!live) return;
        setTypes(list);
        setType((now) => now || (list[0] ?? ""));
      })
      .catch((error: unknown) => {
        if (live) report.current(problemOf(error));
      });
    return () => {
      live = false;
    };
  }, [open]);

  useEffect(() => {
    setFields(null);
    if (!open || type === "") return;
    let live = true;
    fetchTypeFields(NAME, type)
      .then(({ fields: list, guess }) => {
        if (!live) return;
        setFields(list);
        setPicked(
          current && list.some(({ id }) => id === current.id)
            ? current.id
            : (guess ?? list[0]?.id ?? ""),
        );
      })
      .catch((error: unknown) => {
        if (live) report.current(problemOf(error));
      });
    return () => {
      live = false;
    };
  }, [open, type, current]);

  if (!open) {
    return (
      <div className="flex flex-wrap items-center gap-2">
        <p data-connector-field-name className="m-0 min-w-0 text-sm break-words">
          {current === undefined
            ? t("connector.azure.fieldAuto")
            : t("connector.fieldIs", { field: current.name })}
        </p>
        <Button variant="ghost" data-connector-field-change onClick={() => setOpen(true)}>
          {t("connector.azure.fieldPick")}
        </Button>
        {current === undefined ? null : (
          <Button
            variant="ghost"
            data-connector-field-reset
            onClick={async () => {
              if (await change(() => clearField(NAME))) returnTo("[data-connector-field-change]");
            }}
          >
            {t("connector.azure.fieldReset")}
          </Button>
        )}
      </div>
    );
  }
  if (types === null) return null;
  return (
    <form
      noValidate
      data-connector-fields
      className="flex flex-col gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        event.stopPropagation();
        if (picked === "") return;
        void change(() => chooseTypedField(NAME, picked, type)).then((saved) => {
          if (!saved) return;
          setOpen(false);
          returnTo("[data-connector-field-change]");
        });
      }}
    >
      <label htmlFor={ids.type} className={LABEL}>
        {t("connector.azure.fieldType")}
      </label>
      <select
        id={ids.type}
        data-connector-type
        className={FIELD}
        value={type}
        onChange={(event) => setType(event.target.value)}
      >
        {types.map((each) => (
          <option key={each} value={each}>
            {each}
          </option>
        ))}
      </select>
      {fields === null ? null : fields.length === 0 ? (
        <p className={HINT}>{t("connector.azure.fieldNone")}</p>
      ) : (
        <>
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
            {t("connector.azure.fieldHint")}
          </p>
        </>
      )}
      <div className="flex flex-wrap gap-2">
        {fields !== null && fields.length > 0 ? (
          <Button type="submit" variant="outline">
            {t("connector.fieldSave")}
          </Button>
        ) : null}
        <Button
          type="button"
          variant="ghost"
          data-connector-field-cancel
          onClick={() => {
            setOpen(false);
            returnTo("[data-connector-field-change]");
          }}
        >
          {t("connector.azure.fieldCancel")}
        </Button>
      </div>
    </form>
  );
}

type ImportMode = "saved" | "wiql";

function ImportForm({
  code,
  onProblem,
}: {
  code: string;
  onProblem: (problem: Problem | null) => void;
}) {
  const t = useT();
  const ids = { wiql: useId(), hint: useId(), mode: useId() };
  const [mode, setMode] = useState<ImportMode>("saved");
  const [wiql, setWiql] = useState("");
  const [saved, setSaved] = useState("");
  const [busy, setBusy] = useState(false);
  const [report, setReport] = useState<string | null>(null);
  const pending = useRef(false);

  async function run(event: FormEvent) {
    event.preventDefault();
    // Inside the subject field's form in React's tree: a submit must not start a round.
    event.stopPropagation();
    if (pending.current) return;
    const query = mode === "wiql" ? { wiql: wiql.trim() } : saved === "" ? null : { saved };
    if (query === null || ("wiql" in query && query.wiql === "")) {
      setReport(t("connector.azure.nothingAsked"));
      return;
    }
    pending.current = true;
    setBusy(true);
    setReport(null);
    onProblem(null);
    try {
      setReport(importReport(t, await importItems(NAME, code, query)));
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
        {(["saved", "wiql"] as const).map((each) => (
          <label key={each} className="flex min-h-11 items-center gap-2 text-sm">
            <input
              type="radio"
              name={ids.mode}
              data-connector-mode={each}
              checked={mode === each}
              onChange={() => setMode(each)}
            />
            {each === "saved" ? t("connector.azure.bySaved") : t("connector.azure.byWiql")}
          </label>
        ))}
      </fieldset>
      {mode === "saved" ? (
        <SavedPicker onPick={setSaved} onProblem={onProblem} />
      ) : (
        <>
          <label htmlFor={ids.wiql} className={LABEL}>
            {t("connector.azure.wiql")}
          </label>
          <textarea
            id={ids.wiql}
            data-connector-wiql
            rows={4}
            maxLength={MAX_WIQL_LENGTH}
            value={wiql}
            aria-describedby={ids.hint}
            spellCheck={false}
            autoComplete="off"
            onChange={(event) => setWiql(event.target.value)}
            className={`${FIELD} resize-y font-mono`}
          />
          <p id={ids.hint} className={HINT}>
            {t("connector.azure.wiqlHint")}
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

function SavedPicker({
  onPick,
  onProblem,
}: {
  onPick: (id: string) => void;
  onProblem: (problem: Problem | null) => void;
}) {
  const t = useT();
  const id = useId();
  const [queries, setQueries] = useState<readonly ConnectorSiteView[] | null>(null);
  const [more, setMore] = useState(false);
  const report = useRef({ onPick, onProblem });
  report.current = { onPick, onProblem };

  useEffect(() => {
    let live = true;
    fetchSavedQueries(NAME)
      .then((found) => {
        if (!live) return;
        setQueries(found.queries);
        setMore(found.more);
        report.current.onPick(found.queries[0]?.id ?? "");
      })
      .catch((error: unknown) => {
        if (live) report.current.onProblem(problemOf(error));
      });
    return () => {
      live = false;
    };
  }, []);

  if (queries === null) return null;
  if (queries.length === 0) return <p className={HINT}>{t("connector.azure.noSaved")}</p>;
  return (
    <>
      <label htmlFor={id} className={LABEL}>
        {t("connector.azure.saved")}
      </label>
      <select
        id={id}
        data-connector-saved
        className={FIELD}
        onChange={(event) => report.current.onPick(event.target.value)}
      >
        {queries.map((query) => (
          <option key={query.id} value={query.id}>
            {query.name}
          </option>
        ))}
      </select>
      {more ? <p className={HINT}>{t("connector.azure.savedMore")}</p> : null}
    </>
  );
}
