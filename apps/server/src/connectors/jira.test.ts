/**
 * The Jira client without a database: the failures that need no room around them, and the
 * rules on addresses. `fetch` is replaced here, as the app's only way out.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Secret } from "../vault.ts";
import {
  CALL_TIMEOUT_MS,
  createJiraConnector,
  failureOf,
  JIRA_SCOPES,
  jqlOf,
  retryAfterOf,
} from "./jira.ts";

const CLOUD = "11111111-1111-4111-8111-111111111111";
const SITE = { id: CLOUD, name: "Acme", url: "https://acme.atlassian.net/" };
const TOKEN = new Secret("the-access-token");
const jira = createJiraConnector({ clientId: "id", clientSecret: "secret" }, () => 1000);

let calls: { url: string; init: RequestInit }[];
let answer: () => Promise<Response>;

beforeEach(() => {
  calls = [];
  answer = async () => Response.json({});
  vi.stubGlobal("fetch", (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return answer();
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const json = (body: unknown, status = 200) => Response.json(body, { status });

describe("addresses", () => {
  it("sends every call to api.atlassian.com with a timeout, and follows no redirect", async () => {
    answer = async () => json({ issues: [] });
    await jira.search(TOKEN, SITE, { jql: "project = X" }, undefined);
    const call = calls[0];
    expect(call?.url).toBe(`https://api.atlassian.com/ex/jira/${CLOUD}/rest/api/3/search/jql`);
    expect(call?.init.redirect).toBe("error");
    expect(call?.init.signal).toBeInstanceOf(AbortSignal);
    expect(CALL_TIMEOUT_MS).toBe(10_000);
  });

  it("keeps a query out of every URL", async () => {
    answer = async () => json({ issues: [], count: 3 });
    await jira.search(TOKEN, SITE, { jql: "project = SECRET" }, undefined);
    await jira.count(TOKEN, CLOUD, { jql: "project = SECRET" });
    for (const { url } of calls) expect(url).not.toContain("SECRET");
  });

  it("refuses a site that is no cloud id before a token goes anywhere", async () => {
    const bad = ["evil.example/x", "../../other", `${CLOUD}/../x`, ""];
    for (const site of bad) {
      await expect(jira.numberFields(TOKEN, site)).resolves.toEqual({
        ok: false,
        code: "connector_not_found",
      });
      await expect(jira.boards(TOKEN, site, undefined)).resolves.toMatchObject({ ok: false });
      await expect(jira.sprints(TOKEN, site, 1)).resolves.toMatchObject({ ok: false });
      await expect(
        jira.search(TOKEN, { ...SITE, id: site }, { sprint: 1 }, undefined),
      ).resolves.toMatchObject({ ok: false });
      await expect(jira.count(TOKEN, site, { sprint: 1 })).resolves.toMatchObject({ ok: false });
      await expect(jira.writeEstimate(TOKEN, site, "1", "customfield_1", 5)).resolves.toMatchObject(
        { ok: false },
      );
    }
    expect(calls).toEqual([]);
  });

  it("refuses an item or a field that is not one", async () => {
    for (const [item, field] of [
      ["10001/../../evil", "customfield_1"],
      ["ABC-1", "customfield_1"],
      ["10001", "summary"],
      ["10001", "__proto__"],
    ] as const) {
      await expect(jira.writeEstimate(TOKEN, CLOUD, item, field, 5)).resolves.toEqual({
        ok: false,
        code: "connector_not_found",
      });
    }
    expect(calls).toEqual([]);
  });

  it("asks for the issue's summary and nothing else of it", async () => {
    answer = async () => json({ issues: [] });
    await jira.search(TOKEN, SITE, { sprint: 7 }, undefined);
    const body = JSON.parse(String(calls[0]?.init.body));
    expect(body.fields).toEqual(["summary"]);
    expect(body.maxResults).toBe(100);
    expect(body).not.toHaveProperty("nextPageToken");
    await jira.search(TOKEN, SITE, { sprint: 7 }, "next-page");
    expect(JSON.parse(String(calls[1]?.init.body)).nextPageToken).toBe("next-page");
  });

  it("writes one number to one field, and nothing else", async () => {
    answer = async () => new Response(null, { status: 204 });
    await expect(jira.writeEstimate(TOKEN, CLOUD, "10001", "customfield_16", 5.5)).resolves.toEqual(
      { ok: true, value: undefined },
    );
    const { url, init } = calls[0] ?? { url: "", init: {} };
    expect(url).toBe(`https://api.atlassian.com/ex/jira/${CLOUD}/rest/api/3/issue/10001`);
    expect(init.method).toBe("PUT");
    expect(JSON.parse(String(init.body))).toEqual({ fields: { customfield_16: 5.5 } });
  });

  it("builds an item's link on the site's own address, without its trailing slash", async () => {
    answer = async () =>
      json({ issues: [{ id: "1", key: "ABC-1", fields: { summary: "S" } }], nextPageToken: "2" });
    await expect(jira.search(TOKEN, SITE, { sprint: 1 }, undefined)).resolves.toEqual({
      ok: true,
      value: {
        items: [
          { id: "1", key: "ABC-1", title: "S", url: "https://acme.atlassian.net/browse/ABC-1" },
        ],
        next: "2",
      },
    });
  });
});

describe("a sprint's query", () => {
  it("leaves sub-tasks out and takes the board's order", () => {
    expect(jqlOf({ sprint: 12 })).toBe(
      "sprint = 12 AND issuetype not in subtaskIssueTypes() ORDER BY rank ASC",
    );
    expect(jqlOf({ jql: "project = X" })).toBe("project = X");
  });
});

describe("scopes", () => {
  it("are read and write of issues, what the boards need, and staying connected", () => {
    expect(JIRA_SCOPES).toContain("offline_access");
    expect(JIRA_SCOPES.filter((scope) => scope.startsWith("write:"))).toEqual(["write:jira-work"]);
    expect(JIRA_SCOPES.some((scope) => scope.startsWith("manage:"))).toBe(false);
  });
});

describe("what a failure says", () => {
  it("reads Retry-After in seconds, and nothing else", () => {
    expect(retryAfterOf("120")).toBe(120);
    expect(retryAfterOf(" 5 ")).toBe(5);
    expect(retryAfterOf("Wed, 21 Oct 2026 07:28:00 GMT")).toBeUndefined();
    expect(retryAfterOf(null)).toBeUndefined();
  });

  it.each([
    [401, "connector_reconnect"],
    [403, "connector_forbidden"],
    [404, "connector_not_found"],
    [400, "connector_bad_query"],
    [409, "connector_unavailable"],
    [500, "connector_unavailable"],
    [503, "connector_unavailable"],
  ])("%i is %s", (status, code) => {
    expect(failureOf(new Response(null, { status }), "connector_bad_query")).toEqual({
      ok: false,
      code,
    });
  });

  it("carries a 429's wait when it has one", () => {
    const limited = new Response(null, { status: 429, headers: { "retry-after": "30" } });
    expect(failureOf(limited, "connector_bad_query")).toEqual({
      ok: false,
      code: "connector_rate_limited",
      retryAfter: 30,
    });
    expect(failureOf(new Response(null, { status: 429 }), "connector_bad_query")).toEqual({
      ok: false,
      code: "connector_rate_limited",
    });
  });

  it("is connector_timeout when the signal ends the call, and keeps none of its words", async () => {
    answer = () =>
      Promise.reject(new DOMException("api.atlassian.com/x?jql=SECRET", "TimeoutError"));
    await expect(jira.sites(TOKEN)).resolves.toEqual({ ok: false, code: "connector_timeout" });
    answer = () => Promise.reject(new DOMException("gone", "AbortError"));
    await expect(jira.sites(TOKEN)).resolves.toEqual({ ok: false, code: "connector_timeout" });
  });

  it("is connector_timeout when a body stalls past the signal", async () => {
    const stalled = () =>
      new Response(
        new ReadableStream({
          start: (body) => body.error(new DOMException("api.atlassian.com/x", "TimeoutError")),
        }),
      );
    answer = async () => stalled();
    await expect(jira.sites(TOKEN)).resolves.toEqual({ ok: false, code: "connector_timeout" });
    await expect(jira.refresh(new Secret("old"))).resolves.toEqual({
      ok: false,
      code: "connector_timeout",
    });
  });

  it("is connector_unavailable for a network failure or an answer that is not Jira's", async () => {
    answer = () => Promise.reject(new TypeError("fetch failed"));
    await expect(jira.sites(TOKEN)).resolves.toEqual({ ok: false, code: "connector_unavailable" });
    answer = () => Promise.reject("nothing");
    await expect(jira.sites(TOKEN)).resolves.toEqual({ ok: false, code: "connector_unavailable" });
    answer = async () => new Response("<html>a proxy</html>");
    await expect(jira.sites(TOKEN)).resolves.toEqual({ ok: false, code: "connector_unavailable" });
    answer = async () => json([{ id: "not-a-cloud-id", name: "x", url: "https://x" }]);
    await expect(jira.sites(TOKEN)).resolves.toEqual({ ok: false, code: "connector_unavailable" });
    answer = async () => json([{ id: CLOUD, name: "x", url: "http://plain.example" }]);
    await expect(jira.sites(TOKEN)).resolves.toEqual({ ok: false, code: "connector_unavailable" });
  });

  it("passes a network failure through a write, a board, a sprint and a count", async () => {
    answer = () => Promise.reject(new TypeError("fetch failed"));
    const down = { ok: false, code: "connector_unavailable" };
    await expect(jira.writeEstimate(TOKEN, CLOUD, "1", "customfield_1", 1)).resolves.toEqual(down);
    await expect(jira.boards(TOKEN, CLOUD, "x")).resolves.toEqual(down);
    await expect(jira.sprints(TOKEN, CLOUD, 1)).resolves.toEqual(down);
    await expect(jira.count(TOKEN, CLOUD, { sprint: 1 })).resolves.toEqual(down);
    await expect(jira.numberFields(TOKEN, CLOUD)).resolves.toEqual(down);
    await expect(jira.search(TOKEN, SITE, { sprint: 1 }, undefined)).resolves.toEqual(down);
  });
});

describe("the grant", () => {
  const grant = { access_token: "a", refresh_token: "r", expires_in: 3600 };

  it("turns the answer into sealed strings and an end on this clock", async () => {
    answer = async () => json(grant);
    const result = await jira.exchangeCode("code", "https://x/cb");
    if (!result.ok) throw new Error("refused");
    expect(result.value.accessToken).toBeInstanceOf(Secret);
    expect(result.value.refreshToken.reveal()).toBe("r");
    expect(result.value.expiresAt).toBe(1000 + 3_600_000);
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
      grant_type: "authorization_code",
      client_id: "id",
      client_secret: "secret",
      code: "code",
      redirect_uri: "https://x/cb",
    });
  });

  it("refreshes with the refresh token, and reads invalid_grant whatever the status", async () => {
    answer = async () => json(grant);
    await jira.refresh(new Secret("old"));
    expect(JSON.parse(String(calls[0]?.init.body))).toMatchObject({
      grant_type: "refresh_token",
      refresh_token: "old",
    });
    for (const status of [400, 403]) {
      answer = async () => json({ error: "invalid_grant" }, status);
      await expect(jira.refresh(new Secret("old"))).resolves.toEqual({
        ok: false,
        code: "connector_reconnect",
      });
    }
  });

  it("believes unauthorized_client as well: people report it for a dead refresh token", async () => {
    answer = async () =>
      json({ error: "unauthorized_client", error_description: "refresh_token is invalid" }, 403);
    await expect(jira.refresh(new Secret("old"))).resolves.toEqual({
      ok: false,
      code: "connector_reconnect",
    });
  });

  it("reads a 429 of the token address as a wait, whatever its body says", async () => {
    answer = async () =>
      Response.json({ error: "invalid_grant" }, { status: 429, headers: { "retry-after": "20" } });
    await expect(jira.refresh(new Secret("old"))).resolves.toEqual({
      ok: false,
      code: "connector_rate_limited",
      retryAfter: 20,
    });
  });

  it("does not take a failure of the token address for a dead grant", async () => {
    for (const [body, status] of [
      [{ error: "server_error" }, 500],
      [{ error: "access_denied" }, 401],
      ["nothing readable", 403],
    ] as const) {
      answer = async () => json(body, status);
      await expect(jira.refresh(new Secret("old"))).resolves.toEqual({
        ok: false,
        code: "connector_unavailable",
      });
    }
    answer = async () => new Response("not json", { status: 502 });
    await expect(jira.refresh(new Secret("old"))).resolves.toMatchObject({ ok: false });
    answer = async () => json({ access_token: "a" });
    await expect(jira.refresh(new Secret("old"))).resolves.toEqual({
      ok: false,
      code: "connector_unavailable",
    });
    answer = async () => new Response("not json");
    await expect(jira.refresh(new Secret("old"))).resolves.toMatchObject({ ok: false });
    answer = () => Promise.reject(new TypeError("fetch failed"));
    await expect(jira.refresh(new Secret("old"))).resolves.toMatchObject({ ok: false });
  });
});

describe("the guess", () => {
  const guess = (...names: string[]) =>
    jira.guessField(names.map((name, n) => ({ id: `customfield_${n}`, name })));

  it("takes the plain name first, then the next-gen one, then anything like it", () => {
    expect(guess("Team size", "Story point estimate", "Story Points")).toBe("customfield_2");
    expect(guess("Team size", "Story point estimate")).toBe("customfield_1");
    expect(guess("Team size", "Team Story Points")).toBe("customfield_1");
    expect(guess("Original estimate")).toBe("customfield_0");
    expect(guess("Team size")).toBeUndefined();
    expect(guess()).toBeUndefined();
  });
});

describe("sites", () => {
  const site = (scopes?: string[]) => ({
    id: CLOUD,
    name: "Acme",
    url: "https://acme.atlassian.net",
    ...(scopes ? { scopes } : {}),
  });
  const ACME = { id: CLOUD, name: "Acme", url: "https://acme.atlassian.net" };

  it("lists a site once, with nothing but its name and address", async () => {
    answer = async () => json([site(["read:jira-work"]), site(["read:sprint:jira-software"])]);
    await expect(jira.sites(TOKEN)).resolves.toEqual({ ok: true, value: [ACME] });
    answer = async () => json([site()]);
    await expect(jira.sites(TOKEN)).resolves.toEqual({ ok: true, value: [ACME] });
  });

  it("leaves out what this app has no Jira scope on", async () => {
    answer = async () => json([site(["read:confluence-content.all"])]);
    await expect(jira.sites(TOKEN)).resolves.toEqual({ ok: true, value: [] });
  });
});

describe("sprints", () => {
  it("takes a 400 for a board with no sprints, and nothing else for that", async () => {
    answer = async () => json({ errorMessages: ["The board does not support sprints"] }, 400);
    await expect(jira.sprints(TOKEN, CLOUD, 4)).resolves.toEqual({ ok: true, value: [] });
    for (const [status, code] of [
      [401, "connector_reconnect"],
      [403, "connector_forbidden"],
      [404, "connector_not_found"],
      [500, "connector_unavailable"],
    ] as const) {
      answer = async () => json({}, status);
      await expect(jira.sprints(TOKEN, CLOUD, 4)).resolves.toEqual({ ok: false, code });
    }
  });

  it("lists what can still be estimated, from the active and future ones", async () => {
    answer = async () =>
      json({
        values: [
          { id: 1, name: "Now", state: "active" },
          { id: 2, name: "Next", state: "future" },
          { id: 3, name: "Gone", state: "closed" },
        ],
      });
    await expect(jira.sprints(TOKEN, CLOUD, 4)).resolves.toEqual({
      ok: true,
      value: [
        { id: 1, name: "Now", state: "active" },
        { id: 2, name: "Next", state: "future" },
      ],
    });
    expect(calls[0]?.url).toContain("/rest/agile/1.0/board/4/sprint?state=active%2Cfuture");
  });
});
