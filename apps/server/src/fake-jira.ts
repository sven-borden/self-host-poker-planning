/**
 * A stand-in for Atlassian, for tests only (#54, ADR-030). Not imported by `main.ts`, so never
 * bundled and not in the image: `connectors/fake-jira.test.ts` holds that. A real HTTP server with
 * the real shape of 3LO and of Jira's REST API as far as the app uses it: an authorize address,
 * a token address that rotates refresh tokens, `accessible-resources`, and per site the search,
 * fields, boards, sprints and an issue's update, each checking the bearer token.
 *
 * Nothing in the app points at it: a test, in its own process, replaces `fetch` with
 * `routeAtlassianTo`, and the server runs the same code and addresses as in production. An e2e
 * spec reaches it by HTTP: `POST /__control` takes a `FakeJiraControl`, `GET /__state` tells what
 * it saw.
 */
import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export const FAKE_CLOUD = "11111111-1111-4111-8111-111111111111";
export const FAKE_CLOUD_TWO = "22222222-2222-4222-8222-222222222222";

export interface FakeSite {
  id: string;
  name: string;
  url: string;
}

export interface FakeIssue {
  id: string;
  key: string;
  summary: string;
  /** Sprints it sits in. */
  sprint?: number;
}

export interface FakeWrite {
  site: string;
  issue: string;
  /** The body, whole, as Jira received it. */
  body: unknown;
  token: string;
}

/** An answer forced on the next calls whose path holds `match`. */
export interface FakeFailure {
  match: string;
  status: number;
  retryAfter?: string;
  /** How many calls it takes; 1 by default. */
  times?: number;
  body?: unknown;
  /** Never answers: the caller's timeout is what ends it. */
  hang?: boolean;
}

export interface FakeJiraControl {
  fail?: FakeFailure[];
  /** The sites the next authorised person sees, by default both. */
  sites?: FakeSite[];
  issues?: FakeIssue[];
  /** The total the approximate count reports; the matching issues by default. */
  approximate?: number;
}

export interface FakeJiraState {
  writes: FakeWrite[];
  /** Every request, method and path, without a query. */
  calls: string[];
  authorizations: Record<string, string>[];
}

const SITES: FakeSite[] = [
  { id: FAKE_CLOUD, name: "Acme", url: "https://acme.atlassian.net" },
  { id: FAKE_CLOUD_TWO, name: "Globex", url: "https://globex.atlassian.net" },
];

const FIELDS = [
  { id: "summary", name: "Summary", schema: { type: "string" } },
  { id: "timespent", name: "Time Spent", schema: { type: "number" } },
  { id: "customfield_10001", name: "Team size", schema: { type: "number" } },
  { id: "customfield_10002", name: "Colour", schema: { type: "string" } },
  { id: "customfield_10016", name: "Story Points", schema: { type: "number" } },
];

const BOARDS = [
  { id: 1, name: "Acme board" },
  { id: 2, name: "Platform board" },
];

const SPRINTS = [
  { id: 7, name: "Sprint 7", state: "active" },
  { id: 8, name: "Sprint 8", state: "future" },
  { id: 6, name: "Sprint 6", state: "closed" },
];

export const fakeIssues = (count: number, sprint = 7, from = 1): FakeIssue[] =>
  Array.from({ length: count }, (_, n) => ({
    id: String(10_000 + from + n),
    key: `ABC-${from + n}`,
    summary: `Ticket ${from + n}`,
    sprint,
  }));

export interface Tokens {
  access: string;
  refresh: string;
}

