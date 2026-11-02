/**
 * A stand-in for Azure DevOps Services, for tests only (#55, ADR-031), built from Microsoft's REST
 * reference for api-version 7.1. Not imported by `main.ts`, so never bundled and not in the image:
 * `connectors/fake-azure-devops.test.ts` holds that. A real HTTP server with the real shapes: Basic
 * authentication with a PAT, organisations, projects with continuation tokens, the four process
 * templates, WIQL with its cap, saved queries as a tree, `workitemsbatch` with its limit of 200,
 * and JSON Patch.
 *
 * Above all it answers a bad token as Azure DevOps often does: not with a 401, but with a 203 and a
 * sign-in page, or a redirect to one (`signIn`). What real errors look like past that is partly a
 * reading of the documentation, and ADR-031 says which parts.
 *
 * Nothing in the app points at it: a test, in its own process, replaces `fetch` with
 * `routeAzureTo`. An e2e spec reaches it by HTTP: `POST /__control` takes a `FakeAzureControl`,
 * `GET /__state` tells what it saw.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export const FAKE_ORGANIZATION = "fabrikam";
export const FAKE_OTHER_ORGANIZATION = "contoso";

export const PROJECT_AGILE = "6ce954b1-ce1f-45d1-b94d-e6bf2464ba2c";
export const PROJECT_SCRUM = "eb6e4656-77fc-42a1-9181-4c6d8e9da5d1";
export const PROJECT_BASIC = "281f9a5b-af0d-49b4-a1df-fe6f5e5f84d0";
export const PROJECT_CMMI = "3a8c1f2e-7d44-4f0e-9a15-0c9d2b6e1f77";
export const PROJECT_CUSTOM = "9f2b7c10-5e3a-4c8d-8b21-4d7e6a1c3b90";

export const STORY_POINTS = "Microsoft.VSTS.Scheduling.StoryPoints";
export const EFFORT = "Microsoft.VSTS.Scheduling.Effort";
export const SIZE = "Microsoft.VSTS.Scheduling.Size";
export const REMAINING = "Microsoft.VSTS.Scheduling.RemainingWork";
export const CUSTOM_POINTS = "Custom.Points";

export const QUERY_FOLDER = "11111111-aaaa-4aaa-8aaa-111111111111";
export const QUERY_MINE = "22222222-aaaa-4aaa-8aaa-222222222222";
export const QUERY_SHARED = "33333333-aaaa-4aaa-8aaa-333333333333";
export const QUERY_TREE = "44444444-aaaa-4aaa-8aaa-444444444444";
export const QUERY_DEEP_FOLDER = "55555555-aaaa-4aaa-8aaa-555555555555";
export const QUERY_DEEP = "66666666-aaaa-4aaa-8aaa-666666666666";

export type FakeProcess = "Agile" | "Scrum" | "Basic" | "CMMI" | "Custom";

export interface FakeProject {
  id: string;
  name: string;
  process: FakeProcess;
}

const PROJECTS: FakeProject[] = [
  { id: PROJECT_AGILE, name: "Fabrikam Fiber", process: "Agile" },
  { id: PROJECT_SCRUM, name: "Scrum Team", process: "Scrum" },
  { id: PROJECT_BASIC, name: "Basic Team", process: "Basic" },
  { id: PROJECT_CMMI, name: "Regulated", process: "CMMI" },
  { id: PROJECT_CUSTOM, name: "Own Way", process: "Custom" },
];

/** What each process's types carry that is a number, as the templates define them. */
const TYPES: Record<FakeProcess, Record<string, string[]>> = {
  Agile: { "User Story": [STORY_POINTS], Bug: [STORY_POINTS], Task: [REMAINING] },
  Scrum: { "Product Backlog Item": [EFFORT], Bug: [EFFORT], Task: [REMAINING] },
  Basic: { Issue: [EFFORT], Task: [REMAINING] },
  CMMI: { Requirement: [SIZE], Task: [REMAINING] },
  Custom: { Story: [CUSTOM_POINTS, STORY_POINTS], Note: [] },
};

