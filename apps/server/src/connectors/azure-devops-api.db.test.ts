/**
 * The Azure DevOps connector (#55, ADR-031) against a real Postgres, real sign-ins, real sockets and
 * the stand-in in this process: a pasted token from the page's POST to the sealed row, the import,
 * the write-back, and what must never happen: another person's token used, a project or an
 * organisation that is not the person's, or a token, a query or an item's text in a log line or
 * in a frame for someone who should not read it.
 */
import { randomBytes } from "node:crypto";
import { createRoom, MAX_QUEUE_ITEMS, type RoomState } from "@pp/domain";
import type { ConnectionView, ConnectorImportView } from "@pp/protocol";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createAccountDeletionStore } from "../db/account-deletions.ts";
import type { AccountId } from "../db/connector-tokens.ts";
import { createTestDatabase, type TestDatabase, testClient } from "../db/test-db.ts";
import {
  CUSTOM_POINTS,
  EFFORT,
  FAKE_ORGANIZATION,
  FAKE_OTHER_ORGANIZATION,
  FAKE_READ_TOKEN,
  FAKE_SECOND_TOKEN,
  FAKE_STRANGER_TOKEN,
  FAKE_TOKEN,
  type FakeAzure,
  fakeWorkItems,
  PROJECT_AGILE,
  PROJECT_CUSTOM,
  PROJECT_SCRUM,
  QUERY_MINE,
  QUERY_SHARED,
  routeAzureTo,
  STORY_POINTS,
  startFakeAzure,
} from "../fake-azure-devops.ts";
import {
  atFake,
  FAKE_PERSON_PARAM,
  type FakeOidc,
  type FakePerson,
  fakePersonParam,
  routeProvidersTo,
  startFakeOidc,
} from "../fake-oidc.ts";
import { createServer, type PokerServer } from "../server.ts";
import { setupServer } from "../setup.ts";
import { roomCode, testClient as socketClient, type TestClient } from "../sync/test-support.ts";
import { collectLogs, testConfig, VALID_ENV } from "../test-support.ts";
import { Secret } from "../vault.ts";
import { CONNECTOR_CHANGE_LIMIT, CONNECTOR_IMPORT_LIMIT, CONNECTOR_WRITE_LIMIT } from "./routes.ts";

const ORIGIN = VALID_ENV.BASE_URL;
const ORG = FAKE_ORGANIZATION;
const KEYS = {
  GOOGLE_CLIENT_ID: "test-google-client-id",
  GOOGLE_CLIENT_SECRET: "test-google-secret-do-not-log",
  POKER_VAULT_KEY: randomBytes(32).toString("base64"),
  AZURE_DEVOPS_CONNECTOR: "on",
} as const;
const API = "/api/connectors/azure-devops";
const UNLIMITED = { perSecond: 1e6, burst: 1e6 };
const WIQL = "Select [System.Id] From WorkItems Where [System.Title] = 'SECRETWIQL'";
const PRIVATE_TITLE = "A very private work item";
const patch = (field: string, value: number) => [{ op: "add", path: `/fields/${field}`, value }];

const logs = collectLogs("trace");
const open: TestClient[] = [];
const codes: string[] = [];
const frames: string[] = [];
let t: TestDatabase;
let admin: ReturnType<typeof testClient>;
let oidc: FakeOidc;
let azure: FakeAzure;
let restoreProviders: () => void;
let restoreAzure: () => void;
let server: PokerServer;
let setup: Awaited<ReturnType<typeof setupServer>>;
let at: string;

const urlOf = (target: PokerServer) => {
  const bound = target.httpServer.address();
  if (!bound || typeof bound === "string") throw new Error("not listening");
  return `http://localhost:${bound.port}`;
};

beforeAll(async () => {
  oidc = await startFakeOidc();
  azure = await startFakeAzure();
  restoreProviders = routeProvidersTo(oidc.origin);
  restoreAzure = routeAzureTo(azure.origin);
  t = await createTestDatabase();
  admin = testClient(t.url);
  const config = testConfig({ DATABASE_URL: t.url, TRUST_PROXY: "1", ...KEYS });
  setup = await setupServer(config, logs.logger);
  server = createServer(config, {
    ...setup.deps,
    logger: logs.logger,
    // A person here sits in many rooms in a few milliseconds: these limits are other tests'.
    realtimeLimits: {
      messageLimit: UNLIMITED,
      rosterLimit: UNLIMITED,
      historyLimit: UNLIMITED,
      queueLimit: UNLIMITED,
    },
  });
  await server.listen();
  at = urlOf(server);
});

beforeEach(() => {
  azure.reset();
  azure.items = fakeWorkItems(3);
  azure.projects = azure.projects.slice(0, 1);
});

afterEach(() => {
  for (const client of open.splice(0)) {
    frames.push(...client.frames);
    client.close();
  }
});

afterAll(async () => {
  await server?.close();
  await setup?.database.close();
  await admin?.end();
  await t?.drop();
  await oidc?.close();
  await azure?.close();
  restoreAzure?.();
  restoreProviders?.();
  const everything = logs.raw.join("\n");
  const wire = frames.join("\n");
  expect(everything.length).toBeGreaterThan(1000);
  expect(wire.length).toBeGreaterThan(1000);
  for (const secret of [FAKE_TOKEN, FAKE_SECOND_TOKEN, FAKE_READ_TOKEN, FAKE_STRANGER_TOKEN]) {
    expect(everything).not.toContain(secret);
    expect(wire).not.toContain(secret);
    expect(everything).not.toContain(Buffer.from(`:${secret}`).toString("base64"));
  }
  for (const code of codes) expect(everything).not.toContain(code);
  expect(everything).not.toContain("SECRETWIQL");
  expect(wire).not.toContain("SECRETWIQL");
  expect(everything).not.toContain("Work item 1");
  expect(everything).not.toContain(PRIVATE_TITLE);
  expect(everything).not.toContain("dev.azure.com");
  expect(everything).not.toContain(STORY_POINTS);
});

class Browser {
  jar = new Map<string, string>();
  address = `10.3.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250) + 1}`;

  get cookie(): string {
    return [...this.jar].map(([name, value]) => `${name}=${value}`).join("; ");
  }

  async go(path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    if (this.jar.size > 0) headers.set("cookie", this.cookie);
    headers.set("x-forwarded-for", this.address);
    const response = await fetch(`${at}${path}`, { ...init, headers, redirect: "manual" });
    for (const line of response.headers.getSetCookie()) {
      const [pair = "", ...rest] = line.split(";");
      const name = pair.slice(0, pair.indexOf("="));
      const value = pair.slice(pair.indexOf("=") + 1);
      if (/max-age=0/i.test(rest.join(";")) || value === "") this.jar.delete(name);
      else this.jar.set(name, value);
    }
    return response;
  }

