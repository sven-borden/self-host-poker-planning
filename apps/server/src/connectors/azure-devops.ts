/**
 * Azure DevOps Services through a person's own personal access token (#55, ADR-031). Every address
 * starts at the constant `https://dev.azure.com/{organisation}/`: the organisation fits a strict
 * pattern, project ids are GUIDs, item ids are numbers, and nothing a client sends becomes a host.
 * So Azure DevOps Server (on-premises) is out, and that is on purpose: its address would have to
 * come from a person.
 *
 * Two things are not as Jira's. Azure DevOps often answers a bad or expired token not with a 401
 * but with a 203 and a sign-in page, or a redirect to one. `read` takes nothing but a 200 in JSON
 * for an answer, and `send` follows no redirect, so that neither can pass for success and a token
 * never goes where it was not sent. And the field of an estimate depends on the item's type, so
 * `fieldFor` reads it for each item, from what the type carries, and not from a process's name.
 *
 * Bodies go through a schema. A failure carries a code and no text of Microsoft's, which can quote
 * a query or an item: only the `TF` or `VS` number at the start of a message is ever looked at.
 */
import { createHash } from "node:crypto";
import { ADO_ORGANIZATION, MAX_WIQL_LENGTH } from "@pp/protocol";
import { z } from "zod";
import type { Secret } from "../vault.ts";
import {
  type AzureQuery,
  type BacklogConnector,
  type Failure,
  type Field,
  type FoundItem,
  type ItemFields,
  type Outcome,
  type PastedToken,
  type SavedQueries,
  type SavedQuery,
  type Site,
  success,
  type UpstreamCode,
} from "./connector.ts";
import { CALL_TIMEOUT_MS, failureOf, fetchFailure } from "./jira.ts";

const API_ROOT = "https://dev.azure.com";
/** Pinned: an address never changes its meaning under us. */
export const API_VERSION = "7.1";

/** The most ids one call of `workitemsbatch` takes, in Microsoft's documentation. */
export const WORK_ITEM_BATCH = 200;
/** The most a WIQL query gives back. Past it Azure DevOps refuses, unless `$top` says this. */
export const WIQL_CAP = 20_000;
const PROJECT_PAGE = 100;
/** Pages of projects, so an organisation of thousands costs a few calls. */
export const MAX_PROJECT_PAGES = 5;
/** Folders read past the two levels one call can give. */
export const MAX_FOLDER_READS = 5;
export const MAX_SAVED_QUERIES = 200;

/** How long a type's fields are believed: a process changes rarely, and a write should not wait. */
export const FIELD_CACHE_MS = 5 * 60_000;
const MAX_CACHED_TYPES = 200;

/**
 * Where the estimate goes when a person chose nothing, as the process templates name it: Agile,
 * Scrum and Basic, CMMI. Looked for in what the type carries, in this order.
 */