/** The fields of a project, with their kind. `System.Id` is read-only; a title is no number. */
const FIELDS = [
  { referenceName: "System.Id", name: "ID", type: "integer", readOnly: true },
  { referenceName: "System.Title", name: "Title", type: "string", readOnly: false },
  { referenceName: "System.AreaId", name: "Area ID", type: "integer", readOnly: false },
  { referenceName: "System.WorkItemType", name: "Type", type: "string", readOnly: false },
  { referenceName: STORY_POINTS, name: "Story Points", type: "double", readOnly: false },
  { referenceName: EFFORT, name: "Effort", type: "double", readOnly: false },
  { referenceName: SIZE, name: "Size", type: "double", readOnly: false },
  { referenceName: REMAINING, name: "Remaining Work", type: "double", readOnly: false },
  { referenceName: CUSTOM_POINTS, name: "Points", type: "integer", readOnly: false },
];

export interface FakeWorkItem {
  id: number;
  title: string;
  type: string;
  /** A project's id. */
  project?: string;
  /** Who may read it: hidden items come back from a batch as null. */
  hidden?: boolean;
}

export const fakeWorkItems = (count: number, type = "User Story", from = 1): FakeWorkItem[] =>
  Array.from({ length: count }, (_, n) => ({
    id: from + n,
    title: `Work item ${from + n}`,
    type,
  }));

export interface FakeToken {
  organizations: string[];
  /** The PAT's scopes, as ticked: `vso.work_write`, `vso.work`, `vso.code`. */
  scopes: string[];
}

export interface FakeWrite {
  organization: string;
  item: string;
  /** The body, whole, as Azure DevOps received it. */
  body: unknown;
  contentType: string;
  token: string;
}

/** An answer forced on the next calls whose path holds `match`. */
export interface FakeAzureFailure {
  match: string;
  /** Only this method; any by default. */
  method?: string;
  status: number;
  retryAfter?: string;
  times?: number;
  /** Text as it stands; else `message` in Azure DevOps' error body. */
  text?: string;
  message?: string;
  contentType?: string;
  location?: string;
  hang?: boolean;
}

export interface FakeAzureControl {
  fail?: FakeAzureFailure[];
  tokens?: Record<string, FakeToken>;
  items?: FakeWorkItem[];
  signIn?: "203" | "302" | "401";
  scopeRefusal?: 401 | 403;
  reset?: boolean;
}

export interface FakeAzureState {
  writes: FakeWrite[];
  /** Every request, method and path, without a query. */
  calls: string[];
}

export interface FakeAzure extends FakeAzureState {
  readonly origin: string;
  tokens: Record<string, FakeToken>;
  items: FakeWorkItem[];
  projects: FakeProject[];
  fail: FakeAzureFailure[];
  /** How an unknown token is answered. */
  signIn: "203" | "302" | "401";
  /** How a token without a scope is answered. */
  scopeRefusal: 401 | 403;
  /** Rows of a page of projects, whatever `$top` says. */
  projectPage: number;
  /** Every query string it received, by call. */
  queries: string[];
  /** Each `$top` a WIQL carried. */
  tops: string[];
  /** Each batch's ids. */
  batches: number[][];
  /** The WIQL of each run. */
  wiql: string[];
  /** The tree a saved query reads as: ids flat, or `tree` as parent and children. */
  saved: Record<string, { ids?: number[]; tree?: [number, number][] }>;
  reset(): void;
  close(): Promise<void>;
}

const SIGN_IN_PAGE =
  "<!DOCTYPE html><html><head><title>Azure DevOps Services | Sign In</title></head><body></body></html>";

export const FAKE_TOKEN = "fake-pat-work-write-0123456789abcdefghijklmnopqrstuvwxyz";
export const FAKE_READ_TOKEN = "fake-pat-work-read-0123456789abcdefghijklmnopqrstuvwxyz0";
export const FAKE_CODE_TOKEN = "fake-pat-code-only-0123456789abcdefghijklmnopqrstuvwxyz0";
export const FAKE_STRANGER_TOKEN = "fake-pat-other-org-0123456789abcdefghijklmnopqrstuvwxyz0";
export const FAKE_SECOND_TOKEN = "fake-pat-second-person-0123456789abcdefghijklmnopqrstuvw";

const fakeTokens = (): Record<string, FakeToken> => ({
  [FAKE_TOKEN]: { organizations: [FAKE_ORGANIZATION], scopes: ["vso.work_write"] },
  [FAKE_SECOND_TOKEN]: { organizations: [FAKE_ORGANIZATION], scopes: ["vso.work_write"] },
  [FAKE_READ_TOKEN]: { organizations: [FAKE_ORGANIZATION], scopes: ["vso.work"] },
  [FAKE_CODE_TOKEN]: { organizations: [FAKE_ORGANIZATION], scopes: ["vso.code"] },
  [FAKE_STRANGER_TOKEN]: { organizations: [FAKE_OTHER_ORGANIZATION], scopes: ["vso.work_write"] },
});

