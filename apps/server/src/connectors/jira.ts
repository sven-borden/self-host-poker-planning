/**
 * Jira Cloud over OAuth 2.0 (3LO) (#54, ADR-030). Every address is a constant here or is built
 * from one: all API calls go to `https://api.atlassian.com/ex/jira/{cloudId}/…`, the cloud id
 * must look like one, and nothing a client sends becomes a host or a path. Bodies are read
 * through a schema, so what Jira adds stays out, and a failure carries a code and no text of
 * Jira's, which may quote the query or an issue.
 *
 * A search is a POST, so the JQL is in no URL. A sprint is searched by JQL too: Jira deprecated
 * the agile API's list of a sprint's issues, and one way of paging is enough.
 */
import { z } from "zod";
import type { OAuthClient } from "../config.ts";
import { Secret } from "../vault.ts";
import {
  type BacklogConnector,
  type BacklogQuery,
  type Failure,
  type FoundItem,
  type Grant,
  type Outcome,
  success,
  type UpstreamCode,
} from "./connector.ts";

const AUTHORIZE_URL = "https://auth.atlassian.com/authorize";
const TOKEN_URL = "https://auth.atlassian.com/oauth/token";
const RESOURCES_URL = "https://api.atlassian.com/oauth/token/accessible-resources";
const API_ROOT = "https://api.atlassian.com/ex/jira";

/**
 * Read and write issues, list the boards and sprints to pick from, and stay connected. The
 * agile API takes only its own granular scopes; `read:project:jira` is what it asks to list
 * boards. Nothing administrative, and no user data.
 */
export const JIRA_SCOPES = [
  "read:jira-work",
  "write:jira-work",
  "read:board-scope:jira-software",
  "read:sprint:jira-software",
  "read:project:jira",
  "offline_access",
] as const;

/** One call to Atlassian, of any kind, gets this long. */
export const CALL_TIMEOUT_MS = 10_000;
/** Issues in one page of a search: the most a queue item's few fields comfortably take. */
export const SEARCH_PAGE = 100;
/** Boards and sprints in one answer. */
const LIST_PAGE = 100;

/** A cloud id is a UUID, and it goes into a path. */
const CLOUD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Jira's field ids: `customfield_10016`. A built-in number field has no use here. */
const CUSTOM_FIELD = /^customfield_[0-9]{1,12}$/;
const ISSUE_ID = /^[0-9]{1,18}$/;

/** Names that say estimate, in the languages this app speaks, best first. */
const STORY_POINTS_NAMES = [
  /^story points?$/i,
  /^story point estimate$/i,
  /story ?points?/i,
  /estimate|schätzung|estimation/i,
];

const tokenSchema = z.object({
  access_token: z.string().min(1).max(8192),
  refresh_token: z.string().min(1).max(8192),
  expires_in: z.number().positive().max(31_536_000),
});

const resourcesSchema = z.array(
  z.object({
    id: z.string().regex(CLOUD_ID),
    name: z.string().min(1).max(200),
    url: z.url({ protocol: /^https$/ }).max(200),
  }),
);

const fieldsSchema = z.array(
  z.object({
    id: z.string(),
    name: z.string().max(255),
    schema: z.object({ type: z.string(), custom: z.string().optional() }).optional(),
  }),
);

const boardsSchema = z.object({
  values: z.array(z.object({ id: z.number().int().positive(), name: z.string().max(255) })),
  isLast: z.boolean().optional(),
});

const sprintsSchema = z.object({
  values: z.array(
    z.object({
      id: z.number().int().positive(),
      name: z.string().max(255),
      state: z.string(),
    }),
  ),
});

const searchSchema = z.object({
  issues: z.array(
    z.object({
      id: z.string().regex(ISSUE_ID),
      key: z.string().max(64),
      fields: z.object({ summary: z.string().nullish() }).optional(),
    }),
  ),
  nextPageToken: z.string().max(4096).nullish(),
});

const countSchema = z.object({ count: z.number().int().nonnegative() });

/** The token address's error body: only `error` is ever read. */
const grantErrorSchema = z.object({ error: z.string() });

/** Seconds to wait, from a `Retry-After` of seconds. A date form counts as nothing said. */
export function retryAfterOf(header: string | null): number | undefined {
  if (header === null || !/^[0-9]{1,9}$/.test(header.trim())) return undefined;
  return Number(header.trim());
}