  send(method: string, path: string, body?: unknown): Promise<Response> {
    return this.go(path, {
      method,
      headers: { origin: ORIGIN, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }

  post(path: string, body: unknown = {}): Promise<Response> {
    return this.send("POST", path, body);
  }

  async id(): Promise<string> {
    const response = await this.go("/api/auth/get-session");
    const session = (await response.json()) as { user: { id: string } } | null;
    return session?.user.id ?? "";
  }

  async guest(): Promise<string> {
    expect((await this.post("/api/auth/sign-in/anonymous")).status).toBe(200);
    return this.id();
  }

  async signIn(who: FakePerson) {
    const started = await this.post("/api/auth/sign-in/social", {
      provider: "google",
      returnTo: "/",
    });
    expect(started.status).toBe(200);
    const { url } = (await started.json()) as { url: string };
    const answer = await fetch(
      `${atFake(url, oidc.origin)}&${FAKE_PERSON_PARAM}=${fakePersonParam(who)}`,
      { redirect: "manual" },
    );
    const back = new URL(answer.headers.get("location") ?? "");
    expect((await this.go(`${back.pathname}${back.search}`)).status).toBe(302);
    return this.id();
  }

  async sit(code: string, name: string): Promise<TestClient> {
    const client = socketClient(at, { cookie: this.cookie });
    open.push(client);
    await expect(client.enter(code)).resolves.toMatchObject({ ok: true });
    await must(client.cmd("join", { name, role: "voter" }));
    return client;
  }

  connect(organization: string = ORG, token: string = FAKE_TOKEN): Promise<Response> {
    return this.post(`${API}/connect`, { organization, token });
  }

  async status(): Promise<ConnectionView> {
    return (await (await this.go(API)).json()) as ConnectionView;
  }

  import(code: string, query: unknown): Promise<Response> {
    return this.post(`/api/rooms/${code}/connectors/azure-devops/import`, query);
  }

  writeBack(code: string, round: number): Promise<Response> {
    return this.post(`/api/rooms/${code}/connectors/azure-devops/write-back`, { round });
  }
}

/** A connection as an older row may hold it, with the organisation as it was typed. */
const STORED_IN_CASE = {
  organization: "Fabrikam",
  site: {
    id: `Fabrikam/${PROJECT_AGILE}`,
    name: "Fabrikam Fiber",
    url: "https://dev.azure.com/Fabrikam",
    home: "Fabrikam",
  },
};

/** Where an item's organisation is stored: as an older row may have it, in another case. */
const setSourceSite = async (code: string, round: number, site: string) => {
  const room = await loadedRoom(code);
  await admin.query(
    `update round_history set source = jsonb_set(source, '{site}', to_jsonb($1::text))
     where room_id = $2 and number = $3`,
    [site, room.id, round],
  );
};

const tokenRows = async (id: string) =>
  (await admin.query("select 1 from connector_token where user_id = $1", [id])).rowCount;

async function must(ack: Promise<{ ok: boolean }>) {
  await expect(ack).resolves.toMatchObject({ ok: true });
}

const codeOf = async (response: Response) => ((await response.json()) as { code: string }).code;

let people = 0;
const person = (): FakePerson => {
  people += 1;
  return {
    id: `azure-person-${people}`,
    email: `azure-person${people}@example.com`,
    name: `Person ${people}`,
    emailVerified: true,
  };
};

async function account(): Promise<{ browser: Browser; id: string }> {
  const browser = new Browser();
  return { browser, id: await browser.signIn(person()) };
}

async function roomOf(ownerId: string, change: (state: RoomState) => void = () => {}) {
  const code = roomCode();
  codes.push(code);
  const state = createRoom({ ownerId });
  change(state);
  const stored = await setup.database.store.insertRoom({ code, name: null, state });
  if (!stored) throw new Error("code taken");
  return stored;
}

/** A PO signed in, connected to one project, in their own room. */
async function connectedPo(token = FAKE_TOKEN) {
  const { browser, id } = await account();
  const { code } = await roomOf(id);
  expect((await browser.connect(ORG, token)).status).toBe(204);
  return { browser, id, code };
}

const loadedRoom = async (code: string) => {
  const room = await setup.database.store.loadRoom(code);
  if (!room) throw new Error("no room");
  return room;
};

/** Plays a queued item to a recorded final: the PO alone at the table, or with `others`. */
async function estimate(po: TestClient, id: number, card: string, others: TestClient[] = []) {
  const from = po.received.length;
  await must(po.cmd("startNext", { id }));
  const started = await po.waitFor((s) => s.room.round?.phase === "voting", 3000, from);
  const number = started.snapshot.room.round?.number ?? 0;
  for (const seat of [po, ...others]) {
    await must(seat.cmd("castVote", { card: "5", round: number, restart: 0 }));
  }
  await po.waitFor((s) => s.room.round?.number === number && s.room.round.phase === "revealed");
  await must(po.cmd("setFinal", { card }));
  return number;
}

/** Connected, seated, three items imported, the first estimated. */
async function estimated(card = "5") {
  const po = await connectedPo();
  const seat = await po.browser.sit(po.code, "Pia");
  expect((await po.browser.import(po.code, { wiql: WIQL })).status).toBe(200);
  const round = await estimate(seat, 1, card);
  return { ...po, seat, round };
}

describe("dark", () => {
  it("has no route and no tag without the operator's word, the vault or a way to sign in", async () => {
    const { AZURE_DEVOPS_CONNECTOR: on, ...keys } = KEYS;
    const envs: [Record<string, string>, readonly string[]][] = [
      [keys, []],
      [{ ...keys, AZURE_DEVOPS_CONNECTOR: "true" }, []],
      [{ ...keys, AZURE_DEVOPS_CONNECTOR: "ON" }, []],
      [
        { AZURE_DEVOPS_CONNECTOR: on, GOOGLE_CLIENT_ID: "g", GOOGLE_CLIENT_SECRET: "s" },
        ["POKER_VAULT_KEY"],
      ],
      [
        { AZURE_DEVOPS_CONNECTOR: on, POKER_VAULT_KEY: KEYS.POKER_VAULT_KEY },
        ["GOOGLE_CLIENT_ID", "MICROSOFT_CLIENT_ID"],
      ],
      [{}, []],
    ];
    for (const [env, missing] of envs) {
      const logged = logs.lines.length;
      const dark = await setupServer(testConfig({ DATABASE_URL: t.url, ...env }), logs.logger);
      // A word that does nothing says why at the start, by the variable's name and never a value.
      const said = logs.lines
        .slice(logged)
        .filter(({ msg }) => String(msg).includes("azure devops connector off"));
      expect(said.map((line) => line.missing)).toEqual(missing.length === 0 ? [] : [missing]);
      const other = createServer(testConfig({ DATABASE_URL: t.url, ...env }), {
        ...dark.deps,
        logger: logs.logger,
      });
      await other.listen();
      const calls = azure.calls.length;
      for (const [method, path] of [
        ["GET", API],
        ["POST", `${API}/connect`],
        ["GET", `${API}/sites`],
        ["GET", `${API}/queries`],
        ["GET", `${API}/types`],
      ] as const) {
        const answer = await fetch(`${urlOf(other)}${path}`, {
          method,
          headers: { origin: ORIGIN, "content-type": "application/json" },
          ...(method === "POST" ? { body: "{}" } : {}),
        });
        expect(answer.status, `${method} ${path}`).toBe(404);
      }
      expect(azure.calls).toHaveLength(calls);
      const page = await fetch(urlOf(other));
      expect(await page.text()).not.toContain("azure-devops");
      await other.close();
      await dark.database.close();
    }
  });

  it("registers no OAuth route and no boards for a pasted token", async () => {
    const { browser, code } = await connectedPo();
    expect((await browser.go(`${API}/callback?state=x`)).status).toBe(404);
    expect((await browser.go(`${API}/boards`)).status).toBe(404);
    expect((await browser.post(`/api/rooms/${code}/connectors/azure-devops/connect`)).status).toBe(
      404,
    );
  });
});

describe("connecting", () => {
  it("tests the token, seals it, and never gives it back", async () => {
    const { browser, id } = await account();
    const answer = await browser.connect();
    expect(answer.status).toBe(204);
    expect(await answer.text()).toBe("");
    const row = await admin.query<{ sealed_token: string; settings: unknown }>(
      "select sealed_token, settings from connector_token where user_id = $1",
      [id],
    );
    expect(row.rows).toHaveLength(1);
    expect(JSON.stringify(row.rows)).not.toContain(FAKE_TOKEN);
    expect(row.rows[0]?.sealed_token).toMatch(/^v1\./);
    const status = await browser.status();
    expect(status).toEqual({
      connected: true,
      organization: ORG,
      site: { id: `${ORG}/${PROJECT_AGILE}`, name: "Fabrikam Fiber" },
    });
    expect(azure.calls[0]).toBe(`GET /${ORG}/_apis/wit/fields/System.Title`);
  });

  it("asks for the project among several, from what the token reaches", async () => {
    azure.reset();
    const { browser } = await account();
    await browser.connect();
    expect(await browser.status()).toEqual({ connected: true, organization: ORG });
    const listed = (await (await browser.go(`${API}/sites`)).json()) as {
      sites: { id: string; name: string }[];
    };
    expect(listed.sites).toHaveLength(5);
    expect(JSON.stringify(listed)).not.toContain("https");
    const id = `${ORG}/${PROJECT_SCRUM}`;
    expect((await browser.send("PUT", `${API}/site`, { id })).status).toBe(204);
    expect(await browser.status()).toEqual({
      connected: true,
      organization: ORG,
      site: { id, name: "Scrum Team" },
    });
  });

  it("refuses a project of another organisation, and any id not on the list", async () => {
    azure.reset();
    const { browser } = await account();
    await browser.connect();
    for (const id of [
      `${FAKE_OTHER_ORGANIZATION}/${PROJECT_AGILE}`,
      `${ORG}/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa`,
      PROJECT_AGILE,
      ORG,
    ]) {
      const answer = await browser.send("PUT", `${API}/site`, { id });
      expect(await codeOf(answer), id).toBe("connector_bad_site");
    }
    expect((await browser.status()).site).toBeUndefined();
  });

  it("asks nothing of a tracker before a project is picked", async () => {
    azure.reset();
    const { browser, id } = await account();
    const { code } = await roomOf(id);
    await browser.connect();
    const calls = azure.calls.length;
    expect(await codeOf(await browser.import(code, { wiql: WIQL }))).toBe("connector_no_site");
    expect(await codeOf(await browser.go(`${API}/queries`))).toBe("connector_no_site");
    expect(await codeOf(await browser.go(`${API}/types`))).toBe("connector_no_site");
    expect(azure.calls).toHaveLength(calls);
  });

  it("keeps a project through connecting again to its organisation", async () => {
    const { browser } = await connectedPo();
    azure.tokens["second-token-for-this-test"] = {
      organizations: [ORG],
      scopes: ["vso.work_write"],
    };
    expect((await browser.connect(ORG, "second-token-for-this-test")).status).toBe(204);
    expect((await browser.status()).site?.id).toBe(`${ORG}/${PROJECT_AGILE}`);
    azure.items = fakeWorkItems(1);
  });

  it("forgets a project of the organisation it left", async () => {
    const { browser } = await connectedPo();
    azure.tokens["both-organisations"] = {
      organizations: [ORG, FAKE_OTHER_ORGANIZATION],
      scopes: ["vso.work_write"],
    };
    azure.projects = [...azure.projects, { id: PROJECT_SCRUM, name: "Two", process: "Scrum" }];
    await browser.connect(FAKE_OTHER_ORGANIZATION, "both-organisations");
    expect(await browser.status()).toEqual({
      connected: true,
      organization: FAKE_OTHER_ORGANIZATION,
    });
  });

  it("takes an organisation in any case, and stores it in one", async () => {
    const { browser } = await account();
    expect((await browser.connect("FabriKam")).status).toBe(204);
    const status = await browser.status();
    expect(status.organization).toBe(ORG);
    expect(status.site?.id).toBe(`${ORG}/${PROJECT_AGILE}`);
  });

  it("keeps a project and a field through connecting again in another case", async () => {
    azure.projects = [{ id: PROJECT_CUSTOM, name: "Own Way", process: "Custom" }];
    const { browser } = await connectedPo();
    const chosen = await browser.send("PUT", `${API}/field`, {
      id: CUSTOM_POINTS,
      type: "Story",
    });
    expect(chosen.status).toBe(204);
    expect((await browser.connect("FABRIKAM")).status).toBe(204);
    const status = await browser.status();
    expect(status.site?.id).toBe(`${ORG}/${PROJECT_CUSTOM}`);
    expect(status.field?.id).toBe(CUSTOM_POINTS);
  });

  it("keeps a row stored in another case when the same organisation connects again", async () => {
    const { browser, id } = await connectedPo();
    await setup.database.connectorTokens.writeSettings(
      id as AccountId,
      "azure-devops",
      STORED_IN_CASE,
    );
    expect((await browser.connect()).status).toBe(204);
    expect((await browser.status()).site?.id).toBe(`Fabrikam/${PROJECT_AGILE}`);
  });

  it.each([
    ["by a 401", { match: "/_apis/projects", status: 401 }],
    ["by a 403", { match: "/_apis/projects", status: 403 }],
    ["by a sign-in page", { match: "/_apis/projects", status: 203, text: "<html>" }],
  ])("refuses a token that cannot list projects %s, and saves nothing", async (_, failure) => {
    const { browser, id } = await account();
    azure.fail = [failure];
    const answer = await browser.connect();
    expect(answer.status).toBe(403);
    expect(await codeOf(answer)).toBe("connector_no_projects");
    expect(await tokenRows(id)).toBe(0);
    expect((await browser.status()).connected).toBe(false);
  });

  it("leaves a saved token alone when the next one cannot list projects", async () => {
    const { browser, code } = await connectedPo();
    await browser.sit(code, "Pia");
    azure.projectScope = "own";
    const answer = await browser.connect(ORG, FAKE_SECOND_TOKEN);
    expect(await codeOf(answer)).toBe("connector_no_projects");
    azure.projectScope = "inherited";
    await browser.import(code, { wiql: WIQL });
    expect(azure.wiqlTokens).toEqual([FAKE_TOKEN]);
  });

  it("saves nothing while the list of projects does not answer", async () => {
    const { browser, id } = await account();
    azure.fail = [{ match: "/_apis/projects", status: 500 }];
    const answer = await browser.connect();
    expect(answer.status).toBe(502);
    expect(await tokenRows(id)).toBe(0);
  });

  it.each([
    [
      "a bad token, as Azure DevOps was seen to",
      "no-such-token",
      ORG,
      "observed",
      "connector_bad_token",
      422,
    ],
    ["a bad token, by a sign-in page", "no-such-token", ORG, "203", "connector_bad_token", 422],
    ["a bad token, by a redirect", "no-such-token", ORG, "302", "connector_bad_token", 422],
    ["a bad token, by a 401", "no-such-token", ORG, "401", "connector_bad_token", 422],
    ["no access", FAKE_STRANGER_TOKEN, ORG, "203", "connector_no_access", 403],
    ["no such organisation", FAKE_TOKEN, "no-such-org", "203", "connector_no_organization", 404],
  ] as const)(
    "refuses %s, and saves nothing",
    async (_, token, organization, signIn, code, status) => {
      azure.signIn = signIn;
      const { browser, id } = await account();
      const answer = await browser.connect(organization, token);
      expect(answer.status).toBe(status);
      expect(await codeOf(answer)).toBe(code);
      expect(await tokenRows(id)).toBe(0);
      expect((await browser.status()).connected).toBe(false);
    },
  );

  it("refuses a token without the scope, by code", async () => {
    azure.tokens["no-work-items"] = { organizations: [ORG], scopes: ["vso.code"] };
    const { browser, id } = await account();
    const answer = await browser.connect(ORG, "no-work-items");
    expect(answer.status).toBe(403);
    expect(await codeOf(answer)).toBe("connector_scope");
    expect(await tokenRows(id)).toBe(0);
  });

  it.each(["evil.example", "fabrikam/x", "a@b", "https://dev.azure.com/fabrikam", "-x"])(
    "takes no organisation like %s, and nothing leaves",
    async (organization) => {
      const { browser, id } = await account();
      const calls = azure.calls.length;
      const answer = await browser.connect(organization);
      expect(answer.status).toBe(422);
      expect(await codeOf(answer)).toBe("connector_bad_organization");
      expect(azure.calls).toHaveLength(calls);
      expect(await tokenRows(id)).toBe(0);
    },
  );

  it("takes no token with a space or a line in it, and nothing leaves", async () => {
    const { browser } = await account();
    const calls = azure.calls.length;
    for (const token of ["two words", "line\nbreak", "é"]) {
      expect(await codeOf(await browser.connect(ORG, token))).toBe("connector_bad_token");
    }
    expect(azure.calls).toHaveLength(calls);
  });

  it("takes no body but its own", async () => {
    const { browser } = await account();
    const bad = await browser.post(`${API}/connect`, {
      organization: ORG,
      token: FAKE_TOKEN,
      url: "https://evil.example",
    });
    expect(bad.status).toBe(400);
    expect((await browser.post(`${API}/connect`, { organization: ORG })).status).toBe(400);
    const plain = await browser.go(`${API}/connect`, {
      method: "POST",
      headers: { origin: ORIGIN, "content-type": "text/plain" },
      body: JSON.stringify({ organization: ORG, token: FAKE_TOKEN }),
    });
    expect(plain.status).toBe(415);
  });

  it("is for an account: a guest and nobody at all cannot", async () => {
    const guest = new Browser();
    await guest.guest();
    const calls = azure.calls.length;
    const answer = await guest.connect();
    expect(answer.status).toBe(403);
    expect(await codeOf(answer)).toBe("connector_sign_in");
    expect((await new Browser().connect()).status).toBe(401);
    expect(azure.calls).toHaveLength(calls);
  });

  it("refuses another site's page", async () => {
    const { browser } = await account();
    const calls = azure.calls.length;
    const answer = await browser.go(`${API}/connect`, {
      method: "POST",
      headers: { origin: "https://evil.example", "content-type": "application/json" },
      body: JSON.stringify({ organization: ORG, token: FAKE_TOKEN }),
    });
    expect(answer.status).toBe(403);
    expect(azure.calls).toHaveLength(calls);
  });

  it("holds a person to the limit on changes", async () => {
    const { browser } = await account();
    for (let n = 0; n < CONNECTOR_CHANGE_LIMIT.max; n++) await browser.connect("-bad");
    expect((await browser.connect()).status).toBe(429);
  });

  it("answers no-store", async () => {
    const { browser } = await connectedPo();
    for (const path of [API, `${API}/sites`, `${API}/queries`, `${API}/types`]) {
      const answer = await browser.go(path);
      expect(answer.headers.get("cache-control"), path).toContain("no-store");
    }
    expect((await browser.connect()).headers.get("cache-control")).toContain("no-store");
  });
});

describe("a refused token", () => {
  const sealedRow = async (id: string) =>
    (await admin.query("select sealed_token from connector_token where user_id = $1", [id]))
      .rows[0] as unknown;
  const html = { text: "<html>", contentType: "text/html" };
  const plain = { text: "", contentType: "text/plain" };
  const away = { location: "https://spsprod.example.invalid/_signin" };

  it("stays, says so, and works on the next call, each way it can be refused", async () => {
    for (const signIn of ["observed", "203", "302", "401"] as const) {
      const { browser, id } = await connectedPo();
      azure.signIn = signIn;
      const scopes = azure.tokens[FAKE_TOKEN];
      delete azure.tokens[FAKE_TOKEN];
      const answer = await browser.go(`${API}/queries`);
      expect(answer.status).toBe(409);
      expect(await codeOf(answer)).toBe("connector_token_refused");
      expect(await tokenRows(id)).toBe(1);
      expect((await browser.status()).connected).toBe(true);
      if (scopes) azure.tokens[FAKE_TOKEN] = scopes;
      expect((await browser.go(`${API}/queries`)).status).toBe(200);
    }
  });

  it.each([
    ["a 203 on the saved queries", [{ match: "/queries", status: 203, ...html }], "queries"],
    ["a 302 on the saved queries", [{ match: "/queries", status: 302, ...away }], "queries"],
    [
      "a 302 on the item read inside a write-back",
      [{ match: "/_apis/wit/workitems/1", method: "GET", status: 302, ...away }],
      "write",
    ],
    [
      "a 401 on page 2 of an import",
      [{ match: "/workitemsbatch", status: 401, skip: 1, ...plain }],
      "import",
    ],
    [
      "a 401 on the PATCH and on the probe",
      [
        { match: "/_apis/wit/workitems/1", method: "PATCH", status: 401, ...plain },
        { match: "/_apis/wit/fields/System.Title", status: 401, ...plain },
      ],
      "write",
    ],
  ] as const)("%s, once: the row stays, and the same token goes on", async (_, failures, call) => {
    const po = await estimated();
    const before = await sealedRow(po.id);
    azure.items = fakeWorkItems(250);
    const asked = {
      queries: () => po.browser.go(`${API}/queries`),
      import: () => po.browser.import(po.code, { wiql: WIQL }),
      write: () => po.browser.writeBack(po.code, po.round),
    }[call];
    azure.fail = failures.map((failure) => ({ ...failure }));
    const answer = await asked();
    expect(answer.status).toBe(409);
    expect(await codeOf(answer)).toBe("connector_token_refused");
    expect(await tokenRows(po.id)).toBe(1);
    expect(await sealedRow(po.id)).toEqual(before);
    azure.fail = [];
    expect((await asked()).status).toBe(200);
    expect((await po.browser.status()).connected).toBe(true);
  });

  it("is replaced by a new paste, which keeps the project", async () => {
    const { browser, id, code } = await connectedPo();
    await browser.sit(code, "Pia");
    delete azure.tokens[FAKE_TOKEN];
    expect(await codeOf(await browser.go(`${API}/queries`))).toBe("connector_token_refused");
    expect((await browser.connect(ORG, FAKE_SECOND_TOKEN)).status).toBe(204);
    expect(await tokenRows(id)).toBe(1);
    expect((await browser.status()).site?.id).toBe(`${ORG}/${PROJECT_AGILE}`);
    await browser.import(code, { wiql: WIQL });
    expect(azure.wiqlTokens).toEqual([FAKE_SECOND_TOKEN]);
  });

  it("is deleted by a disconnect", async () => {
    const { browser, id } = await connectedPo();
    delete azure.tokens[FAKE_TOKEN];
    await browser.go(`${API}/queries`);
    expect((await browser.send("DELETE", API)).status).toBe(204);
    expect(await tokenRows(id)).toBe(0);
  });

  it("stays through a bad paste: a token that fails its check replaces nothing", async () => {
    const { browser, id } = await connectedPo();
    const before = await sealedRow(id);
    expect(await codeOf(await browser.connect(ORG, "no-such-token"))).toBe("connector_bad_token");
    expect(await sealedRow(id)).toEqual(before);
  });

  it("never reads as a fault of an app's scopes, however often it is refused", async () => {
    const { browser } = await connectedPo();
    delete azure.tokens[FAKE_TOKEN];
    for (let n = 0; n < 3; n++) {
      expect(await codeOf(await browser.go(`${API}/queries`))).toBe("connector_token_refused");
    }
  });
});

describe("a token's end", () => {
  it("keeps the row for what a token's end does not explain", async () => {
    const { browser, id } = await connectedPo();
    for (const [status, code] of [
      [403, "connector_forbidden"],
      [500, "connector_unavailable"],
      [429, "connector_rate_limited"],
    ] as const) {
      azure.fail = [{ match: "/queries", status }];
      expect(await codeOf(await browser.go(`${API}/queries`))).toBe(code);
      expect(await tokenRows(id)).toBe(1);
    }
  });

  it("carries a wait through to the page", async () => {
    const { browser } = await connectedPo();
    azure.fail = [{ match: "/queries", status: 429, retryAfter: "7" }];
    const answer = await browser.go(`${API}/queries`);
    expect(answer.status).toBe(429);
    expect(answer.headers.get("retry-after")).toBe("7");
    expect(await answer.json()).toEqual({ code: "connector_rate_limited", retryAfter: 7 });
  });

  it("disconnects: the row goes, and the token is no longer used", async () => {
    const { browser, id, code } = await connectedPo();
    expect((await browser.send("DELETE", API)).status).toBe(204);
    expect(await tokenRows(id)).toBe(0);
    const calls = azure.calls.length;
    expect(await codeOf(await browser.import(code, { wiql: WIQL }))).toBe(
      "connector_not_connected",
    );
    expect(azure.calls).toHaveLength(calls);
  });

  it("is gone with an account's deletion, and a connection cannot come back after it", async () => {
    const { browser, id } = await connectedPo();
    const deletions = createAccountDeletionStore(setup.database.db);
    await deletions.begin(id, {});
    expect(await tokenRows(id)).toBe(0);
    const again = await setup.database.connectorTokens.saveToken(
      id as AccountId,
      "azure-devops",
      new Secret(FAKE_TOKEN),
    );
    expect(again.status).not.toBe("saved");
    expect(await tokenRows(id)).toBe(0);
    await deletions.endSessions(id);
    expect((await browser.go(API)).status).toBe(401);
  });

  it("refuses a connection whose check was under way when the deletion began", async () => {
    const { browser, id } = await account();
    let reached = () => {};
    let release = () => {};
    const inFlight = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const real = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      if (String(input).includes("dev.azure.com")) {
        reached();
        await held;
      }
      return real(input, init);
    };
    try {
      const pressed = browser.connect();
      await inFlight;
      await createAccountDeletionStore(setup.database.db).begin(id, {});
      release();
      const answer = await pressed;
      expect(answer.status).toBe(409);
      expect(await codeOf(answer)).toBe("connector_not_connected");
      expect(await tokenRows(id)).toBe(0);
    } finally {
      globalThis.fetch = real;
    }
  });

  it("is named and nothing more in the export", async () => {
    const { browser } = await connectedPo();
    const file = (await (await browser.go("/api/account/export")).json()) as {
      connections: string[];
    };
    expect(file.connections).toEqual(["azure-devops"]);
    expect(JSON.stringify(file)).not.toContain(ORG);
    expect(JSON.stringify(file)).not.toContain(FAKE_TOKEN);
  });
});

describe("the field", () => {
  async function customProject() {
    azure.reset();
    azure.projects = azure.projects.filter(({ id }) => id === PROJECT_CUSTOM);
    return connectedPo();
  }

  it("lists a project's types, and a type's own number fields with the standard one", async () => {
    const { browser } = await customProject();
    expect(await (await browser.go(`${API}/types`)).json()).toEqual({ types: ["Story", "Note"] });
    const fields = await (await browser.go(`${API}/fields?type=Story`)).json();
    expect(fields).toEqual({
      fields: [
        { id: STORY_POINTS, name: "Story Points" },
        { id: CUSTOM_POINTS, name: "Points" },
      ],
      guess: STORY_POINTS,
    });
  });

  it("answers half a surrogate pair as no such type, not as a failure of its own", async () => {
    const { browser } = await connectedPo();
    const logged = logs.lines.length;
    const answer = await browser.send("PUT", `${API}/field`, { id: "A.B", type: "\ud800" });
    expect(answer.status).toBe(404);
    expect(await codeOf(answer)).toBe("connector_not_found");
    expect(logs.lines.slice(logged).filter(({ level }) => Number(level) >= 50)).toEqual([]);
  });

  it("needs a type to list fields", async () => {
    const { browser } = await connectedPo();
    expect((await browser.go(`${API}/fields`)).status).toBe(400);
  });

  it("takes a person's choice from that type alone, and goes back", async () => {
    const { browser } = await customProject();
    const put = (id: string, type = "Story") => browser.send("PUT", `${API}/field`, { id, type });
    expect(await codeOf(await put("System.Title"))).toBe("connector_bad_field");
    expect(await codeOf(await put(EFFORT))).toBe("connector_bad_field");
    expect((await browser.send("PUT", `${API}/field`, { id: CUSTOM_POINTS })).status).toBe(400);
    expect((await put(CUSTOM_POINTS)).status).toBe(204);
    expect((await browser.status()).field).toEqual({ id: CUSTOM_POINTS, name: "Points" });
    expect((await browser.send("DELETE", `${API}/field`)).status).toBe(204);
    expect((await browser.status()).field).toBeUndefined();
  });

  it("writes a person's choice where the type carries it", async () => {
    const { browser, code } = await customProject();
    azure.items = fakeWorkItems(1, "Story").map((item) => ({ ...item, project: PROJECT_CUSTOM }));
    expect(
      (await browser.send("PUT", `${API}/field`, { id: CUSTOM_POINTS, type: "Story" })).status,
    ).toBe(204);
    const seat = await browser.sit(code, "Pia");
    await browser.import(code, { wiql: WIQL });
    const round = await estimate(seat, 1, "8");
    expect((await browser.writeBack(code, round)).status).toBe(200);
    expect(azure.writes.at(-1)?.body).toEqual(patch(CUSTOM_POINTS, 8));
  });
});

describe("import", () => {
  it("fills the queue by WIQL with id, title and link, through apply", async () => {
    const { browser, code } = await connectedPo();
    await browser.sit(code, "Pia");
    const answer = await browser.import(code, { wiql: WIQL });
    expect(answer.status).toBe(200);
    expect(await answer.json()).toEqual({
      added: 3,
      duplicates: 0,
      shortened: 0,
      leftOut: 0,
      beyond: 0,
    } satisfies ConnectorImportView);
    const items = (await loadedRoom(code)).state.queue?.items ?? [];
    expect(items[0]).toMatchObject({
      key: "1",
      title: "Work item 1",
      url: `https://dev.azure.com/${ORG}/_workitems/edit/1`,
      source: { system: "ado", site: ORG, id: "1" },
    });
  });

  it("imports a saved query, flat", async () => {
    const { browser, code } = await connectedPo();
    await browser.sit(code, "Pia");
    azure.saved[QUERY_SHARED] = { ids: [2] };
    const answer = await browser.import(code, { saved: QUERY_SHARED });
    expect(((await answer.json()) as ConnectorImportView).added).toBe(1);
  });

  it("offers a project's saved queries and never a folder", async () => {
    const { browser } = await connectedPo();
    const found = (await (await browser.go(`${API}/queries`)).json()) as {
      queries: { id: string; name: string }[];
      more: boolean;
    };
    expect(found.queries.map(({ id }) => id)).toContain(QUERY_MINE);
    expect(found.queries.some(({ name }) => name === "My Queries")).toBe(false);
    expect(found.more).toBe(false);
  });

  it("takes no other tracker's query, and an empty one does not leave", async () => {
    const { browser, code } = await connectedPo();
    const calls = azure.calls.length;
    for (const query of [
      { jql: "x" },
      { sprint: 1 },
      { wiql: "  " },
      { saved: "not-a-guid" },
      {},
    ]) {
      expect((await browser.import(code, query)).status).toBe(400);
    }
    expect(azure.calls).toHaveLength(calls);
  });

  it("is the PO's, signed in: a voter's own connection does nothing here", async () => {
    const { code } = await connectedPo();
    const voter = await connectedPo(FAKE_SECOND_TOKEN);
    const before = azure.calls.length;
    const answer = await voter.browser.import(code, { wiql: WIQL });
    expect(answer.status).toBe(403);
    expect(azure.calls).toHaveLength(before);
    expect((await loadedRoom(code)).state.queue?.items ?? []).toEqual([]);
  });

  it("a guest PO has no way in", async () => {
    const guest = new Browser();
    const id = await guest.guest();
    const { code } = await roomOf(id);
    const calls = azure.calls.length;
    expect(await codeOf(await guest.import(code, { wiql: WIQL }))).toBe("connector_sign_in");
    expect(azure.calls).toHaveLength(calls);
  });

  it("a PO with no connection reaches nothing, though a voter has one", async () => {
    const { browser, id } = await account();
    const { code } = await roomOf(id);
    const voter = await connectedPo();
    await voter.browser.sit(code, "Ana");
    const calls = azure.calls.length;
    expect(await codeOf(await browser.import(code, { wiql: WIQL }))).toBe(
      "connector_not_connected",
    );
    expect(azure.calls).toHaveLength(calls);
  });

  it("answers a room that does not exist as such", async () => {
    const { browser } = await connectedPo();
    expect((await browser.import("nosuchroomcode", { wiql: WIQL })).status).toBe(404);
  });

  it("stops at what the queue takes, and says how many lay past it", async () => {
    const { browser, code } = await connectedPo();
    await browser.sit(code, "Pia");
    azure.items = fakeWorkItems(MAX_QUEUE_ITEMS + 150);
    const answer = (await (
      await browser.import(code, { wiql: WIQL })
    ).json()) as ConnectorImportView;
    expect(answer.added).toBe(MAX_QUEUE_ITEMS);
    expect(answer.leftOut).toBe(100);
    expect(answer.beyond).toBe(50);
    expect(azure.batches.every((ids) => ids.length <= 200)).toBe(true);
    expect(azure.batches).toHaveLength(3);
    expect((await loadedRoom(code)).state.queue?.items).toHaveLength(MAX_QUEUE_ITEMS);
  });

  it("says more lie past the limit when the query is at WIQL's own cap", async () => {
    const { browser, code } = await connectedPo();
    await browser.sit(code, "Pia");
    azure.items = fakeWorkItems(20_001);
    const answer = (await (
      await browser.import(code, { wiql: WIQL })
    ).json()) as ConnectorImportView;
    expect(answer.added).toBe(MAX_QUEUE_ITEMS);
    expect(answer.beyond).toBeNull();
  });

  it("counts items gone or hidden as left out", async () => {
    const { browser, code } = await connectedPo();
    await browser.sit(code, "Pia");
    azure.items = fakeWorkItems(3).map((item) =>
      item.id === 2 ? { ...item, hidden: true } : item,
    );
    const answer = (await (
      await browser.import(code, { wiql: WIQL })
    ).json()) as ConnectorImportView;
    expect(answer).toMatchObject({ added: 2, leftOut: 1 });
  });

  it("keeps a title as text, however it looks", async () => {
    const { browser, code } = await connectedPo();
    await browser.sit(code, "Pia");
    azure.items = [{ id: 1, title: "<img src=x onerror=alert(1)>", type: "User Story" }];
    await browser.import(code, { wiql: WIQL });
    expect((await loadedRoom(code)).state.queue?.items[0]?.title).toBe(
      "<img src=x onerror=alert(1)>",
    );
  });

  it("adds nothing when a batch fails in the middle", async () => {
    const { browser, code } = await connectedPo();
    azure.items = fakeWorkItems(250);
    azure.fail = [];
    const real = azure.fail;
    const first = browser.import(code, { wiql: "bad wiql SECRETWIQL" });
    expect(await codeOf(await first)).toBe("connector_bad_query");
    real.push({ match: "/workitemsbatch", status: 500, times: 1 });
    const answer = await browser.import(code, { wiql: WIQL });
    expect(answer.status).toBe(502);
    expect((await loadedRoom(code)).state.queue?.items ?? []).toEqual([]);
  });

  it("has its own limit, per person", async () => {
    const { browser, code } = await connectedPo();
    for (let n = 0; n < CONNECTOR_IMPORT_LIMIT.max; n++) await browser.import(code, { wiql: WIQL });
    expect((await browser.import(code, { wiql: WIQL })).status).toBe(429);
  });
});

describe("write-back", () => {
  it("writes the final, read from the round, to the field the type carries", async () => {
    const { browser, code, round } = await estimated("8");
    const answer = await browser.writeBack(code, round);
    expect(answer.status).toBe(200);
    expect(await answer.json()).toEqual({ key: "1", value: 8 });
    expect(azure.writes).toEqual([
      {
        organization: ORG,
        item: "1",
        contentType: "application/json-patch+json",
        token: FAKE_TOKEN,
        body: patch(STORY_POINTS, 8),
      },
    ]);
  });

  it("can write twice, and from a past round", async () => {
    const { browser, code, round, seat } = await estimated("3");
    await estimate(seat, 2, "5");
    expect((await browser.writeBack(code, round)).status).toBe(200);
    expect((await browser.writeBack(code, round)).status).toBe(200);
    expect(azure.writes.map(({ item }) => item)).toEqual(["1", "1"]);
  });

  it("sends an anonymous round's final and not one thing more", async () => {
    const { browser, code } = await connectedPo();
    const po = await browser.sit(code, "Pia");
    const other = await account();
    const ana = await other.browser.sit(code, "Ana");
    await must(po.cmd("updateSettings", { patch: { revealNames: false } }));
    await browser.import(code, { wiql: WIQL });
    const round = await estimate(po, 1, "13", [ana]);
    expect((await loadedRoom(code)).state.round?.anonymous).toBe(true);
    await browser.writeBack(code, round);
    expect(azure.writes).toHaveLength(1);
    expect(azure.writes[0]?.body).toEqual(patch(STORY_POINTS, 13));
    expect(JSON.stringify(azure.writes)).not.toMatch(/Pia|Ana|votes/);
  });

  it("does not write a final that is no number, and says so", async () => {
    const { browser, code } = await connectedPo();
    const po = await browser.sit(code, "Pia");
    await must(po.cmd("updateSettings", { patch: { deck: { kind: "preset", id: "tshirt" } } }));
    await browser.import(code, { wiql: WIQL });
    await must(po.cmd("startNext", { id: 1 }));
    await must(po.cmd("castVote", { card: "M", round: 1, restart: 0 }));
    await must(po.cmd("setFinal", { card: "M" }));
    const answer = await browser.writeBack(code, 1);
    expect(answer.status).toBe(422);
    expect(await codeOf(answer)).toBe("connector_not_numeric");
    expect(azure.writes).toEqual([]);
  });

  it("says an item has no estimate field, and the round goes on", async () => {
    const po = await connectedPo();
    azure.items = fakeWorkItems(2, "Task");
    const seat = await po.browser.sit(po.code, "Pia");
    await po.browser.import(po.code, { wiql: WIQL });
    const round = await estimate(seat, 1, "5");
    const answer = await po.browser.writeBack(po.code, round);
    expect(answer.status).toBe(422);
    expect(await codeOf(answer)).toBe("connector_no_estimate_field");
    expect(azure.writes).toEqual([]);
    await must(seat.cmd("startNext", { id: 2 }));
  });

  it("refuses a PO connected to another organisation, and calls nothing", async () => {
    const { browser, code, round } = await estimated();
    azure.tokens["other-org"] = {
      organizations: [FAKE_OTHER_ORGANIZATION],
      scopes: ["vso.work_write"],
    };
    await browser.connect(FAKE_OTHER_ORGANIZATION, "other-org");
    const calls = azure.calls.length;
    const answer = await browser.writeBack(code, round);
    expect(answer.status).toBe(409);
    expect(await codeOf(answer)).toBe("connector_other_site");
    expect(azure.calls).toHaveLength(calls);
  });

  it("needs a project picked", async () => {
    const { browser, code, round } = await estimated();
    azure.projects = [...azure.projects, { id: PROJECT_SCRUM, name: "Two", process: "Scrum" }];
    azure.tokens["other-org"] = {
      organizations: [FAKE_OTHER_ORGANIZATION],
      scopes: ["vso.work_write"],
    };
    await browser.connect(FAKE_OTHER_ORGANIZATION, "other-org");
    expect(await codeOf(await browser.writeBack(code, round))).toBe("connector_no_site");
  });

  it("writes from another project of the same organisation: an item's id holds across it", async () => {
    const { browser, code, round } = await estimated();
    azure.projects = [...azure.projects, { id: PROJECT_SCRUM, name: "Two", process: "Scrum" }];
    await browser.send("PUT", `${API}/site`, { id: `${ORG}/${PROJECT_SCRUM}` });
    expect((await browser.writeBack(code, round)).status).toBe(200);
  });

  it("writes an item stored in another case of the organisation's name", async () => {
    const { browser, code, round } = await estimated();
    await setSourceSite(code, round, "FABRIKAM");
    expect((await browser.writeBack(code, round)).status).toBe(200);
    expect(azure.writes).toHaveLength(1);
  });

  it("writes for a connection stored in another case of the organisation's name", async () => {
    const { browser, id, code, round } = await estimated();
    await setup.database.connectorTokens.writeSettings(
      id as AccountId,
      "azure-devops",
      STORED_IN_CASE,
    );
    expect((await browser.writeBack(code, round)).status).toBe(200);
  });

  it("refuses a round that is Jira's, and calls nothing", async () => {
    const { browser, code, round } = await estimated();
    const room = await loadedRoom(code);
    await admin.query(
      `update round_history set source = jsonb_set(source, '{system}', '"jira"')
       where room_id = $1 and number = $2`,
      [room.id, round],
    );
    const calls = azure.calls.length;
    expect(await codeOf(await browser.writeBack(code, round))).toBe("connector_no_source");
    expect(azure.calls).toHaveLength(calls);
  });

  it("refuses a round with no final, and one from no tracker", async () => {
    const { browser, code, seat } = await estimated();
    expect(await codeOf(await browser.writeBack(code, 99))).toBe("connector_no_final");
    const from = seat.received.length;
    await must(seat.cmd("startRound", { subject: { kind: "none" } }));
    const started = await seat.waitFor((s) => s.room.round?.phase === "voting", 3000, from);
    const number = started.snapshot.room.round?.number ?? 0;
    await must(seat.cmd("castVote", { card: "5", round: number, restart: 0 }));
    await seat.waitFor((s) => s.room.round?.phase === "revealed");
    await must(seat.cmd("setFinal", { card: "5" }));
    expect(await codeOf(await browser.writeBack(code, number))).toBe("connector_no_source");
    expect(azure.writes).toEqual([]);
  });

  it("uses the PO's token, never the keeper's for a PO who claimed the role", async () => {
    const keeper = await connectedPo();
    const claimed = await account();
    expect((await claimed.browser.connect(ORG, FAKE_SECOND_TOKEN)).status).toBe(204);
    const { code } = await roomOf(claimed.id, (state) => {
      state.keeperId = keeper.id;
    });
    const seat = await claimed.browser.sit(code, "Claimer");
    await claimed.browser.import(code, { wiql: WIQL });
    expect(azure.wiqlTokens).toEqual([FAKE_SECOND_TOKEN]);
    const round = await estimate(seat, 1, "5");
    expect((await claimed.browser.writeBack(code, round)).status).toBe(200);
    expect(azure.writes.at(-1)?.token).toBe(FAKE_SECOND_TOKEN);
    expect((await keeper.browser.writeBack(code, round)).status).toBe(403);
    expect(azure.writes).toHaveLength(1);
  });

  it("a voter's press writes nothing, with whatever token they hold", async () => {
    const { browser, code } = await connectedPo();
    const po = await browser.sit(code, "Pia");
    const voter = await connectedPo(FAKE_SECOND_TOKEN);
    const ana = await voter.browser.sit(code, "Ana");
    await browser.import(code, { wiql: WIQL });
    const round = await estimate(po, 1, "5", [ana]);
    expect((await voter.browser.writeBack(code, round)).status).toBe(403);
    expect(azure.writes).toEqual([]);
  });

  it("a new PO after a hand-over writes with their own token, or not at all", async () => {
    const { browser, id, code } = await connectedPo();
    const po = await browser.sit(code, "Pia");
    const heir = await connectedPo(FAKE_SECOND_TOKEN);
    const ana = await heir.browser.sit(code, "Ana");
    await browser.import(code, { wiql: WIQL });
    const round = await estimate(po, 1, "5", [ana]);
    await must(po.cmd("transferOwner", { to: heir.id }));
    expect((await browser.writeBack(code, round)).status).toBe(403);
    expect((await heir.browser.writeBack(code, round)).status).toBe(200);
    expect(azure.writes.at(-1)?.token).toBe(FAKE_SECOND_TOKEN);
    expect(id).not.toBe(heir.id);
  });

  it("a token that reads and may not write says so at its first write, and stays", async () => {
    const po = await connectedPo(FAKE_READ_TOKEN);
    const seat = await po.browser.sit(po.code, "Pia");
    await po.browser.import(po.code, { wiql: WIQL });
    const round = await estimate(seat, 1, "5");
    const answer = await po.browser.writeBack(po.code, round);
    expect(answer.status).toBe(403);
    expect(await codeOf(answer)).toBe("connector_scope");
    expect(await tokenRows(po.id)).toBe(1);
  });

  it("a token refused during the round costs the round nothing, and stays", async () => {
    const { browser, id, code, round, seat } = await estimated();
    delete azure.tokens[FAKE_TOKEN];
    const answer = await browser.writeBack(code, round);
    expect(await codeOf(answer)).toBe("connector_token_refused");
    expect(await tokenRows(id)).toBe(1);
    await must(seat.cmd("startNext", { id: 2 }));
    azure.tokens[FAKE_TOKEN] = { organizations: [ORG], scopes: ["vso.work_write"] };
    expect((await browser.writeBack(code, round)).status).toBe(200);
  });

  it.each([
    [429, "connector_rate_limited"],
    [400, "connector_field_refused"],
    [403, "connector_forbidden"],
    [404, "connector_not_found"],
    [500, "connector_unavailable"],
  ] as const)(
    "a %s fails the write and not the round, and can be retried",
    async (status, code) => {
      const po = await estimated();
      azure.fail = [{ match: "/_apis/wit/workitems/1", method: "PATCH", status }];
      const first = await po.browser.writeBack(po.code, po.round);
      expect(await codeOf(first)).toBe(code);
      azure.fail = [];
      expect((await po.browser.writeBack(po.code, po.round)).status).toBe(200);
      await must(po.seat.cmd("startNext", { id: 2 }));
    },
  );

  it("has its own limit, per person", async () => {
    const { browser, code } = await connectedPo();
    for (let n = 0; n < CONNECTOR_WRITE_LIMIT.max; n++) await browser.writeBack(code, 1);
    expect((await browser.writeBack(code, 1)).status).toBe(429);
  });
});

describe("what other people see", () => {
  it("shows a voter nothing the queue does not already share, and the tracker to no one but the PO", async () => {
    const { browser, code } = await connectedPo();
    azure.items = [{ id: 1, title: PRIVATE_TITLE, type: "User Story" }];
    const po = await browser.sit(code, "Pia");
    const other = await account();
    const ana = await other.browser.sit(code, "Ana");
    await browser.import(code, { wiql: WIQL });
    await estimate(po, 1, "5", [ana]);
    await browser.writeBack(code, 1);
    await po.waitFor((s) => s.room.round?.system === "ado");
    const seen = ana.frames.join("\n");
    expect(seen).not.toContain(FAKE_TOKEN);
    expect(seen).not.toContain("SECRETWIQL");
    expect(seen).not.toContain('"system"');
    expect(seen).not.toContain(STORY_POINTS);
    expect(seen).not.toContain('"source"');
    expect(po.frames.join("\n")).not.toContain('"source"');
  });

  it("gives the page names and numbers, and never the token", async () => {
    const { browser, code } = await connectedPo();
    for (const path of [API, `${API}/sites`, `${API}/queries`, `${API}/types`]) {
      expect(await (await browser.go(path)).text(), path).not.toContain(FAKE_TOKEN);
    }
    const answer = await browser.import(code, { wiql: WIQL });
    expect(await answer.text()).not.toContain(FAKE_TOKEN);
  });
});