export interface FakeJira extends FakeJiraState, FakeJiraControl {
  readonly origin: string;
  /** The codes it handed the browser, and the tokens it issued, for tests that look for them. */
  readonly codes: string[];
  readonly issued: Tokens[];
  /** Bodies of the token address. */
  readonly tokenRequests: Record<string, unknown>[];
  /** Access tokens no longer good, as after a person revoked the grant. */
  readonly revoked: Set<string>;
  sites: FakeSite[];
  issues: FakeIssue[];
  fail: FakeFailure[];
  /** Seconds an access token lives. */
  expiresIn: number;
  /** A used refresh token stops working at once: no leeway. */
  strictRotation: boolean;
  /** The nth page of a search (from 1) answers this, once. */
  pageFailure?: { page: number; status: number };
  /** Called while the token address holds a refresh, so a test can make two overlap. */
  beforeRefresh: () => Promise<void>;
  /** Refresh tokens it would still accept. */
  liveRefreshTokens(): string[];
  close(): Promise<void>;
}

interface Pending {
  clientId: string;
  redirectUri: string;
}

async function bodyOf(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString();
  return text === "" ? undefined : JSON.parse(text);
}

function json(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

const hex = (bytes: number) => randomBytes(bytes).toString("hex");

export const FAKE_JIRA_CLIENT = { clientId: "fake-jira-client", clientSecret: "fake-jira-secret" };

/** `port`: 0 picks a free one. */
export async function startFakeJira(port = 0): Promise<FakeJira> {
  const pending = new Map<string, Pending>();
  const liveRefresh = new Set<string>();
  const liveAccess = new Map<string, FakeSite[]>();
  const spentRefresh = new Map<string, FakeSite[]>();
  const refreshSites = new Map<string, FakeSite[]>();
  const fake = {
    writes: [] as FakeWrite[],
    calls: [] as string[],
    authorizations: [] as Record<string, string>[],
    codes: [] as string[],
    issued: [] as Tokens[],
    tokenRequests: [] as Record<string, unknown>[],
    revoked: new Set<string>(),
    sites: [...SITES],
    issues: [] as FakeIssue[],
    fail: [] as FakeFailure[],
    approximate: undefined as number | undefined,
    pageFailure: undefined as FakeJira["pageFailure"],
    expiresIn: 3600,
    strictRotation: false,
    beforeRefresh: async () => {},
    liveRefreshTokens: () => [...liveRefresh],
  };

  function issue(sites: FakeSite[]): Tokens {
    const tokens = { access: `fake-access-${hex(16)}`, refresh: `fake-refresh-${hex(16)}` };
    fake.issued.push(tokens);
    liveAccess.set(tokens.access, sites);
    liveRefresh.add(tokens.refresh);
    refreshSites.set(tokens.refresh, sites);
    return tokens;
  }

  function granted(response: ServerResponse, tokens: Tokens) {
    json(response, 200, {
      access_token: tokens.access,
      refresh_token: tokens.refresh,
      expires_in: fake.expiresIn,
      token_type: "Bearer",
      scope: "read:jira-work write:jira-work offline_access",
    });
  }

  async function token(request: IncomingMessage, response: ServerResponse) {
    const body = (await bodyOf(request)) as Record<string, string>;
    fake.tokenRequests.push(body);
    const clientOk =
      body.client_id === FAKE_JIRA_CLIENT.clientId &&
      body.client_secret === FAKE_JIRA_CLIENT.clientSecret;
    if (!clientOk) {
      json(response, 401, { error: "access_denied", error_description: "unknown client" });
      return;
    }
    if (body.grant_type === "authorization_code") {
      const code = pending.get(body.code ?? "");
      pending.delete(body.code ?? "");
      if (!code || code.redirectUri !== body.redirect_uri) {
        json(response, 403, { error: "invalid_grant", error_description: "bad code" });
        return;
      }
      granted(response, issue(fake.sites));
      return;
    }
    if (body.grant_type === "refresh_token") {
      const old = body.refresh_token ?? "";
      const sites = refreshSites.get(old);
      const live = liveRefresh.has(old) || (!fake.strictRotation && spentRefresh.has(old));
      await fake.beforeRefresh();
      if (sites === undefined || !live || (fake.strictRotation && !liveRefresh.has(old))) {
        json(response, 403, {
          error: "invalid_grant",
          error_description: "Unknown or invalid refresh token.",
        });
        return;
      }
      liveRefresh.delete(old);
      spentRefresh.set(old, sites);
      granted(response, issue(sites));
      return;
    }
    json(response, 400, { error: "unsupported_grant_type" });
  }

  function authorize(url: URL, response: ServerResponse) {
    const query = Object.fromEntries(url.searchParams);
    fake.authorizations.push(query);
    const back = new URL(query.redirect_uri ?? "");
    back.searchParams.set("state", query.state ?? "");
    if (query.fake_denied === "1") {
      back.searchParams.set("error", "access_denied");
      back.searchParams.set("error_description", "The person went back: not for a log");
    } else {
      const code = hex(16);
      fake.codes.push(code);
      pending.set(code, {
        clientId: query.client_id ?? "",
        redirectUri: query.redirect_uri ?? "",
      });
      back.searchParams.set("code", code);
    }
    response.writeHead(302, { location: back.toString() });
    response.end();
  }

  /** The issues a JQL finds: the sprint it names, or all of them. */
  function matching(jql: string): FakeIssue[] {
    if (/^bad jql/i.test(jql)) return [];
    const sprint = /sprint = (\d+)/.exec(jql)?.[1];
    return sprint === undefined
      ? fake.issues
      : fake.issues.filter((each) => each.sprint === Number(sprint));
  }

  async function search(request: IncomingMessage, response: ServerResponse) {
    const body = (await bodyOf(request)) as {
      jql: string;
      nextPageToken?: string;
      maxResults?: number;
      fields?: string[];
    };
    if (/^bad jql/i.test(body.jql)) {
      json(response, 400, { errorMessages: [`Error in the JQL Query: ${body.jql}`] });
      return;
    }
    const found = matching(body.jql);
    const start = Number(body.nextPageToken ?? 0);
    const size = Math.min(body.maxResults ?? 50, 100);
    if (fake.pageFailure && start / size + 1 === fake.pageFailure.page) {
      const { status } = fake.pageFailure;
      delete fake.pageFailure;
      json(response, status, { errorMessages: ["Forced"] });
      return;
    }
    const page = found.slice(start, start + size);
    const end = start + page.length;
    json(response, 200, {
      issues: page.map(({ id, key, summary }) => ({
        id,
        key,
        self: `https://api.atlassian.com/rest/api/3/issue/${id}`,
        fields: { summary, reporter: { displayName: "Not for the queue" } },
      })),
      isLast: end >= found.length,
      ...(end < found.length ? { nextPageToken: String(end) } : {}),
    });
  }

  async function api(
    site: string,
    path: string,
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
  ) {
    const method = request.method;
    if (method === "POST" && path === "/rest/api/3/search/jql") {
      await search(request, response);
    } else if (method === "POST" && path === "/rest/api/3/search/approximate-count") {
      const { jql } = (await bodyOf(request)) as { jql: string };
      json(response, 200, { count: fake.approximate ?? matching(jql).length });
    } else if (method === "GET" && path === "/rest/api/3/field") {
      json(response, 200, FIELDS);
    } else if (method === "GET" && path === "/rest/agile/1.0/board") {
      const name = url.searchParams.get("name")?.toLowerCase();
      const boards = BOARDS.filter((each) => !name || each.name.toLowerCase().includes(name));
      json(response, 200, { values: boards, isLast: true, maxResults: 100, startAt: 0 });
    } else if (method === "GET" && /^\/rest\/agile\/1\.0\/board\/\d+\/sprint$/.test(path)) {
      const state = url.searchParams.get("state")?.split(",") ?? [];
      json(response, 200, {
        values: SPRINTS.filter((each) => state.includes(each.state)),
        isLast: true,
      });
    } else if (method === "PUT" && path.startsWith("/rest/api/3/issue/")) {
      const bearer = request.headers.authorization?.replace("Bearer ", "") ?? "";
      fake.writes.push({
        site,
        issue: path.slice("/rest/api/3/issue/".length),
        body: await bodyOf(request),
        token: bearer,
      });
      response.writeHead(204);
      response.end();
    } else {
      json(response, 404, { errorMessages: ["No such address"] });
    }
  }

  /** The first failure that matches, taken: true when it answered. */
  function forced(path: string, response: ServerResponse): boolean {
    const failure = fake.fail.find(({ match }) => path.includes(match));
    if (failure === undefined) return false;
    failure.times = (failure.times ?? 1) - 1;
    if (failure.times <= 0) fake.fail.splice(fake.fail.indexOf(failure), 1);
    if (failure.hang) return true;
    response.writeHead(failure.status, {
      "content-type": "application/json",
      ...(failure.retryAfter === undefined ? {} : { "retry-after": failure.retryAfter }),
    });
    response.end(JSON.stringify(failure.body ?? { errorMessages: ["Forced"] }));
    return true;
  }

  async function route(request: IncomingMessage, response: ServerResponse) {
    const url = new URL(request.url ?? "/", "http://fake.invalid");
    const path = url.pathname;
    if (path === "/__control" && request.method === "POST") {
      const control = (await bodyOf(request)) as FakeJiraControl;
      if (control.fail) fake.fail.push(...control.fail);
      if (control.sites) fake.sites = control.sites;
      if (control.issues) fake.issues = control.issues;
      if (control.approximate !== undefined) fake.approximate = control.approximate;
      json(response, 200, {});
      return;
    }
    if (path === "/__state") {
      json(response, 200, {
        writes: fake.writes,
        calls: fake.calls,
        authorizations: fake.authorizations,
      } satisfies FakeJiraState);
      return;
    }
    fake.calls.push(`${request.method} ${path}`);
    if (request.method === "GET" && path === "/authorize") {
      authorize(url, response);
      return;
    }
    if (forced(path, response)) return;
    if (request.method === "POST" && path === "/oauth/token") {
      await token(request, response);
      return;
    }
    const bearer = request.headers.authorization?.replace("Bearer ", "") ?? "";
    const sites = fake.revoked.has(bearer) ? undefined : liveAccess.get(bearer);
    if (sites === undefined) {
      json(response, 401, { code: 401, message: "Unauthorized" });
      return;
    }
    if (request.method === "GET" && path === "/oauth/token/accessible-resources") {
      json(
        response,
        200,
        sites.map((site) => ({ ...site, scopes: ["read:jira-work"], avatarUrl: "" })),
      );
      return;
    }
    const [, site, rest] = /^\/ex\/jira\/([^/]+)(\/.*)$/.exec(path) ?? [];
    if (site === undefined || rest === undefined || !sites.some(({ id }) => id === site)) {
      json(response, 403, { errorMessages: ["This site is not yours"] });
      return;
    }
    await api(site, rest, request, response, url);
  }

  const server = createServer((request, response) => {
    route(request, response).catch(() => json(response, 500, { error: "fake failed" }));
  });
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  server.unref();
  const address = server.address() as AddressInfo;
  return Object.assign(fake, {
    origin: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  });
}

const ATLASSIAN_HOSTS: ReadonlySet<string> = new Set(["auth.atlassian.com", "api.atlassian.com"]);

/** `https://auth.atlassian.com/…` at the fake: the same path and query. */
export function atFakeJira(address: string, origin: string): string {
  const url = new URL(address);
  return `${origin}${url.pathname}${url.search}`;
}

/**
 * Sends this process's `fetch` for Atlassian to the fake. Any other Atlassian address fails, so
 * a call the app should not make shows up: a site's own host above all, which the app must never
 * call. Returns how to put `fetch` back.
 */
export function routeAtlassianTo(origin: string): () => void {
  const real = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    const address = input instanceof Request ? input.url : String(input);
    const { hostname } = new URL(address);
    if (ATLASSIAN_HOSTS.has(hostname)) return real(atFakeJira(address, origin), init);
    if (/(^|\.)(atlassian\.com|atlassian\.net)$/.test(hostname)) {
      return Promise.reject(new Error("a request to an Atlassian address the fake does not know"));
    }
    return real(input, init);
  };
  return () => {
    globalThis.fetch = real;
  };
}