/** What an answer that is not a success means. `bad`: what this call makes of a 400. */
export function failureOf(response: Response, bad: UpstreamCode): Failure {
  const { status } = response;
  if (status === 429) {
    const retryAfter = retryAfterOf(response.headers.get("retry-after"));
    return {
      ok: false,
      code: "connector_rate_limited",
      ...(retryAfter === undefined ? {} : { retryAfter }),
    };
  }
  if (status === 401) return { ok: false, code: "connector_reconnect" };
  if (status === 403) return { ok: false, code: "connector_forbidden" };
  if (status === 404) return { ok: false, code: "connector_not_found" };
  if (status === 400) return { ok: false, code: bad };
  return { ok: false, code: "connector_unavailable" };
}

/** A failed `fetch`: only the kind of failure. Its message and cause are left behind. */
function fetchFailure(error: unknown): Failure {
  const name = error instanceof Error ? error.name : "";
  return {
    ok: false,
    code:
      name === "TimeoutError" || name === "AbortError"
        ? "connector_timeout"
        : "connector_unavailable",
  };
}

/**
 * One call, with its timeout. `Outcome`, not `instanceof Response`: the HTTP server's adapter
 * replaces the global `Response`, and `fetch` still answers with the original.
 */
async function send(url: string, init: RequestInit): Promise<Outcome<Response>> {
  try {
    // A redirect would be a surprise worth stopping at: a token goes nowhere it was not sent.
    const response = await fetch(url, {
      ...init,
      redirect: "error",
      signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
    });
    return success(response);
  } catch (error) {
    return fetchFailure(error);
  }
}

const UNREADABLE: Failure = { ok: false, code: "connector_unavailable" };

/** A JSON answer through its schema. Anything else is a tracker that is not itself. */
async function read<T>(
  answer: Outcome<Response>,
  schema: z.ZodType<T>,
  bad: UpstreamCode = "connector_unavailable",
): Promise<Outcome<T>> {
  if (!answer.ok) return answer;
  const response = answer.value;
  if (!response.ok) return failureOf(response, bad);
  const parsed = schema.safeParse(await response.json().catch(() => undefined));
  return parsed.success ? success(parsed.data) : UNREADABLE;
}

const bearer = (token: Secret) => ({
  authorization: `Bearer ${token.reveal()}`,
  accept: "application/json",
});

const postJson = (body: unknown, headers: Record<string, string> = {}): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/json", accept: "application/json", ...headers },
  body: JSON.stringify(body),
});

/** Every API address. A bad id is refused here, before a token goes anywhere. */
function apiUrl(site: string, path: string): string | null {
  return CLOUD_ID.test(site) ? `${API_ROOT}/${site}${path}` : null;
}

const NOT_FOUND: Failure = { ok: false, code: "connector_not_found" };

/** The JQL of a query. A sprint's id is a number, so nothing can be written into this one. */
export function jqlOf(query: BacklogQuery): string {
  return "jql" in query
    ? query.jql
    : `sprint = ${query.sprint} AND issuetype not in subtaskIssueTypes() ORDER BY rank ASC`;
}

/** The items of one search page, on the site's own address. Nothing else of an issue. */
function itemsOf(
  issues: z.output<typeof searchSchema>["issues"],
  siteUrl: string,
): readonly FoundItem[] {
  return issues.map(({ id, key, fields }) => ({
    id,
    key,
    title: fields?.summary ?? "",
    url: `${siteUrl.replace(/\/+$/, "")}/browse/${encodeURIComponent(key)}`,
  }));
}

async function grantFrom(answer: Outcome<Response>, now: number): Promise<Outcome<Grant>> {
  if (!answer.ok) return answer;
  const response = answer.value;
  if (!response.ok) {
    // Atlassian answers a dead refresh token with 403; a fresh code gone stale with 400 or 403.
    const body = grantErrorSchema.safeParse(await response.json().catch(() => undefined));
    if (body.success && body.data.error === "invalid_grant") {
      return { ok: false, code: "connector_reconnect" };
    }
    return UNREADABLE;
  }
  const parsed = tokenSchema.safeParse(await response.json().catch(() => undefined));
  if (!parsed.success) return UNREADABLE;
  return success({
    accessToken: new Secret(parsed.data.access_token),
    refreshToken: new Secret(parsed.data.refresh_token),
    expiresAt: now + parsed.data.expires_in * 1000,
  });
}