async function bodyOf(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString();
}

const JSON_TYPE = "application/json; charset=utf-8; api-version=7.1";

function json(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, { "content-type": JSON_TYPE });
  response.end(JSON.stringify(body));
}

const refusal = (message: string) => ({
  $id: "1",
  innerException: null,
  message,
  typeName: "Microsoft.VisualStudio.Services.Common.VssServiceException",
  typeKey: "VssServiceException",
  errorCode: 0,
  eventId: 3000,
});

/** Who a PAT is, from its Basic header. */
function patOf(request: IncomingMessage): string {
  const header = request.headers.authorization ?? "";
  if (!header.startsWith("Basic ")) return "";
  const decoded = Buffer.from(header.slice("Basic ".length), "base64").toString();
  return decoded.startsWith(":") ? decoded.slice(1) : "";
}

/** `port`: 0 picks a free one. */
export async function startFakeAzure(port = 0): Promise<FakeAzure> {
  const fake = {
    writes: [] as FakeWrite[],
    calls: [] as string[],
    tokens: fakeTokens(),
    items: [] as FakeWorkItem[],
    projects: [...PROJECTS],
    fail: [] as FakeAzureFailure[],
    signIn: "203" as FakeAzure["signIn"],
    scopeRefusal: 401 as FakeAzure["scopeRefusal"],
    projectPage: 100,
    queries: [] as string[],
    tops: [] as string[],
    batches: [] as number[][],
    wiql: [] as string[],
    saved: {} as FakeAzure["saved"],
    reset() {
      fake.writes.length = 0;
      fake.calls.length = 0;
      fake.tokens = fakeTokens();
      fake.items = [];
      fake.projects = [...PROJECTS];
      fake.fail = [];
      fake.signIn = "203";
      fake.scopeRefusal = 401;
      fake.projectPage = 100;
      fake.queries.length = 0;
      fake.tops.length = 0;
      fake.batches.length = 0;
      fake.wiql.length = 0;
      fake.saved = {};
    },
  };

  let origin = "";

  function signIn(response: ServerResponse) {
    if (fake.signIn === "401") {
      response.writeHead(401, { "content-type": "text/html" });
      response.end(SIGN_IN_PAGE);
    } else if (fake.signIn === "302") {
      response.writeHead(302, { location: `${origin}/_signin?reply=to` });
      response.end();
    } else {
      response.writeHead(203, { "content-type": "text/html; charset=utf-8" });
      response.end(SIGN_IN_PAGE);
    }
  }

  const has = (token: FakeToken, scope: string) => {
    const scopes = new Set(token.scopes);
    if (scopes.has("vso.work_write")) scopes.add("vso.work");
    return scopes.has(scope);
  };

  function noScope(response: ServerResponse) {
    json(response, fake.scopeRefusal, refusal("The token lacks a scope: this says so in words."));
  }

  const projectOf = (segment: string) => {
    const decoded = decodeURIComponent(segment);
    return fake.projects.find(({ id, name }) => id === decoded || name === decoded);
  };

  function typesOf(project: FakeProject | undefined, response: ServerResponse) {
    if (project !== undefined) return TYPES[project.process];
    json(response, 404, refusal("TF200016: The project does not exist."));
    return null;
  }

  const itemProject = (item: FakeWorkItem) => item.project ?? PROJECT_AGILE;

  /** The ids a WIQL finds: the type it names, or every item. `bad wiql` is refused. */
  function matching(wiql: string): number[] {
    const type = /\[System\.WorkItemType\] = '([^']+)'/.exec(wiql)?.[1];
    return fake.items.filter((item) => !type || item.type === type).map(({ id }) => id);
  }

  function queryResult(url: URL, ids: number[], response: ServerResponse) {
    const top = url.searchParams.get("$top");
    fake.tops.push(top ?? "");
    if (top === null && ids.length > 20_000) {
      json(
        response,
        400,
        refusal("VS402337: The number of work items returned exceeds the size limit of 20000."),
      );
      return;
    }
    const kept = ids.slice(0, Number(top ?? ids.length));
    json(response, 200, {
      queryType: "flat",
      queryResultType: "workItem",
      asOf: "2026-11-02T10:00:00Z",
      columns: [{ referenceName: "System.Id", name: "ID" }],
      workItems: kept.map((id) => ({ id, url: `${origin}/_apis/wit/workItems/${id}` })),
    });
  }

  function savedResult(id: string, url: URL, response: ServerResponse) {
    if (id === QUERY_FOLDER || id === QUERY_DEEP_FOLDER) {
      json(response, 400, refusal("TF401256: You cannot run a folder."));
      return;
    }
    const result = fake.saved[id];
    if (result === undefined) {
      json(response, 404, refusal("TF401232: The query does not exist."));
      return;
    }
    if (result.tree) {
      const roots = [...new Set(result.tree.map(([parent]) => parent))];
      json(response, 200, {
        queryType: "tree",
        queryResultType: "workItemLink",
        workItemRelations: [
          ...roots.map((id) => ({ rel: null, source: null, target: { id } })),
          ...result.tree.map(([parent, child]) => ({
            rel: "System.LinkTypes.Hierarchy-Forward",
            source: { id: parent },
            target: { id: child },
          })),
        ],
      });
      return;
    }
    queryResult(url, result.ids ?? [], response);
  }

  function queryTree(depth: number) {
    const query = (id: string, name: string, path: string) => ({
      id,
      name,
      path,
      isFolder: false,
      isPublic: path.startsWith("Shared"),
      _links: { wiql: { href: "https://example.invalid/not-for-the-queue" } },
    });
    const deepFolder = {
      id: QUERY_DEEP_FOLDER,
      name: "Sprint",
      path: "Shared Queries/Team/Sprint",
      isFolder: true,
      hasChildren: true,
    };
    const team = {
      id: QUERY_FOLDER,
      name: "Team",
      path: "Shared Queries/Team",
      isFolder: true,
      hasChildren: true,
      children: [
        query(QUERY_SHARED, "Backlog", "Shared Queries/Team/Backlog"),
        query(QUERY_TREE, "Stories and tasks", "Shared Queries/Team/Stories and tasks"),
        deepFolder,
      ],
    };
    return [
      {
        id: "77777777-aaaa-4aaa-8aaa-777777777777",
        name: "My Queries",
        path: "My Queries",
        isFolder: true,
        hasChildren: true,
        children: [query(QUERY_MINE, "Mine", "My Queries/Mine")],
      },
      {
        id: "88888888-aaaa-4aaa-8aaa-888888888888",
        name: "Shared Queries",
        path: "Shared Queries",
        isFolder: true,
        hasChildren: true,
        ...(depth >= 2 ? { children: [team] } : {}),
      },
      {
        id: "99999999-aaaa-4aaa-8aaa-999999999999",
        name: "Empty",
        path: "Empty",
        isFolder: true,
        hasChildren: false,
      },
    ];
  }

  function projects(url: URL, response: ServerResponse) {
    const start = Number(url.searchParams.get("continuationToken") ?? 0);
    const size = Math.min(Number(url.searchParams.get("$top") ?? 100), fake.projectPage);
    const page = fake.projects.slice(start, start + size);
    const end = start + page.length;
    response.writeHead(200, {
      "content-type": JSON_TYPE,
      ...(end < fake.projects.length ? { "x-ms-continuationtoken": String(end) } : {}),
    });
    response.end(
      JSON.stringify({
        count: page.length,
        value: page.map(({ id, name }) => ({ id, name, state: "wellFormed", revision: 1 })),
      }),
    );
  }

  async function workItems(
    organization: string,
    id: string,
    pat: string,
    token: FakeToken,
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
  ) {
    const item = fake.items.find((each) => String(each.id) === id);
    if (item === undefined) {
      json(response, 404, refusal(`TF401232: Work item ${id} does not exist.`));
      return;
    }
    if (request.method === "GET") {
      const project = fake.projects.find(({ id: each }) => each === itemProject(item));
      const wanted = url.searchParams.get("fields")?.split(",") ?? [];
      const all: Record<string, unknown> = {
        "System.WorkItemType": item.type,
        "System.TeamProject": project?.name,
        "System.Title": item.title,
        "System.AssignedTo": { displayName: "Not for the queue" },
      };
      json(response, 200, {
        id: item.id,
        rev: 1,
        fields: Object.fromEntries(wanted.map((field) => [field, all[field]])),
      });
      return;
    }
    if (request.method !== "PATCH") {
      json(response, 405, refusal("Not a method here."));
      return;
    }
    if (!has(token, "vso.work_write")) {
      noScope(response);
      return;
    }
    const contentType = request.headers["content-type"] ?? "";
    if (contentType !== "application/json-patch+json") {
      json(response, 415, refusal("VS403431: The content type is not supported."));
      return;
    }
    const body: unknown = JSON.parse(await bodyOf(request));
    const path = (body as { path?: string }[])[0]?.path ?? "";
    const carried =
      TYPES[fake.projects.find(({ id: each }) => each === itemProject(item))?.process ?? "Agile"][
        item.type
      ];
    if (!carried?.includes(path.replace("/fields/", ""))) {
      json(response, 400, refusal(`TF51535: Cannot find field ${path}.`));
      return;
    }
    fake.writes.push({ organization, item: id, body, contentType, token: pat });
    json(response, 200, { id: item.id, rev: 2, fields: {} });
  }

  /** `path` after the organisation. */
  async function api(
    organization: string,
    path: string,
    pat: string,
    token: FakeToken,
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
  ) {
    const method = request.method;
    if (url.searchParams.get("api-version") !== "7.1") {
      json(response, 400, refusal("VS800071: The api-version is missing or unknown."));
      return;
    }
    if (path === "/_apis/projects") {
      projects(url, response);
      return;
    }
    if (!has(token, "vso.work")) {
      noScope(response);
      return;
    }
    if (path === "/_apis/wit/fields/System.Title") {
      json(response, 200, { name: "Title", referenceName: "System.Title", type: "string" });
      return;
    }
    if (method === "POST" && path === "/_apis/wit/workitemsbatch") {
      const body = JSON.parse(await bodyOf(request)) as { ids: number[] };
      fake.batches.push(body.ids);
      if (body.ids.length > 200) {
        json(response, 400, refusal("VS402336: A batch takes at most 200 ids."));
        return;
      }
      const value = body.ids.map((id) => {
        const item = fake.items.find((each) => each.id === id);
        if (item === undefined || item.hidden) return null;
        return {
          id: item.id,
          rev: 1,
          fields: { "System.Title": item.title, "System.CreatedBy": { displayName: "No one" } },
          url: `${origin}/_apis/wit/workItems/${item.id}`,
        };
      });
      json(response, 200, { count: value.length, value });
      return;
    }
    const item = /^\/_apis\/wit\/workitems\/([^/]+)$/.exec(path)?.[1];
    if (item !== undefined) {
      await workItems(organization, item, pat, token, request, response, url);
      return;
    }
    const [, segment, rest] = /^\/([^/]+)(\/_apis\/wit\/.*)$/.exec(path) ?? [];
    if (segment === undefined || rest === undefined) {
      json(response, 404, refusal("VS800001: No such address."));
      return;
    }
    const project = projectOf(segment);
    if (method === "POST" && rest === "/_apis/wit/wiql") {
      const { query } = JSON.parse(await bodyOf(request)) as { query: string };
      fake.wiql.push(query);
      if (/^bad wiql/i.test(query)) {
        json(response, 400, refusal(`TF51006: The query is wrong: ${query}`));
        return;
      }
      queryResult(url, matching(query), response);
      return;
    }
    const saved = /^\/_apis\/wit\/wiql\/([^/]+)$/.exec(rest)?.[1];
    if (method === "GET" && saved !== undefined) {
      savedResult(saved, url, response);
      return;
    }
    if (method === "GET" && rest === "/_apis/wit/queries") {
      const depth = Number(url.searchParams.get("$depth") ?? 0);
      if (depth > 2) {
        json(response, 400, refusal("TF401243: The depth is limited to 2."));
        return;
      }
      const value = queryTree(depth);
      json(response, 200, { count: value.length, value });
      return;
    }
    if (method === "GET" && rest === `/_apis/wit/queries/${QUERY_DEEP_FOLDER}`) {
      json(response, 200, {
        id: QUERY_DEEP_FOLDER,
        name: "Sprint",
        path: "Shared Queries/Team/Sprint",
        isFolder: true,
        hasChildren: true,
        children: [
          {
            id: QUERY_DEEP,
            name: "Deep",
            path: "Shared Queries/Team/Sprint/Deep",
            isFolder: false,
          },
        ],
      });
      return;
    }
    if (method === "GET" && rest === "/_apis/wit/fields") {
      json(response, 200, { count: FIELDS.length, value: FIELDS });
      return;
    }
    if (method === "GET" && rest === "/_apis/wit/workitemtypes") {
      const types = typesOf(project, response);
      if (types === null) return;
      const value = Object.keys(types).map((name) => ({ name, referenceName: name }));
      json(response, 200, {
        count: value.length + 1,
        value: [...value, { name: "Retired", isDisabled: true }],
      });
      return;
    }
    const type = /^\/_apis\/wit\/workitemtypes\/([^/]+)\/fields$/.exec(rest)?.[1];
    if (method === "GET" && type !== undefined) {
      const types = typesOf(project, response);
      if (types === null) return;
      const carried = types[decodeURIComponent(type)];
      if (carried === undefined) {
        json(response, 404, refusal("TF401342: The work item type does not exist."));
        return;
      }
      const value = FIELDS.filter(
        ({ referenceName }) =>
          carried.includes(referenceName) || referenceName.startsWith("System."),
      ).map(({ referenceName, name }) => ({ referenceName, name, alwaysRequired: false }));
      json(response, 200, { count: value.length, value });
      return;
    }
    json(response, 404, refusal("VS800001: No such address."));
  }

  /** The first failure that matches, taken: true when it answered. */
  function forced(method: string, path: string, response: ServerResponse): boolean {
    const failure = fake.fail.find(
      (each) => path.includes(each.match) && (each.method ?? method) === method,
    );
    if (failure === undefined) return false;
    failure.times = (failure.times ?? 1) - 1;
    if (failure.times <= 0) fake.fail.splice(fake.fail.indexOf(failure), 1);
    if (failure.hang) return true;
    response.writeHead(failure.status, {
      "content-type": failure.contentType ?? JSON_TYPE,
      ...(failure.retryAfter === undefined ? {} : { "retry-after": failure.retryAfter }),
      ...(failure.location === undefined ? {} : { location: failure.location }),
    });
    response.end(failure.text ?? JSON.stringify(refusal(failure.message ?? "Forced")));
    return true;
  }

  async function route(request: IncomingMessage, response: ServerResponse) {
    const url = new URL(request.url ?? "/", "http://fake.invalid");
    const path = url.pathname;
    if (path === "/__control" && request.method === "POST") {
      const control = JSON.parse(await bodyOf(request)) as FakeAzureControl;
      if (control.reset) fake.reset();
      if (control.fail) fake.fail.push(...control.fail);
      if (control.tokens) fake.tokens = { ...fake.tokens, ...control.tokens };
      if (control.items) fake.items = control.items;
      if (control.signIn) fake.signIn = control.signIn;
      if (control.scopeRefusal) fake.scopeRefusal = control.scopeRefusal;
      json(response, 200, {});
      return;
    }
    if (path === "/__state") {
      json(response, 200, { writes: fake.writes, calls: fake.calls } satisfies FakeAzureState);
      return;
    }
    fake.calls.push(`${request.method} ${path}`);
    fake.queries.push(url.search);
    if (forced(request.method ?? "", path, response)) return;
    if (path === "/_signin") {
      json(response, 500, refusal("A redirect was followed: this should never be read."));
      return;
    }
    const [, organization, rest] = /^\/([^/]+)(\/.*)$/.exec(path) ?? [];
    if (organization === undefined || rest === undefined) {
      json(response, 404, refusal("VS800001: No such address."));
      return;
    }
    if (organization !== FAKE_ORGANIZATION && organization !== FAKE_OTHER_ORGANIZATION) {
      json(response, 404, refusal(`VS800050: The organization ${organization} was not found.`));
      return;
    }
    const pat = patOf(request);
    const token = fake.tokens[pat];
    if (token === undefined) {
      signIn(response);
      return;
    }
    if (!token.organizations.includes(organization)) {
      json(response, 401, refusal("TF400813: The user is not authorized to access this resource."));
      return;
    }
    await api(organization, rest, pat, token, request, response, url);
  }

  const server = createServer((request, response) => {
    route(request, response).catch(() => json(response, 500, refusal("fake failed")));
  });
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  server.unref();
  const address = server.address() as AddressInfo;
  origin = `http://127.0.0.1:${address.port}`;
  return Object.assign(fake, {
    origin,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  });
}

/**
 * Sends this process's `fetch` for `dev.azure.com` to the fake. Any other Microsoft address fails,
 * so a call the app should not make shows up. Returns how to put `fetch` back.
 */
export function routeAzureTo(origin: string): () => void {
  const real = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    const address = input instanceof Request ? input.url : String(input);
    const url = new URL(address);
    if (url.hostname === "dev.azure.com")
      return real(`${origin}${url.pathname}${url.search}`, init);
    if (/(^|\.)(visualstudio\.com|azure\.com)$/.test(url.hostname)) {
      return Promise.reject(new Error("a request to a Microsoft address the fake does not know"));
    }
    return real(input, init);
  };
  return () => {
    globalThis.fetch = real;
  };
}
