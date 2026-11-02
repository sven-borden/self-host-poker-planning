/**
 * The Azure DevOps client (#55, ADR-031) against the stand-in, over real HTTP: `fetch` is replaced
 * in this process only, and sends `dev.azure.com` there. No database and no server: every way a
 * token can be bad, every process's field, and every class of error.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CUSTOM_POINTS,
  EFFORT,
  FAKE_CODE_TOKEN,
  FAKE_ORGANIZATION,
  FAKE_READ_TOKEN,
  FAKE_STRANGER_TOKEN,
  FAKE_TOKEN,
  type FakeAzure,
  fakeWorkItems,
  PROJECT_AGILE,
  PROJECT_BASIC,
  PROJECT_CMMI,
  PROJECT_CUSTOM,
  PROJECT_SCRUM,
  QUERY_DEEP,
  QUERY_FOLDER,
  QUERY_MINE,
  QUERY_SHARED,
  QUERY_TREE,
  REMAINING,
  routeAzureTo,
  SIZE,
  STORY_POINTS,
  startFakeAzure,
} from "../fake-azure-devops.ts";
import { Secret } from "../vault.ts";
import {
  API_VERSION,
  type AzureConnector,
  azureUrl,
  createAzureConnector,
  FIELD_CACHE_MS,
  MAX_PROJECT_PAGES,
  WIQL_CAP,
  WORK_ITEM_BATCH,
} from "./azure-devops.ts";

const ORG = FAKE_ORGANIZATION;
const token = new Secret(FAKE_TOKEN);
const site = (project: string) => `${ORG}/${project}`;
const SITE = {
  id: site(PROJECT_AGILE),
  name: "Fabrikam Fiber",
  url: `https://dev.azure.com/${ORG}`,
  home: ORG,
};

let fake: FakeAzure;
let restore: () => void;
let now = 0;
let azure: AzureConnector;

beforeAll(async () => {
  fake = await startFakeAzure();
  restore = routeAzureTo(fake.origin);
});

afterAll(async () => {
  restore();
  await fake.close();
});

beforeEach(() => {
  fake.reset();
  now = 1_000_000;
  azure = createAzureConnector(() => now);
});

describe("an address", () => {
  it("is built from a checked organisation, with a pinned version", () => {
    expect(API_VERSION).toBe("7.1");
    expect(azureUrl("fabrikam", "_apis/projects", { $top: "1" })).toBe(
      "https://dev.azure.com/fabrikam/_apis/projects?$top=1&api-version=7.1",
    );
  });

  it.each([
    "evil.example",
    "fabrikam/../other",
    "fabrikam@evil.example",
    "-fabrikam",
    "fabrikam-",
    "fa brikam",
    "a".repeat(51),
    "",
  ])("is refused for %j, before a token goes anywhere", async (organization) => {
    expect(azureUrl(organization, "_apis/projects")).toBeNull();
    expect(await azure.checkToken(organization, token)).toEqual({
      ok: false,
      code: "connector_no_organization",
    });
    expect(await azure.sites(token, organization)).toEqual({
      ok: false,
      code: "connector_not_found",
    });
    expect(fake.calls).toEqual([]);
  });

  it("takes a name of one character and one of fifty", () => {
    expect(azureUrl("a", "x")).not.toBeNull();
    expect(azureUrl("a".repeat(50), "x")).not.toBeNull();
  });
});

describe("checking a token", () => {
  it("takes a token that reads work items, with one read, as Basic with no user", async () => {
    const seen: string[] = [];
    const real = globalThis.fetch;
    globalThis.fetch = (input, init) => {
      seen.push(new Headers(init?.headers).get("authorization") ?? "");
      return real(input, init);
    };
    try {
      expect(await azure.checkToken(ORG, token)).toEqual({ ok: true, value: undefined });
    } finally {
      globalThis.fetch = real;
    }
    expect(fake.calls).toEqual([`GET /${ORG}/_apis/wit/fields/System.Title`]);
    expect(seen).toEqual([`Basic ${Buffer.from(`:${FAKE_TOKEN}`).toString("base64")}`]);
  });

  it("takes a token that can only read: a read cannot show the right to write", async () => {
    expect((await azure.checkToken(ORG, new Secret(FAKE_READ_TOKEN))).ok).toBe(true);
  });

  it.each(["203", "302", "401"] as const)("reads a %s for a bad token", async (signIn) => {
    fake.signIn = signIn;
    expect(await azure.checkToken(ORG, new Secret("no-such-token"))).toEqual({
      ok: false,
      code: "connector_bad_token",
    });
  });

  it("follows no redirect, so a token never reaches where one points", async () => {
    fake.signIn = "302";
    await azure.checkToken(ORG, new Secret("no-such-token"));
    expect(fake.calls).not.toContain("GET /_signin");
  });

  it("tells an organisation that does not know this person", async () => {
    expect(await azure.checkToken(ORG, new Secret(FAKE_STRANGER_TOKEN))).toEqual({
      ok: false,
      code: "connector_no_access",
    });
  });

  it("calls a 403 on both reads no access", async () => {
    fake.fail = [{ match: "/_apis/", status: 403, times: 2 }];
    expect(await azure.checkToken(ORG, token)).toEqual({ ok: false, code: "connector_no_access" });
  });

  it("calls a plain 401 on both reads a bad token", async () => {
    fake.fail = [{ match: "/_apis/", status: 401, times: 2, text: "", contentType: "text/plain" }];
    expect(await azure.checkToken(ORG, token)).toEqual({ ok: false, code: "connector_bad_token" });
  });

  it.each([401, 403] as const)("tells a token without the scope, by a %s", async (status) => {
    fake.scopeRefusal = status;
    expect(await azure.checkToken(ORG, new Secret(FAKE_CODE_TOKEN))).toEqual({
      ok: false,
      code: "connector_scope",
    });
  });

  it("tells an organisation that does not exist", async () => {
    expect(await azure.checkToken("no-such-org", token)).toEqual({
      ok: false,
      code: "connector_no_organization",
    });
  });

  it("calls a sign-in page on the second read a bad token", async () => {
    fake.fail = [
      { match: "/fields/", status: 401, text: "", contentType: "text/plain" },
      { match: "/_apis/projects", status: 203, text: "<html>", contentType: "text/html" },
    ];
    expect(await azure.checkToken(ORG, token)).toEqual({ ok: false, code: "connector_bad_token" });
  });

  it("tells an organisation that is gone on the second read", async () => {
    fake.fail = [
      { match: "/fields/", status: 403 },
      { match: "/_apis/projects", status: 404 },
    ];
    expect(await azure.checkToken(ORG, token)).toEqual({
      ok: false,
      code: "connector_no_organization",
    });
  });

  it("never reads a page that is no JSON as success", async () => {
    fake.fail = [{ match: "/fields/", status: 200, text: "<html>", contentType: "text/html" }];
    expect(await azure.checkToken(ORG, token)).toEqual({
      ok: false,
      code: "connector_unavailable",
    });
  });

  it("passes a wait on, and leaves a server's failure a server's", async () => {
    fake.fail = [{ match: "/fields/", status: 429, retryAfter: "12" }];
    expect(await azure.checkToken(ORG, token)).toEqual({
      ok: false,
      code: "connector_rate_limited",
      retryAfter: 12,
    });
    fake.fail = [{ match: "/fields/", status: 503 }];
    expect((await azure.checkToken(ORG, token)).ok).toBe(false);
    fake.fail = [
      { match: "/fields/", status: 401 },
      { match: "/_apis/projects", status: 500 },
    ];
    expect(await azure.checkToken(ORG, token)).toEqual({
      ok: false,
      code: "connector_unavailable",
    });
  });
});

describe("every call with a dead token", () => {
  const calls: [string, () => Promise<{ ok: boolean; code?: string }>][] = [
    ["projects", () => azure.sites(new Secret("dead"), ORG)],
    ["types", () => azure.workItemTypes(new Secret("dead"), SITE.id)],
    ["fields", () => azure.numberFields(new Secret("dead"), SITE.id, "User Story")],
    ["saved queries", () => azure.savedQueries(new Secret("dead"), SITE.id)],
    ["a search", () => azure.search(new Secret("dead"), SITE, { wiql: "Select" }, undefined)],
    ["a count", () => azure.count(new Secret("dead"), SITE.id, { wiql: "Select" })],
    ["the item's field", () => azure.fieldFor(new Secret("dead"), ORG, "1", undefined)],
  ];

  it.each(["203", "302", "401"] as const)("says connect again, on a %s", async (signIn) => {
    fake.signIn = signIn;
    for (const [name, call] of calls) {
      expect(await call(), name).toEqual({ ok: false, code: "connector_reconnect" });
    }
    expect(await azure.refresh(new Secret(""))).toEqual({
      ok: false,
      code: "connector_reconnect",
    });
  });
});

describe("projects", () => {
  it("lists them with the organisation around each", async () => {
    const sites = await azure.sites(token, ORG);
    expect(sites.ok && sites.value[0]).toEqual({
      id: `${ORG}/${PROJECT_AGILE}`,
      name: "Fabrikam Fiber",
      url: `https://dev.azure.com/${ORG}`,
      home: ORG,
    });
    expect(sites.ok && sites.value.length).toBe(5);
  });

  it("needs to know the organisation", async () => {
    expect(await azure.sites(token)).toEqual({ ok: false, code: "connector_not_found" });
  });

  it("follows the continuation token", async () => {
    fake.projectPage = 2;
    const sites = await azure.sites(token, ORG);
    expect(sites.ok && sites.value.length).toBe(5);
    expect(fake.calls.filter((call) => call.endsWith("/_apis/projects"))).toHaveLength(3);
    expect(fake.queries[1]).toContain("continuationToken=2");
  });

  it("stops after a bounded number of pages", async () => {
    fake.projectPage = 1;
    fake.projects = Array.from({ length: 50 }, (_, n) => ({
      id: `${String(n).padStart(8, "0")}-0000-4000-8000-000000000000`,
      name: `Project ${n}`,
      process: "Agile",
    }));
    const sites = await azure.sites(token, ORG);
    expect(sites.ok && sites.value.length).toBe(MAX_PROJECT_PAGES);
  });

  it("stops at a continuation token that is not one", async () => {
    fake.fail = [];
    const real = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const answer = await real(input, init);
      const headers = new Headers(answer.headers);
      headers.set("x-ms-continuationtoken", "bad token&x=1");
      return new Response(await answer.text(), { status: answer.status, headers });
    };
    try {
      await azure.sites(token, ORG);
    } finally {
      globalThis.fetch = real;
    }
    expect(fake.calls).toHaveLength(1);
  });
});

describe("the estimate's field", () => {
  const item = (id: number, type: string, project: string) => ({
    id,
    title: `Item ${id}`,
    type,
    project,
  });

  it.each([
    ["Agile", PROJECT_AGILE, "User Story", STORY_POINTS],
    ["Agile's bug", PROJECT_AGILE, "Bug", STORY_POINTS],
    ["Scrum", PROJECT_SCRUM, "Product Backlog Item", EFFORT],
    ["Basic", PROJECT_BASIC, "Issue", EFFORT],
    ["CMMI", PROJECT_CMMI, "Requirement", SIZE],
  ])("is the one %s's type carries", async (_name, project, type, field) => {
    fake.items = [item(1, type, project)];
    expect(await azure.fieldFor(token, ORG, "1", undefined)).toEqual({ ok: true, value: field });
  });

  it("goes by what a custom type carries and not by a process's name", async () => {
    fake.items = [item(1, "Story", PROJECT_CUSTOM)];
    expect(await azure.fieldFor(token, ORG, "1", undefined)).toEqual({
      ok: true,
      value: STORY_POINTS,
    });
    expect(await azure.fieldFor(token, ORG, "1", CUSTOM_POINTS)).toEqual({
      ok: true,
      value: CUSTOM_POINTS,
    });
  });

  it("leaves a choice for a type that does not carry it", async () => {
    fake.items = [item(1, "User Story", PROJECT_AGILE)];
    expect(await azure.fieldFor(token, ORG, "1", CUSTOM_POINTS)).toEqual({
      ok: true,
      value: STORY_POINTS,
    });
  });

  it("says a Task has none, without a failure of the tracker", async () => {
    fake.items = [item(1, "Task", PROJECT_AGILE)];
    expect(await azure.fieldFor(token, ORG, "1", undefined)).toEqual({
      ok: false,
      code: "connector_no_estimate_field",
    });
    fake.items = [item(2, "Note", PROJECT_CUSTOM)];
    expect(await azure.fieldFor(token, ORG, "2", undefined)).toEqual({
      ok: false,
      code: "connector_no_estimate_field",
    });
  });

  it("refuses an id that is no number, before a token goes anywhere", async () => {
    for (const id of ["1/../2", "abc", "0", "-1", "1e3", ""]) {
      expect(await azure.fieldFor(token, ORG, id, undefined)).toEqual({
        ok: false,
        code: "connector_not_found",
      });
    }
    expect(fake.calls).toEqual([]);
  });

  it("refuses a type or project name that would change the path", async () => {
    for (const type of ["..", ".", "a/b", "a?b", "a#b", "a%2fb", "a\\b", "a\nb"]) {
      expect(await azure.numberFields(token, SITE.id, type), type).toEqual({
        ok: false,
        code: "connector_not_found",
      });
    }
    fake.fail = [
      {
        match: "/_apis/wit/workitems/1",
        status: 200,
        text: JSON.stringify({
          fields: { "System.WorkItemType": "Bug", "System.TeamProject": "../other" },
        }),
      },
    ];
    expect(await azure.fieldFor(token, ORG, "1", undefined)).toEqual({
      ok: false,
      code: "connector_not_found",
    });
    expect(fake.calls).toEqual(["GET /fabrikam/_apis/wit/workitems/1"]);
  });

  it("encodes a type's name with a space and an ampersand in the path", async () => {
    await azure.numberFields(token, SITE.id, "R&D Story");
    expect(fake.calls.at(-1)).toContain("R%26D%20Story");
  });

  it("lists a type's own number fields, and no field of the system", async () => {
    const fields = await azure.numberFields(token, site(PROJECT_CUSTOM), "Story");
    expect(fields).toEqual({
      ok: true,
      value: [
        { id: STORY_POINTS, name: "Story Points" },
        { id: CUSTOM_POINTS, name: "Points" },
      ],
    });
    const task = await azure.numberFields(token, SITE.id, "Task");
    expect(task).toEqual({ ok: true, value: [{ id: REMAINING, name: "Remaining Work" }] });
  });

  it("needs a type, and a site that is an organisation and a project", async () => {
    expect((await azure.numberFields(token, SITE.id)).ok).toBe(false);
    for (const bad of ["fabrikam", "fabrikam/not-a-guid", `a.b/${PROJECT_AGILE}`, `a/b/c`]) {
      expect(await azure.numberFields(token, bad, "Bug"), bad).toEqual({
        ok: false,
        code: "connector_not_found",
      });
    }
    expect(fake.calls).toEqual([]);
  });

  it("guesses among the three by reference name, in order", () => {
    const field = (id: string) => ({ id, name: "whatever" });
    expect(azure.guessField([field(REMAINING), field(SIZE), field(EFFORT)])).toBe(EFFORT);
    expect(azure.guessField([field(STORY_POINTS), field(EFFORT)])).toBe(STORY_POINTS);
    expect(azure.guessField([field(REMAINING)])).toBeUndefined();
  });

  it("reads a type once, for a while, and for this token alone", async () => {
    fake.items = fakeWorkItems(2);
    await azure.fieldFor(token, ORG, "1", undefined);
    const after = fake.calls.length;
    expect(fake.calls.filter((call) => call.endsWith("/fields"))).toHaveLength(2);
    await azure.fieldFor(token, ORG, "2", undefined);
    expect(fake.calls.length).toBe(after + 1);
    await azure.fieldFor(new Secret(FAKE_READ_TOKEN), ORG, "2", undefined);
    expect(fake.calls.length).toBe(after + 4);
    now += FIELD_CACHE_MS;
    await azure.fieldFor(token, ORG, "1", undefined);
    expect(fake.calls.length).toBe(after + 7);
  });

  it("does not cache a failure", async () => {
    fake.items = fakeWorkItems(1);
    fake.fail = [{ match: "/fields", status: 503 }];
    expect((await azure.fieldFor(token, ORG, "1", undefined)).ok).toBe(false);
    expect((await azure.fieldFor(token, ORG, "1", undefined)).ok).toBe(true);
  });

  it("lists the project's types, without a disabled one", async () => {
    expect(await azure.workItemTypes(token, SITE.id)).toEqual({
      ok: true,
      value: ["User Story", "Bug", "Task"],
    });
    expect(await azure.workItemTypes(token, "fabrikam")).toEqual({
      ok: false,
      code: "connector_not_found",
    });
  });
});

describe("saved queries", () => {
  it("takes the queries of a tree: never a folder, and a deep folder by its id", async () => {
    const found = await azure.savedQueries(token, SITE.id);
    expect(found).toEqual({
      ok: true,
      value: {
        queries: [
          { id: QUERY_MINE, name: "My Queries/Mine" },
          { id: QUERY_SHARED, name: "Shared Queries/Team/Backlog" },
          { id: QUERY_TREE, name: "Shared Queries/Team/Stories and tasks" },
          { id: QUERY_DEEP, name: "Shared Queries/Team/Sprint/Deep" },
        ],
        more: false,
      },
    });
    expect(fake.queries[0]).toContain("$depth=2");
    expect(JSON.stringify(found)).not.toContain(QUERY_FOLDER);
  });

  it("says when folders were left unread, and never walks them all", async () => {
    const real = globalThis.fetch;
    let reads = 0;
    globalThis.fetch = async (input, init) => {
      if (!String(input).includes("/queries")) return real(input, init);
      reads += 1;
      const folder = (n: number) => ({
        id: `${String(n).padStart(8, "0")}-aaaa-4aaa-8aaa-000000000000`,
        name: "F",
        isFolder: true,
        hasChildren: true,
      });
      const body =
        reads === 1
          ? { value: Array.from({ length: 9 }, (_, n) => folder(n)) }
          : { ...folder(reads), children: [] };
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    try {
      const found = await azure.savedQueries(token, SITE.id);
      expect(found.ok && found.value.more).toBe(true);
      expect(reads).toBe(6);
    } finally {
      globalThis.fetch = real;
    }
  });

  it("refuses a folder it was sent as a query", async () => {
    expect(await azure.search(token, SITE, { saved: QUERY_FOLDER }, undefined)).toEqual({
      ok: false,
      code: "connector_bad_query",
    });
  });

  it("says a saved query is gone", async () => {
    expect(
      await azure.search(token, SITE, { saved: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }, undefined),
    ).toEqual({ ok: false, code: "connector_not_found" });
  });

  it("runs a flat one", async () => {
    fake.items = fakeWorkItems(3);
    fake.saved[QUERY_SHARED] = { ids: [3, 1] };
    const page = await azure.search(token, SITE, { saved: QUERY_SHARED }, undefined);
    expect(page.ok && page.value.items.map(({ id }) => id)).toEqual(["3", "1"]);
  });

  it("reads a tree's links, each item once", async () => {
    fake.items = fakeWorkItems(4);
    fake.saved[QUERY_TREE] = {
      tree: [
        [1, 2],
        [1, 3],
        [4, 3],
      ],
    };
    const page = await azure.search(token, SITE, { saved: QUERY_TREE }, undefined);
    expect(page.ok && page.value.items.map(({ id }) => id)).toEqual(["1", "4", "2", "3"]);
  });

  it("refuses an id that is no GUID at its schema", () => {
    expect(azure.query.safeParse({ saved: "../../_apis" }).success).toBe(false);
    expect(azure.query.safeParse({ wiql: "   " }).success).toBe(false);
    expect(azure.query.safeParse({ wiql: "x".repeat(4001) }).success).toBe(false);
    expect(azure.query.safeParse({ wiql: "x", saved: QUERY_MINE }).success).toBe(false);
    expect(azure.query.safeParse({ jql: "x" }).success).toBe(false);
  });
});

describe("a search", () => {
  const wiql = { wiql: "Select [System.Id] From WorkItems" };

  it("sends the query in a body, with the cap, in the project", async () => {
    fake.items = fakeWorkItems(2);
    await azure.search(token, SITE, wiql, undefined);
    expect(fake.calls[0]).toBe(`POST /${ORG}/${PROJECT_AGILE}/_apis/wit/wiql`);
    expect(fake.tops).toEqual([String(WIQL_CAP)]);
    expect(fake.queries[0]).not.toContain("Select");
    expect(fake.wiql).toEqual([wiql.wiql]);
  });

  it("reads items in batches of 200 and a link, with only their title", async () => {
    fake.items = fakeWorkItems(201);
    const first = await azure.search(token, SITE, wiql, undefined);
    if (!first.ok) throw new Error(first.code);
    expect(first.value.items).toHaveLength(WORK_ITEM_BATCH);
    expect(first.value.items[0]).toEqual({
      id: "1",
      key: "1",
      title: "Work item 1",
      url: `https://dev.azure.com/${ORG}/_workitems/edit/1`,
    });
    const second = await azure.search(token, SITE, wiql, first.value.next);
    if (!second.ok) throw new Error(second.code);
    expect(second.value.items.map(({ id }) => id)).toEqual(["201"]);
    expect(second.value.next).toBeUndefined();
    expect(fake.batches.map((ids) => ids.length)).toEqual([200, 1]);
    expect(fake.wiql).toHaveLength(1);
  });

  it("finds nothing without a batch", async () => {
    expect(await azure.search(token, SITE, wiql, undefined)).toEqual({
      ok: true,
      value: { items: [] },
    });
    expect(fake.batches).toEqual([]);
  });

  it("counts an item gone or hidden as unreadable", async () => {
    fake.items = fakeWorkItems(3);
    (fake.items[1] as { hidden?: boolean }).hidden = true;
    const page = await azure.search(token, SITE, wiql, undefined);
    expect(page.ok && page.value.items.map(({ id }) => id)).toEqual(["1", "3"]);
    expect(page.ok && page.value.unreadable).toBe(1);
  });

  it("keeps an item with no title", async () => {
    fake.items = fakeWorkItems(1);
    fake.fail = [
      {
        match: "/workitemsbatch",
        status: 200,
        text: JSON.stringify({ value: [{ id: 1, fields: {} }, { id: 2 }] }),
      },
    ];
    const page = await azure.search(token, SITE, wiql, undefined);
    expect(page.ok && page.value.items.map(({ title }) => title)).toEqual(["", ""]);
  });

  it("calls a query it could not run a bad query, and drops Microsoft's words", async () => {
    const answer = await azure.search(token, SITE, { wiql: "bad wiql SECRET" }, undefined);
    expect(answer).toEqual({ ok: false, code: "connector_bad_query" });
  });

  it("says when a query is past the cap", async () => {
    fake.fail = [{ match: "/wiql", status: 400, message: "VS402337: The number exceeds" }];
    expect(await azure.search(token, SITE, wiql, undefined)).toEqual({
      ok: false,
      code: "connector_query_cap",
    });
  });

  it("counts what it finds, and will not guess past the cap", async () => {
    fake.items = fakeWorkItems(7);
    expect(await azure.count(token, SITE.id, wiql)).toEqual({ ok: true, value: 7 });
    fake.items = fakeWorkItems(WIQL_CAP + 5);
    expect(await azure.count(token, SITE.id, wiql)).toEqual({
      ok: false,
      code: "connector_query_cap",
    });
    expect(await azure.count(token, "bad", wiql)).toEqual({
      ok: false,
      code: "connector_not_found",
    });
  });

  it("refuses a site that is no project, before a token goes anywhere", async () => {
    expect(await azure.search(token, { ...SITE, id: "evil" }, wiql, undefined)).toEqual({
      ok: false,
      code: "connector_not_found",
    });
    expect(fake.calls).toEqual([]);
  });
});

describe("writing an estimate", () => {
  beforeEach(() => {
    fake.items = fakeWorkItems(1);
  });

  it("sends one JSON Patch of one number, with its content type", async () => {
    expect(await azure.writeEstimate(token, ORG, "1", STORY_POINTS, 5)).toEqual({
      ok: true,
      value: undefined,
    });
    expect(fake.writes).toEqual([
      {
        organization: ORG,
        item: "1",
        contentType: "application/json-patch+json",
        token: FAKE_TOKEN,
        body: [{ op: "add", path: `/fields/${STORY_POINTS}`, value: 5 }],
      },
    ]);
  });

  it("can be done twice", async () => {
    await azure.writeEstimate(token, ORG, "1", STORY_POINTS, 5);
    expect((await azure.writeEstimate(token, ORG, "1", STORY_POINTS, 5)).ok).toBe(true);
  });

  it("refuses an id or a field that is not one, before a token goes anywhere", async () => {
    for (const [item, field] of [
      ["1/2", STORY_POINTS],
      ["x", STORY_POINTS],
      ["1", "Story Points"],
      ["1", "/fields/x"],
      ["1", "NoDot"],
      ["1", ""],
    ] as const) {
      expect(await azure.writeEstimate(token, ORG, item, field, 5)).toEqual({
        ok: false,
        code: "connector_not_found",
      });
    }
    expect(await azure.writeEstimate(token, "evil.example", "1", STORY_POINTS, 5)).toEqual({
      ok: false,
      code: "connector_not_found",
    });
    expect(fake.calls).toEqual([]);
  });

  it("tells a token that reads and may not write, and keeps it", async () => {
    expect(
      await azure.writeEstimate(new Secret(FAKE_READ_TOKEN), ORG, "1", STORY_POINTS, 5),
    ).toEqual({ ok: false, code: "connector_scope" });
    expect(fake.writes).toEqual([]);
  });

  it("calls a token that is dead on the write and on the read what it is", async () => {
    fake.fail = [
      { match: "/workitems/1", status: 401, text: "", contentType: "text/plain" },
      { match: "/fields/", status: 203, text: "<html>", contentType: "text/html" },
    ];
    expect(await azure.writeEstimate(token, ORG, "1", STORY_POINTS, 5)).toEqual({
      ok: false,
      code: "connector_reconnect",
    });
  });

  it.each([
    [203, "connector_reconnect"],
    [302, "connector_reconnect"],
    [400, "connector_field_refused"],
    [403, "connector_forbidden"],
    [404, "connector_not_found"],
    [500, "connector_unavailable"],
    [503, "connector_unavailable"],
  ] as const)("reads a %s", async (status, code) => {
    fake.fail = [{ match: "/workitems/1", status }];
    expect(await azure.writeEstimate(token, ORG, "1", STORY_POINTS, 5)).toEqual({
      ok: false,
      code,
    });
  });

  it("reads 429 with its wait, and ignores a date", async () => {
    fake.fail = [{ match: "/workitems/1", status: 429, retryAfter: "30" }];
    expect(await azure.writeEstimate(token, ORG, "1", STORY_POINTS, 5)).toEqual({
      ok: false,
      code: "connector_rate_limited",
      retryAfter: 30,
    });
    fake.fail = [
      { match: "/workitems/1", status: 429, retryAfter: "Wed, 21 Oct 2026 07:28:00 GMT" },
    ];
    expect(await azure.writeEstimate(token, ORG, "1", STORY_POINTS, 5)).toEqual({
      ok: false,
      code: "connector_rate_limited",
    });
  });

  it("reads a rule's refusal by Azure's number as the field's", async () => {
    fake.fail = [{ match: "/workitems/1", status: 400, message: "TF401320: Rule Error for field" }];
    expect(await azure.writeEstimate(token, ORG, "1", STORY_POINTS, 5)).toEqual({
      ok: false,
      code: "connector_field_refused",
    });
  });

  it("takes no answer but JSON for success", async () => {
    fake.fail = [{ match: "/workitems/1", status: 200, text: "<html>", contentType: "text/html" }];
    expect(await azure.writeEstimate(token, ORG, "1", STORY_POINTS, 5)).toEqual({
      ok: false,
      code: "connector_unavailable",
    });
  });

  it("reads a type's fields again after a field was refused", async () => {
    await azure.fieldFor(token, ORG, "1", undefined);
    fake.fail = [{ match: "/workitems/1", status: 400 }];
    await azure.writeEstimate(token, ORG, "1", STORY_POINTS, 5);
    const before = fake.calls.length;
    await azure.fieldFor(token, ORG, "1", undefined);
    expect(fake.calls.length).toBe(before + 3);
  });

  it("calls an estimate a field refuses a code too", async () => {
    expect(await azure.writeEstimate(token, ORG, "1", EFFORT, 5)).toEqual({
      ok: false,
      code: "connector_field_refused",
    });
  });
});

describe("what a call can fail with", () => {
  it("reads malformed JSON as an answer that is not Azure's", async () => {
    fake.fail = [{ match: "/_apis/projects", status: 200, text: "{ not json" }];
    expect(await azure.sites(token, ORG)).toEqual({ ok: false, code: "connector_unavailable" });
  });

  it("reads a shape it does not know the same way", async () => {
    fake.fail = [{ match: "/_apis/projects", status: 200, text: '{"value":[{"id":"x"}]}' }];
    expect(await azure.sites(token, ORG)).toEqual({ ok: false, code: "connector_unavailable" });
  });

  it("takes any 2xx but 200 for no answer", async () => {
    fake.fail = [{ match: "/_apis/projects", status: 201, text: "{}" }];
    expect(await azure.sites(token, ORG)).toEqual({ ok: false, code: "connector_unavailable" });
  });

  it("reads a refused socket as unavailable, and its words go nowhere", async () => {
    const real = globalThis.fetch;
    globalThis.fetch = () => Promise.reject(new TypeError("fetch failed: fabrikam"));
    try {
      expect(await azure.sites(token, ORG)).toEqual({ ok: false, code: "connector_unavailable" });
    } finally {
      globalThis.fetch = real;
    }
  });

  it("reads a call that hangs as a timeout", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    const real = globalThis.fetch;
    globalThis.fetch = () =>
      Promise.reject(Object.assign(new Error("gone"), { name: "TimeoutError" }));
    try {
      expect(await azure.sites(token, ORG)).toEqual({ ok: false, code: "connector_timeout" });
    } finally {
      globalThis.fetch = real;
      vi.useRealTimers();
    }
  });

  it("gives every call a timeout and follows no redirect", async () => {
    const seen: RequestInit[] = [];
    const real = globalThis.fetch;
    globalThis.fetch = (input, init) => {
      if (init) seen.push(init);
      return real(input, init);
    };
    try {
      await azure.checkToken(ORG, token);
      await azure.sites(token, ORG);
    } finally {
      globalThis.fetch = real;
    }
    expect(seen.length).toBeGreaterThan(1);
    for (const init of seen) {
      expect(init.redirect).toBe("manual");
      expect(init.signal).toBeInstanceOf(AbortSignal);
    }
  });

  it.each([
    [400, "connector_unavailable"],
    [401, "connector_reconnect"],
    [403, "connector_forbidden"],
    [404, "connector_not_found"],
    [500, "connector_unavailable"],
  ] as const)("reads a %s on a list", async (status, code) => {
    fake.fail = [{ match: "/_apis/projects", status }];
    expect(await azure.sites(token, ORG)).toEqual({ ok: false, code });
  });

  it("carries no words of Microsoft's, whatever it said", async () => {
    fake.fail = [
      { match: "/_apis/projects", status: 400, message: "TF400898: secret words of a query" },
    ];
    expect(JSON.stringify(await azure.sites(token, ORG))).not.toContain("secret");
  });
});