export function createJiraConnector(
  client: OAuthClient,
  now: () => number = Date.now,
): BacklogConnector {
  return {
    name: "jira",
    system: "jira",

    authorizeUrl: (state, redirectUri) => {
      const url = new URL(AUTHORIZE_URL);
      url.search = new URLSearchParams({
        audience: "api.atlassian.com",
        client_id: client.clientId,
        scope: JIRA_SCOPES.join(" "),
        redirect_uri: redirectUri,
        state,
        response_type: "code",
        prompt: "consent",
      }).toString();
      return url.toString();
    },

    exchangeCode: async (code, redirectUri) =>
      grantFrom(
        await send(
          TOKEN_URL,
          postJson({
            grant_type: "authorization_code",
            client_id: client.clientId,
            client_secret: client.clientSecret,
            code,
            redirect_uri: redirectUri,
          }),
        ),
        now(),
      ),

    refresh: async (refreshToken) =>
      grantFrom(
        await send(
          TOKEN_URL,
          postJson({
            grant_type: "refresh_token",
            client_id: client.clientId,
            client_secret: client.clientSecret,
            refresh_token: refreshToken.reveal(),
          }),
        ),
        now(),
      ),

    sites: async (token) =>
      read(await send(RESOURCES_URL, { headers: bearer(token) }), resourcesSchema),

    numberFields: async (token, site) => {
      const url = apiUrl(site, "/rest/api/3/field");
      if (url === null) return NOT_FOUND;
      const all = await read(await send(url, { headers: bearer(token) }), fieldsSchema);
      if (!all.ok) return all;
      return success(
        all.value
          .filter(({ id, schema }) => CUSTOM_FIELD.test(id) && schema?.type === "number")
          .map(({ id, name }) => ({ id, name })),
      );
    },

    guessField: (fields) => {
      for (const name of STORY_POINTS_NAMES) {
        const found = fields.find((field) => name.test(field.name));
        if (found) return found.id;
      }
      return undefined;
    },

    boards: async (token, site, name) => {
      const query = new URLSearchParams({ maxResults: String(LIST_PAGE), startAt: "0" });
      if (name !== undefined) query.set("name", name);
      const url = apiUrl(site, `/rest/agile/1.0/board?${query}`);
      if (url === null) return NOT_FOUND;
      const page = await read(await send(url, { headers: bearer(token) }), boardsSchema);
      if (!page.ok) return page;
      return success({
        boards: page.value.values.map(({ id, name: board }) => ({ id, name: board })),
        more: page.value.isLast === false,
      });
    },

    sprints: async (token, site, board) => {
      const query = new URLSearchParams({
        state: "active,future",
        maxResults: String(LIST_PAGE),
        startAt: "0",
      });
      const url = apiUrl(site, `/rest/agile/1.0/board/${board}/sprint?${query}`);
      if (url === null) return NOT_FOUND;
      const page = await read(await send(url, { headers: bearer(token) }), sprintsSchema);
      if (!page.ok) return page;
      return success(
        page.value.values.flatMap(({ id, name, state }) =>
          state === "active" || state === "future" ? [{ id, name, state }] : [],
        ),
      );
    },

    search: async (token, site, query, next) => {
      const url = apiUrl(site.id, "/rest/api/3/search/jql");
      if (url === null) return NOT_FOUND;
      const page = await read(
        await send(
          url,
          postJson(
            {
              jql: jqlOf(query),
              fields: ["summary"],
              maxResults: SEARCH_PAGE,
              ...(next === undefined ? {} : { nextPageToken: next }),
            },
            bearer(token),
          ),
        ),
        searchSchema,
        "connector_bad_query",
      );
      if (!page.ok) return page;
      const { issues, nextPageToken } = page.value;
      const items = itemsOf(issues, site.url);
      return success(nextPageToken ? { items, next: nextPageToken } : { items });
    },

    count: async (token, site, query) => {
      const url = apiUrl(site, "/rest/api/3/search/approximate-count");
      if (url === null) return NOT_FOUND;
      const answer = await read(
        await send(url, postJson({ jql: jqlOf(query) }, bearer(token))),
        countSchema,
        "connector_bad_query",
      );
      return answer.ok ? success(answer.value.count) : answer;
    },

    writeEstimate: async (token, site, item, field, value) => {
      const url = apiUrl(site, `/rest/api/3/issue/${item}`);
      if (url === null || !ISSUE_ID.test(item) || !CUSTOM_FIELD.test(field)) return NOT_FOUND;
      const answer = await send(url, {
        ...postJson({ fields: { [field]: value } }, bearer(token)),
        method: "PUT",
      });
      if (!answer.ok) return answer;
      return answer.value.ok
        ? success(undefined)
        : failureOf(answer.value, "connector_field_refused");
    },
  };
}