export const ESTIMATE_FIELDS = [
  "Microsoft.VSTS.Scheduling.StoryPoints",
  "Microsoft.VSTS.Scheduling.Effort",
  "Microsoft.VSTS.Scheduling.Size",
] as const;

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ITEM_ID = /^[1-9][0-9]{0,9}$/;
/** A field's reference name: `Custom.Points`. It goes into a JSON Patch path. */
const FIELD_ID = /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)+$/;
/** A project's or a type's name: it goes into a path, so it can be no step and no separator. */
const NAME_IN_PATH = /^(?!\.+$)[^/\\?#%\u0000-\u001f]{1,128}$/;
const CONTINUATION = /^[\w=+/-]{1,512}$/;

/** Numbers a person can set. An `integer` field refuses 2.5 itself, and that is a code too. */
const NUMBER_TYPES: ReadonlySet<string> = new Set(["double", "integer"]);

/** The one field that proves a token reads work items, and the smallest answer that does. */
const PROBE_FIELD = "_apis/wit/fields/System.Title";

/** What Azure DevOps says of an account that is not in the organisation. */
const NOT_A_MEMBER: ReadonlySet<string> = new Set(["TF400813", "VS30063"]);
/** A saved query that is gone: TF401243 for its folder, TF401232 for itself. */
const QUERY_GONE: ReadonlySet<string> = new Set(["TF401232", "TF401243"]);
/** "The number of work items returned exceeds the size limit": a query past `WIQL_CAP`. */
const QUERY_CAP = "VS402337";

export const AZURE_QUERY: z.ZodType<AzureQuery> = z.union([
  z.strictObject({ wiql: z.string().trim().min(1).max(MAX_WIQL_LENGTH) }),
  z.strictObject({ saved: z.string().regex(GUID) }),
]);

const fieldProbeSchema = z.object({ referenceName: z.string() });

const projectsSchema = z.object({
  value: z.array(z.object({ id: z.string().regex(GUID), name: z.string().min(1).max(128) })),
});

const typesSchema = z.object({
  value: z.array(z.object({ name: z.string().min(1), isDisabled: z.boolean().optional() })),
});

const typeFieldsSchema = z.object({
  value: z.array(z.object({ referenceName: z.string(), name: z.string().max(255) })),
});

const projectFieldsSchema = z.object({
  value: z.array(
    z.object({
      referenceName: z.string(),
      type: z.string().optional(),
      readOnly: z.boolean().optional(),
    }),
  ),
});

const workItemSchema = z.object({
  fields: z.object({ "System.WorkItemType": z.string(), "System.TeamProject": z.string() }),
});

const reference = z.object({ id: z.number().int().positive() });

const queryResultSchema = z.object({
  workItems: z.array(reference).optional(),
  // A tree or one-hop query: the links, whose first row has no source.
  workItemRelations: z
    .array(z.object({ source: reference.nullish(), target: reference.nullish() }))
    .optional(),
});

const batchSchema = z.object({
  // `errorPolicy: omit` holds a place for an item that is gone or hidden with a null.
  value: z.array(
    z
      .object({
        id: z.number().int().positive(),
        fields: z.object({ "System.Title": z.string().nullish() }).optional(),
      })
      .nullable(),
  ),
});

interface QueryNode {
  id: string;
  name: string;
  path?: string | undefined;
  isFolder?: boolean | undefined;
  hasChildren?: boolean | undefined;
  children?: QueryNode[] | undefined;
}

const queryNodeSchema: z.ZodType<QueryNode> = z.lazy(() =>
  z.object({
    id: z.string().regex(GUID),
    name: z.string().max(256),
    path: z.string().max(512).optional(),
    isFolder: z.boolean().optional(),
    hasChildren: z.boolean().optional(),
    children: z.array(queryNodeSchema).optional(),
  }),
);

const queriesSchema = z.object({ value: z.array(queryNodeSchema) });

const NOT_FOUND: Failure = { ok: false, code: "connector_not_found" };
const UNREADABLE: Failure = { ok: false, code: "connector_unavailable" };
const RECONNECT: Failure = { ok: false, code: "connector_reconnect" };
const BAD_TOKEN: Failure = { ok: false, code: "connector_bad_token" };
const NO_ACCESS: Failure = { ok: false, code: "connector_no_access" };
const NO_ORGANIZATION: Failure = { ok: false, code: "connector_no_organization" };
const SCOPE: Failure = { ok: false, code: "connector_scope" };
const NO_ESTIMATE_FIELD: Failure = { ok: false, code: "connector_no_estimate_field" };
const AT_CAP: Failure = { ok: false, code: "connector_query_cap" };

/** Every address. A bad organisation is refused here, before a token goes anywhere. */
export function azureUrl(
  organization: string,
  path: string,
  query: Record<string, string> = {},
): string | null {
  if (!ADO_ORGANIZATION.test(organization)) return null;
  const search = new URLSearchParams({ ...query, "api-version": API_VERSION });
  return `${API_ROOT}/${organization}/${path}?${search.toString().replaceAll("%24", "$")}`;
}

/** The organisation and project of a site's id, `fabrikam/{guid}`; nothing else passes. */
function partsOf(site: string): { organization: string; project: string } | null {
  const [organization, project, ...rest] = site.split("/");
  if (organization === undefined || project === undefined || rest.length > 0) return null;
  return ADO_ORGANIZATION.test(organization) && GUID.test(project)
    ? { organization, project }
    : null;
}

const headers = (token: Secret) => ({
  // Basic, with an empty user: how Microsoft documents a PAT.
  authorization: `Basic ${Buffer.from(`:${token.reveal()}`).toString("base64")}`,
  accept: "application/json",
});

const postJson = (token: Secret, body: unknown): RequestInit => ({
  method: "POST",
  headers: { ...headers(token), "content-type": "application/json" },
  body: JSON.stringify(body),
});

/**
 * One call, with its timeout. `manual` and not `error`: with `error` a redirect is a `TypeError`
 * like a dead network, and a redirect here means "sign in". Neither follows it, so the token goes
 * nowhere either way, and `read` takes a 3xx for what it is.
 */
async function send(url: string, init: RequestInit): Promise<Outcome<Response>> {
  try {
    const response = await fetch(url, {
      ...init,
      redirect: "manual",
      signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
    });
    return success(response);
  } catch (error) {
    return fetchFailure(error);
  }
}

/** A sign-in page in place of an answer, or the redirect to one: the token was not accepted. */
const toSignIn = ({ status }: Response) => status === 203 || (status >= 300 && status < 400);

const isJson = (response: Response) =>
  /^application\/json\b/i.test(response.headers.get("content-type") ?? "");

/** A real answer: exactly 200, in JSON. A 203 is `ok` to `fetch`, and an HTML page can be a 200. */
const answered = (response: Response) => response.status === 200 && isJson(response);

/** The number at the start of Microsoft's message. Its words are never read. */
async function errorNumber(response: Response): Promise<string | undefined> {
  try {
    const body: unknown = await response.clone().json();
    const { message } = body as { message?: unknown };
    return typeof message === "string" ? /^((?:TF|VS)[0-9]+)\b/.exec(message)?.[1] : undefined;
  } catch {
    return undefined;
  }
}

/** What an answer that is not an answer means. `bad`: what this call makes of a 400. */
async function refused(response: Response, bad: UpstreamCode): Promise<Failure> {
  if (toSignIn(response)) return RECONNECT;
  const number = await errorNumber(response);
  if (number === QUERY_CAP) return AT_CAP;
  if (number !== undefined && QUERY_GONE.has(number)) return NOT_FOUND;
  return failureOf(response, bad);
}

/** A JSON answer through its schema. Anything else is not Azure DevOps answering. */
async function read<T>(
  answer: Outcome<Response>,
  schema: z.ZodType<T>,
  bad: UpstreamCode = "connector_unavailable",
): Promise<Outcome<T>> {
  if (!answer.ok) return answer;
  const response = answer.value;
  if (!answered(response)) return refused(response, bad);
  let body: unknown;
  try {
    body = await response.json();
  } catch (error) {
    return fetchFailure(error);
  }
  const parsed = schema.safeParse(body);
  return parsed.success ? success(parsed.data) : UNREADABLE;
}

/** Ids in the order a query gave them, each once. A tree repeats a parent per child. */
function idsOf({ workItems, workItemRelations }: z.output<typeof queryResultSchema>): number[] {
  const ids = (workItems ?? []).map(({ id }) => id);
  for (const { source, target } of workItemRelations ?? []) {
    if (source) ids.push(source.id);
    if (target) ids.push(target.id);
  }
  return [...new Set(ids)];
}

/** Folders hold queries; a folder is never one. What one call left unread comes back to `more`. */
function collect(nodes: readonly QueryNode[], queries: SavedQuery[], unread: string[]) {
  for (const node of nodes) {
    if (!node.isFolder) queries.push({ id: node.id, name: node.path ?? node.name });
    else if (node.children) collect(node.children, queries, unread);
    else if (node.hasChildren) unread.push(node.id);
  }
}

export type AzureConnector = BacklogConnector<AzureQuery> & PastedToken & ItemFields & SavedQueries;

/** The fields of a type, by token: nothing one person read reaches another. */
interface CachedFields {
  at: number;
  fields: readonly Field[];
}

export function createAzureConnector(now: () => number = Date.now): AzureConnector {
  const cache = new Map<string, CachedFields>();

  /** The number fields `type` carries in `project`: the type's list, and the project's types. */
  async function fieldsOf(
    token: Secret,
    organization: string,
    project: string,
    type: string,
  ): Promise<Outcome<readonly Field[]>> {
    if (!NAME_IN_PATH.test(project) || !NAME_IN_PATH.test(type)) return NOT_FOUND;
    const place = encodeURIComponent(project);
    const mark = createHash("sha256").update(token.reveal()).digest("base64url");
    const key = `${mark}|${organization}|${project}|${type}`;
    const cached = cache.get(key);
    if (cached !== undefined && now() - cached.at < FIELD_CACHE_MS) return success(cached.fields);
    const carried = azureUrl(
      organization,
      `${place}/_apis/wit/workitemtypes/${encodeURIComponent(type)}/fields`,
    );
    const known = azureUrl(organization, `${place}/_apis/wit/fields`);
    if (carried === null || known === null) return NOT_FOUND;
    const own = await read(await send(carried, { headers: headers(token) }), typeFieldsSchema);
    if (!own.ok) return own;
    const all = await read(await send(known, { headers: headers(token) }), projectFieldsSchema);
    if (!all.ok) return all;
    // The type's list says nothing of a field's kind: that is in the project's.
    const numbers = new Set(
      all.value.value
        .filter(({ type: kind, readOnly }) => NUMBER_TYPES.has(kind ?? "") && readOnly !== true)
        .map(({ referenceName }) => referenceName),
    );
    const fields = own.value.value
      .filter(
        ({ referenceName }) =>
          numbers.has(referenceName) &&
          FIELD_ID.test(referenceName) &&
          !referenceName.startsWith("System."),
      )
      .map(({ referenceName, name }) => ({ id: referenceName, name }));
    if (cache.size >= MAX_CACHED_TYPES) cache.clear();
    cache.set(key, { at: now(), fields });
    return success(fields);
  }

  /** The ids a query finds, at most `WIQL_CAP`. Run in the project; the query is the person's. */
  async function idsFound(
    token: Secret,
    { organization, project }: { organization: string; project: string },
    query: AzureQuery,
  ): Promise<Outcome<readonly number[]>> {
    const top = { $top: String(WIQL_CAP) };
    const url =
      "wiql" in query
        ? azureUrl(organization, `${project}/_apis/wit/wiql`, top)
        : azureUrl(organization, `${project}/_apis/wit/wiql/${query.saved}`, top);
    if (url === null) return NOT_FOUND;
    const answer = await send(
      url,
      "wiql" in query ? postJson(token, { query: query.wiql }) : { headers: headers(token) },
    );
    const result = await read(answer, queryResultSchema, "connector_bad_query");
    return result.ok ? success(idsOf(result.value)) : result;
  }

  return {
    name: "azure-devops",
    system: "ado",
    query: AZURE_QUERY,
    organization: ADO_ORGANIZATION,

    // A PAT has nothing to renew it with: refused, it is gone, and the person connects again.
    refresh: async () => RECONNECT,

    /**
     * One read that needs what the app needs. A read cannot show the right to write: a token that
     * reads and cannot write is found at its first write, and says so then (`writeEstimate`).
     * A refused read is read once more for a place every token reaches, which tells a token
     * without the scope from one this organisation does not know, without Microsoft's wording.
     */
    checkToken: async (organization, token) => {
      const probe = azureUrl(organization, PROBE_FIELD);
      const place = azureUrl(organization, "_apis/projects", { $top: "1" });
      if (probe === null || place === null) return NO_ORGANIZATION;
      const first = await send(probe, { headers: headers(token) });
      if (!first.ok) return first;
      const work = first.value;
      if (answered(work)) return success(undefined);
      if (toSignIn(work)) return BAD_TOKEN;
      if (work.status === 404) return NO_ORGANIZATION;
      if (work.status !== 401 && work.status !== 403) return refused(work, "connector_unavailable");
      const number = await errorNumber(work);
      const second = await send(place, { headers: headers(token) });
      if (!second.ok) return second;
      const reach = second.value;
      if (answered(reach)) return SCOPE;
      if (toSignIn(reach)) return BAD_TOKEN;
      if (reach.status === 404) return NO_ORGANIZATION;
      if (reach.status === 403) return NO_ACCESS;
      if (reach.status !== 401) return refused(reach, "connector_unavailable");
      return NOT_A_MEMBER.has(number ?? (await errorNumber(reach)) ?? "") ? NO_ACCESS : BAD_TOKEN;
    },

    /** The projects of the organisation this token reaches. A site is a project. */
    sites: async (token, organization) => {
      if (organization === undefined) return NOT_FOUND;
      const sites: Site[] = [];
      let next: string | null = null;
      for (let page = 0; page < MAX_PROJECT_PAGES; page++) {
        const url = azureUrl(organization, "_apis/projects", {
          $top: String(PROJECT_PAGE),
          ...(next === null ? {} : { continuationToken: next }),
        });
        if (url === null) return NOT_FOUND;
        const answer = await send(url, { headers: headers(token) });
        const projects = await read(answer, projectsSchema);
        if (!projects.ok) return projects;
        for (const { id, name } of projects.value.value) {
          sites.push({
            id: `${organization}/${id}`,
            name,
            url: `${API_ROOT}/${organization}`,
            home: organization,
          });
        }
        next = answer.ok ? answer.value.headers.get("x-ms-continuationtoken") : null;
        if (next === null || !CONTINUATION.test(next)) break;
      }
      return success(sites);
    },

    numberFields: async (token, site, type) => {
      const parts = partsOf(site);
      if (parts === null || type === undefined) return NOT_FOUND;
      return fieldsOf(token, parts.organization, parts.project, type);
    },

    guessField: (fields) => ESTIMATE_FIELDS.find((field) => fields.some(({ id }) => id === field)),

    workItemTypes: async (token, site) => {
      const parts = partsOf(site);
      const url = parts && azureUrl(parts.organization, `${parts.project}/_apis/wit/workitemtypes`);
      if (!url) return NOT_FOUND;
      const types = await read(await send(url, { headers: headers(token) }), typesSchema);
      if (!types.ok) return types;
      return success(
        types.value.value.flatMap(({ name, isDisabled }) => (isDisabled ? [] : [name])),
      );
    },

    /**
     * Where this item's estimate goes: the person's own choice where its type carries it, else the
     * field of the process, read from the type. A type with neither has no estimate to write.
     */
    fieldFor: async (token, organization, item, chosen) => {
      const url = ITEM_ID.test(item)
        ? azureUrl(organization, `_apis/wit/workitems/${item}`, {
            fields: "System.WorkItemType,System.TeamProject",
          })
        : null;
      if (url === null) return NOT_FOUND;
      const found = await read(await send(url, { headers: headers(token) }), workItemSchema);
      if (!found.ok) return found;
      const { "System.WorkItemType": type, "System.TeamProject": project } = found.value.fields;
      const fields = await fieldsOf(token, organization, project, type);
      if (!fields.ok) return fields;
      const carried = new Set(fields.value.map(({ id }) => id));
      if (chosen !== undefined && carried.has(chosen)) return success(chosen);
      const estimate = ESTIMATE_FIELDS.find((field) => carried.has(field));
      return estimate === undefined ? NO_ESTIMATE_FIELD : success(estimate);
    },

    savedQueries: async (token, site) => {
      const parts = partsOf(site);
      if (parts === null) return NOT_FOUND;
      const { organization, project } = parts;
      // Two levels are the most one call gives; a folder deeper down is read by its id.
      const url = azureUrl(organization, `${project}/_apis/wit/queries`, { $depth: "2" });
      if (url === null) return NOT_FOUND;
      const root = await read(await send(url, { headers: headers(token) }), queriesSchema);
      if (!root.ok) return root;
      const queries: SavedQuery[] = [];
      const unread: string[] = [];
      collect(root.value.value, queries, unread);
      for (let reads = 0; reads < MAX_FOLDER_READS && unread.length > 0; reads++) {
        const folder = unread.shift() as string;
        const address = azureUrl(organization, `${project}/_apis/wit/queries/${folder}`, {
          $depth: "2",
        });
        if (address === null) return NOT_FOUND;
        const found = await read(await send(address, { headers: headers(token) }), queryNodeSchema);
        if (!found.ok) return found;
        collect(found.value.children ?? [], queries, unread);
      }
      return success({
        queries: queries.slice(0, MAX_SAVED_QUERIES),
        more: unread.length > 0 || queries.length > MAX_SAVED_QUERIES,
      });
    },

    /**
     * The first page runs the query, once; each page after it is a batch of the ids it found, which
     * `next` carries. It stays on this server: it never comes from a client.
     */
    search: async (token, site, query, next) => {
      const parts = partsOf(site.id);
      if (parts === null) return NOT_FOUND;
      const found: Outcome<readonly number[]> =
        next === undefined
          ? await idsFound(token, parts, query)
          : success(next.split(",").map(Number));
      if (!found.ok) return found;
      const ids = found.value.slice(0, WORK_ITEM_BATCH);
      const rest = found.value.slice(WORK_ITEM_BATCH);
      if (ids.length === 0) return success({ items: [] });
      const url = azureUrl(parts.organization, "_apis/wit/workitemsbatch");
      if (url === null) return NOT_FOUND;
      const batch = await read(
        await send(url, postJson(token, { ids, fields: ["System.Title"], errorPolicy: "omit" })),
        batchSchema,
      );
      if (!batch.ok) return batch;
      const items: FoundItem[] = [];
      for (const item of batch.value.value) {
        if (item === null) continue;
        items.push({
          id: String(item.id),
          key: String(item.id),
          title: item.fields?.["System.Title"] ?? "",
          url: `${API_ROOT}/${parts.organization}/_workitems/edit/${item.id}`,
        });
      }
      return success({
        items,
        unreadable: ids.length - items.length,
        ...(rest.length > 0 ? { next: rest.join(",") } : {}),
      });
    },

    /** The query again: it has no count of its own. At the cap there is no telling how many. */
    count: async (token, site, query) => {
      const parts = partsOf(site);
      if (parts === null) return NOT_FOUND;
      const found = await idsFound(token, parts, query);
      if (!found.ok) return found;
      return found.value.length >= WIQL_CAP ? AT_CAP : success(found.value.length);
    },

    /**
     * One JSON Patch of one number. `add` on a field sets it, whether or not it had a value, so
     * writing twice is harmless. A 401 on a token that reads is one that may not write, which no
     * read could show when it connected: that token is alive, so the row stays.
     */
    writeEstimate: async (token, organization, item, field, value) => {
      if (!ITEM_ID.test(item) || !FIELD_ID.test(field)) return NOT_FOUND;
      const url = azureUrl(organization, `_apis/wit/workitems/${item}`);
      const probe = azureUrl(organization, PROBE_FIELD);
      if (url === null || probe === null) return NOT_FOUND;
      const answer = await send(url, {
        method: "PATCH",
        headers: { ...headers(token), "content-type": "application/json-patch+json" },
        body: JSON.stringify([{ op: "add", path: `/fields/${field}`, value }]),
      });
      if (!answer.ok) return answer;
      if (answered(answer.value)) return success(undefined);
      if (answer.value.status === 400) cache.clear();
      if (answer.value.status !== 401) return refused(answer.value, "connector_field_refused");
      const reads = await read(await send(probe, { headers: headers(token) }), fieldProbeSchema);
      return reads.ok ? SCOPE : reads;
    },
  };
}
