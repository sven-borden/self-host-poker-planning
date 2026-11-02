/**
 * The Jira connector (#54, ADR-030) against a real Postgres, real sign-ins, real sockets and the
 * stand-in for Atlassian in this process: the whole dance, the import, the write-back, every
 * class of failure, and what must never happen: another person's token used, a site that is not
 * the person's own, a `state` that is replayed, stolen or tied to a room, or a token, a query or
 * an issue's text in a log line or in a frame for someone who should not read it.
 */
import { randomBytes } from "node:crypto";
import { createRoom, MAX_QUEUE_ITEMS, type RoomState } from "@pp/domain";
import type { ConnectionView, ConnectorImportView } from "@pp/protocol";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type AccountId, accountOf } from "../db/connector-tokens.ts";
import { createTestDatabase, type TestDatabase, testClient } from "../db/test-db.ts";
import {
  atFakeJira,
  FAKE_CLOUD,
  FAKE_CLOUD_TWO,
  FAKE_JIRA_CLIENT,
  type FakeJira,
  fakeIssues,
  routeAtlassianTo,
  startFakeJira,
} from "../fake-jira.ts";
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
import { createConnectorAccess } from "./access.ts";
import { createJiraConnector, JIRA_SCOPES } from "./jira.ts";
import { createOAuthStateStore, STATE_TTL_MS } from "./oauth-state.ts";
import { CONNECTOR_IMPORT_LIMIT, CONNECTOR_WRITE_LIMIT } from "./routes.ts";

const ORIGIN = VALID_ENV.BASE_URL;
const KEYS = {
  GOOGLE_CLIENT_ID: "test-google-client-id",
  GOOGLE_CLIENT_SECRET: "test-google-secret-do-not-log",
  JIRA_CLIENT_ID: FAKE_JIRA_CLIENT.clientId,
  JIRA_CLIENT_SECRET: FAKE_JIRA_CLIENT.clientSecret,
  POKER_VAULT_KEY: randomBytes(32).toString("base64"),
} as const;
const ACME = { id: FAKE_CLOUD, name: "Acme", url: "https://acme.atlassian.net" };
const GLOBEX = { id: FAKE_CLOUD_TWO, name: "Globex", url: "https://globex.atlassian.net" };
const STORY_POINTS = "customfield_10016";

const logs = collectLogs("trace");
const open: TestClient[] = [];
const codes: string[] = [];
const frames: string[] = [];
const secretTexts = ["project = SECRETPROJECT", "A very private ticket"];
let t: TestDatabase;
let admin: ReturnType<typeof testClient>;
let oidc: FakeOidc;
let jira: FakeJira;
let restoreProviders: () => void;
let restoreJira: () => void;
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
  jira = await startFakeJira();
  restoreProviders = routeProvidersTo(oidc.origin);
  restoreJira = routeAtlassianTo(jira.origin);
  t = await createTestDatabase();
  admin = testClient(t.url);
  const config = testConfig({ DATABASE_URL: t.url, TRUST_PROXY: "1", ...KEYS });
  setup = await setupServer(config, logs.logger);
  server = createServer(config, { ...setup.deps, logger: logs.logger });
  await server.listen();
  at = urlOf(server);
});

beforeEach(() => {
  jira.sites = [ACME];
  jira.issues = fakeIssues(3);
  jira.fail = [];
  delete jira.approximate;
  jira.expiresIn = 3600;
  jira.strictRotation = false;
  jira.beforeRefresh = async () => {};
  delete jira.pageFailure;
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
  await jira?.close();
  restoreJira?.();
  restoreProviders?.();
  const everything = logs.raw.join("\n");
  const wire = frames.join("\n");
  const tokens = jira.issued.flatMap(({ access, refresh }) => [access, refresh]);
  expect(tokens.length).toBeGreaterThan(10);
  for (const secret of [...tokens, ...jira.codes, FAKE_JIRA_CLIENT.clientSecret]) {
    expect(everything).not.toContain(secret);
    expect(wire).not.toContain(secret);
  }
  for (const code of codes) expect(everything).not.toContain(code);
  for (const text of secretTexts) expect(everything).not.toContain(text);
  expect(everything).not.toContain("Ticket 1");
  expect(wire).not.toContain(FAKE_CLOUD);
});

let addresses = 0;

class Browser {
  readonly jar = new Map<string, string>();
  readonly address = `198.51.${Math.floor(addresses / 250)}.${(addresses++ % 250) + 1}`;

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

  send(method: string, path: string, body: unknown): Promise<Response> {
    return this.go(path, {
      method,
      headers: { origin: ORIGIN, "content-type": "application/json" },
      body: JSON.stringify(body),
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

  /** The start of a connection: the address the page sends the browser to. */
  async startConnect(code: string): Promise<URL> {
    const started = await this.post(`/api/rooms/${code}/connectors/jira/connect`);
    expect(started.status).toBe(200);
    return new URL(((await started.json()) as { url: string }).url);
  }

  /** The browser at the tracker, and back: the callback's answer. */
  async finishConnect(url: URL, { denied = false } = {}): Promise<Response> {
    const answer = await fetch(
      `${atFakeJira(url.toString(), jira.origin)}${denied ? "&fake_denied=1" : ""}`,
      { redirect: "manual" },
    );
    const back = new URL(answer.headers.get("location") ?? "");
    return this.go(`${back.pathname}${back.search}`);
  }

  async connect(code: string): Promise<Response> {
    return this.finishConnect(await this.startConnect(code));
  }

  async status(): Promise<ConnectionView> {
    return (await (await this.go("/api/connectors/jira")).json()) as ConnectionView;
  }

  import(code: string, query: unknown): Promise<Response> {
    return this.post(`/api/rooms/${code}/connectors/jira/import`, query);
  }

  writeBack(code: string, round: number): Promise<Response> {
    return this.post(`/api/rooms/${code}/connectors/jira/write-back`, { round });
  }

  setField(id = STORY_POINTS): Promise<Response> {
    return this.send("PUT", "/api/connectors/jira/field", { id });
  }
}

async function must(ack: Promise<{ ok: boolean }>) {
  await expect(ack).resolves.toMatchObject({ ok: true });
}

const codeOf = async (response: Response) => ((await response.json()) as { code: string }).code;

let people = 0;
const person = (): FakePerson => {
  people += 1;
  return {
    id: `jira-person-${people}`,
    email: `jira-person${people}@example.com`,
    name: `Person ${people}`,
    emailVerified: true,
  };
};

/** Someone signed in. */
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

/** A PO signed in, connected to one site, with the estimate's field chosen, in their own room. */
async function connectedPo() {
  const { browser, id } = await account();
  const { code } = await roomOf(id);
  expect((await browser.connect(code)).status).toBe(302);
  expect((await browser.setField()).status).toBe(204);
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
  const round = started.snapshot.room.round;
  const number = round?.number ?? 0;
  for (const seat of [po, ...others]) {
    await must(seat.cmd("castVote", { card: "5", round: number, restart: 0 }));
  }
  await po.waitFor((s) => s.room.round?.number === number && s.room.round.phase === "revealed");
  await must(po.cmd("setFinal", { card }));
  return number;
}

describe("the dance", () => {
  it("connects: minimum scopes, the app's address, no room code, the room back", async () => {
    const { browser, id } = await account();
    const { code } = await roomOf(id);
    const url = await browser.startConnect(code);
    expect(url.origin + url.pathname).toBe("https://auth.atlassian.com/authorize");
    expect(url.searchParams.get("audience")).toBe("api.atlassian.com");
    expect(url.searchParams.get("client_id")).toBe(FAKE_JIRA_CLIENT.clientId);
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("prompt")).toBe("consent");
    expect(url.searchParams.get("redirect_uri")).toBe(`${ORIGIN}/api/connectors/jira/callback`);
    expect(url.searchParams.get("scope")?.split(" ")).toEqual([...JIRA_SCOPES]);
    expect(url.searchParams.get("state")).toMatch(/^[\w-]{43}$/);
    expect(url.toString()).not.toContain(code);
    expect(url.searchParams.get("state")).not.toContain(code);

    const back = await browser.finishConnect(url);
    expect(back.status).toBe(302);
    expect(back.headers.get("location")).toBe(`/r/${code}?connector=connected`);
    expect(back.headers.get("cache-control")).toBe("no-store");
    expect(await browser.status()).toEqual({
      connected: true,
      site: { id: FAKE_CLOUD, name: "Acme" },
    });
  });

  it("stores the token sealed, and no page ever gets it", async () => {
    const { browser, id, code } = await connectedPo();
    const { rows } = await admin.query("select * from connector_token where user_id = $1", [id]);
    const row = JSON.stringify(rows[0]);
    const issued = jira.issued.at(-1);
    expect(row).not.toContain(issued?.access);
    expect(row).not.toContain(issued?.refresh);
    expect(rows[0].settings.site.id).toBe(FAKE_CLOUD);
    const status = await (await browser.go("/api/connectors/jira")).text();
    expect(status).not.toContain("fake-");
    expect(status).not.toContain("sealed");
    expect(code).toHaveLength(10);
  });

  it("comes back to the room whatever the request says about where to go", async () => {
    const { browser, id } = await account();
    const { code } = await roomOf(id);
    const url = await browser.startConnect(code);
    const answer = await fetch(atFakeJira(url.toString(), jira.origin), { redirect: "manual" });
    const back = new URL(answer.headers.get("location") ?? "");
    back.searchParams.set("return_to", "https://evil.example/");
    back.searchParams.set("next", "//evil.example");
    const done = await browser.go(`${back.pathname}${back.search}`);
    expect(done.headers.get("location")).toBe(`/r/${code}?connector=connected`);
  });

  it("says when the person went back at the tracker", async () => {
    const { browser, id } = await account();
    const { code } = await roomOf(id);
    const back = await browser.finishConnect(await browser.startConnect(code), { denied: true });
    expect(back.headers.get("location")).toBe(`/r/${code}?connector=cancelled`);
    expect((await browser.status()).connected).toBe(false);
    expect(logs.raw.join("\n")).not.toContain("not for a log");
  });

  it("refuses a state used twice", async () => {
    const { browser, id } = await account();
    const { code } = await roomOf(id);
    const url = await browser.startConnect(code);
    const answer = await fetch(atFakeJira(url.toString(), jira.origin), { redirect: "manual" });
    const back = new URL(answer.headers.get("location") ?? "");
    const path = `${back.pathname}${back.search}`;
    expect((await browser.go(path)).headers.get("location")).toContain("connector=connected");
    const exchanges = jira.tokenRequests.length;
    const again = await browser.go(path);
    expect(again.headers.get("location")).toBe("/?connector=failed");
    expect(jira.tokenRequests).toHaveLength(exchanges);
  });

  it("refuses a state issued to another session, and spends it", async () => {
    const mine = await account();
    const theirs = await account();
    const { code } = await roomOf(mine.id);
    const url = await mine.browser.startConnect(code);
    const answer = await fetch(atFakeJira(url.toString(), jira.origin), { redirect: "manual" });
    const back = new URL(answer.headers.get("location") ?? "");
    const path = `${back.pathname}${back.search}`;
    const exchanges = jira.tokenRequests.length;
    const stolen = await theirs.browser.go(path);
    expect(stolen.headers.get("location")).toBe("/?connector=failed");
    expect((await theirs.browser.status()).connected).toBe(false);
    expect((await mine.browser.status()).connected).toBe(false);
    expect((await mine.browser.go(path)).headers.get("location")).toBe("/?connector=failed");
    expect(jira.tokenRequests).toHaveLength(exchanges);
  });

  it("refuses a state nobody issued, a callback with no state and one with no session", async () => {
    const { browser } = await account();
    const exchanges = jira.tokenRequests.length;
    const forged = `/api/connectors/jira/callback?code=abc&state=${"a".repeat(43)}`;
    expect((await browser.go(forged)).headers.get("location")).toBe("/?connector=failed");
    const none = "/api/connectors/jira/callback?code=abc";
    expect((await browser.go(none)).headers.get("location")).toBe("/?connector=failed");
    expect((await new Browser().go(forged)).headers.get("location")).toBe("/?connector=failed");
    expect(jira.tokenRequests).toHaveLength(exchanges);
  });

  it("keeps a state for ten minutes, and hashes alone in the row", async () => {
    const start = Date.now();
    let now = start;
    const states = createOAuthStateStore(setup.database.db, () => now);
    const late = await states.issue("session-a", "room-id");
    const onTime = await states.issue("session-a", "room-id");
    now = start + STATE_TTL_MS - 1000;
    await expect(states.take(onTime, "session-a")).resolves.toEqual({ room: "room-id" });
    now = start + STATE_TTL_MS + 1000;
    await expect(states.take(late, "session-a")).resolves.toBeNull();
    const fresh = await states.issue("session-a", null);
    const { rows } = await admin.query("select identifier, value from verification");
    expect(JSON.stringify(rows)).not.toContain(fresh);
    expect(JSON.stringify(rows)).not.toContain("session-a");
    await expect(states.take("not the shape", "session-a")).resolves.toBeNull();
  });

  it("says failed when the code does not turn into a token, and stores nothing", async () => {
    const { browser, id } = await account();
    const { code } = await roomOf(id);
    jira.fail = [{ match: "/oauth/token", status: 500 }];
    const back = await browser.connect(code);
    expect(back.headers.get("location")).toBe(`/r/${code}?connector=failed`);
    expect((await browser.status()).connected).toBe(false);
  });

  it("is for an account and the room's PO: a guest and a voter cannot start one", async () => {
    const { id } = await account();
    const { code } = await roomOf(id);
    const guest = new Browser();
    await guest.guest();
    const asGuest = await guest.post(`/api/rooms/${code}/connectors/jira/connect`);
    expect(asGuest.status).toBe(403);
    expect(await codeOf(asGuest)).toBe("connector_sign_in");
    const other = await account();
    const asOther = await other.browser.post(`/api/rooms/${code}/connectors/jira/connect`);
    expect(asOther.status).toBe(403);
    expect(await codeOf(asOther)).toBe("not_allowed");
    const nobody = await new Browser().post(`/api/rooms/${code}/connectors/jira/connect`);
    expect(nobody.status).toBe(401);
  });

  it("refuses another site's page and a body that is not JSON", async () => {
    const { browser, id } = await account();
    const { code } = await roomOf(id);
    const foreign = await browser.go(`/api/rooms/${code}/connectors/jira/connect`, {
      method: "POST",
      headers: { origin: "https://evil.example", "content-type": "application/json" },
      body: "{}",
    });
    expect(foreign.status).toBe(403);
    const form = await browser.go(`/api/rooms/${code}/connectors/jira/connect`, {
      method: "POST",
      headers: { origin: ORIGIN, "content-type": "application/x-www-form-urlencoded" },
      body: "a=1",
    });
    expect(form.status).toBe(415);
  });

  it("does not list another person's room by the state of a room that is gone", async () => {
    const { browser, id } = await account();
    const { code } = await roomOf(id);
    const url = await browser.startConnect(code);
    await admin.query("delete from room where code = $1", [code]);
    expect((await browser.finishConnect(url)).headers.get("location")).toBe(
      "/?connector=connected",
    );
  });
});

describe("sites", () => {
  it("lets the person pick among several, from their own list only", async () => {
    jira.sites = [ACME, GLOBEX];
    const { browser, id } = await account();
    const { code } = await roomOf(id);
    await browser.connect(code);
    expect(await browser.status()).toEqual({ connected: true });
    const listed = await (await browser.go("/api/connectors/jira/sites")).json();
    expect(listed).toEqual({
      sites: [
        { id: FAKE_CLOUD, name: "Acme" },
        { id: FAKE_CLOUD_TWO, name: "Globex" },
      ],
    });
    const import_ = await browser.import(code, { jql: "project = X" });
    expect(await codeOf(import_)).toBe("connector_no_site");

    const made_up = await browser.send("PUT", "/api/connectors/jira/site", {
      id: "33333333-3333-4333-8333-333333333333",
    });
    expect(made_up.status).toBe(403);
    expect(await codeOf(made_up)).toBe("connector_bad_site");

    expect(
      (await browser.send("PUT", "/api/connectors/jira/site", { id: FAKE_CLOUD_TWO })).status,
    ).toBe(204);
    expect((await browser.status()).site?.name).toBe("Globex");
  });

  it("refuses a real site of someone else's", async () => {
    jira.sites = [GLOBEX];
    const { browser, id } = await account();
    const { code } = await roomOf(id);
    await browser.connect(code);
    const answer = await browser.send("PUT", "/api/connectors/jira/site", { id: FAKE_CLOUD });
    expect(await codeOf(answer)).toBe("connector_bad_site");
    expect((await browser.status()).site?.name).toBe("Globex");
  });

  it("forgets the field when the site changes, keeps it when the site stays", async () => {
    jira.sites = [ACME, GLOBEX];
    const { browser, id } = await account();
    const { code } = await roomOf(id);
    await browser.connect(code);
    await browser.send("PUT", "/api/connectors/jira/site", { id: FAKE_CLOUD });
    await browser.setField();
    await browser.send("PUT", "/api/connectors/jira/site", { id: FAKE_CLOUD });
    expect((await browser.status()).field?.id).toBe(STORY_POINTS);
    await browser.send("PUT", "/api/connectors/jira/site", { id: FAKE_CLOUD_TWO });
    expect(await browser.status()).not.toHaveProperty("field");
  });

  it("keeps site and field through connecting again, while the site is still theirs", async () => {
    jira.sites = [ACME, GLOBEX];
    const { browser, id } = await account();
    const { code } = await roomOf(id);
    await browser.connect(code);
    await browser.send("PUT", "/api/connectors/jira/site", { id: FAKE_CLOUD });
    await browser.setField();
    await browser.connect(code);
    expect((await browser.status()).field?.id).toBe(STORY_POINTS);
    jira.sites = [GLOBEX];
    await browser.connect(code);
    expect(await browser.status()).toEqual({
      connected: true,
      site: { id: FAKE_CLOUD_TWO, name: "Globex" },
    });
  });
});

describe("fields", () => {
  it("offers the site's own number fields with a guess, and takes only those", async () => {
    const { browser, id } = await account();
    const { code } = await roomOf(id);
    await browser.connect(code);
    const listed = await (await browser.go("/api/connectors/jira/fields")).json();
    expect(listed).toEqual({
      fields: [
        { id: "customfield_10001", name: "Team size" },
        { id: STORY_POINTS, name: "Story Points" },
      ],
      guess: STORY_POINTS,
    });
    const text = await browser.setField("customfield_10002");
    expect(text.status).toBe(422);
    expect(await codeOf(text)).toBe("connector_bad_field");
    const made_up = await browser.setField("customfield_99999");
    expect(await codeOf(made_up)).toBe("connector_bad_field");
    expect((await browser.setField()).status).toBe(204);
    expect((await browser.status()).field).toEqual({ id: STORY_POINTS, name: "Story Points" });
  });
});

describe("import", () => {
  it("fills the queue by JQL with key, title and link, through apply", async () => {
    const { browser, code } = await connectedPo();
    const po = await browser.sit(code, "Pia");
    const answer = await browser.import(code, { jql: "project = SECRETPROJECT" });
    expect(answer.status).toBe(200);
    expect(await answer.json()).toEqual({
      added: 3,
      duplicates: 0,
      shortened: 0,
      leftOut: 0,
      beyond: 0,
    });
    const { state } = await loadedRoom(code);
    expect(state.queue?.items[0]).toEqual({
      id: 1,
      key: "ABC-1",
      title: "Ticket 1",
      url: "https://acme.atlassian.net/browse/ABC-1",
      source: { system: "jira", site: FAKE_CLOUD, id: "10001" },
    });
    await po.waitFor((s) => s.room.queue?.count === 3);
  });

  it("imports a sprint picked from a board, by the sprint's number", async () => {
    jira.issues = [...fakeIssues(2, 7), ...fakeIssues(2, 8, 3)];
    const { browser, code } = await connectedPo();
    await browser.sit(code, "Pia");
    const boards = await (await browser.go("/api/connectors/jira/boards")).json();
    expect(boards).toEqual({
      boards: [
        { id: 1, name: "Acme board" },
        { id: 2, name: "Platform board" },
      ],
      more: false,
    });
    const named = await (await browser.go("/api/connectors/jira/boards?name=plat")).json();
    expect(named).toMatchObject({ boards: [{ id: 2 }] });
    const sprints = await (await browser.go("/api/connectors/jira/boards/1/sprints")).json();
    expect(sprints).toEqual({
      sprints: [
        { id: 7, name: "Sprint 7", state: "active" },
        { id: 8, name: "Sprint 8", state: "future" },
      ],
    });
    expect((await browser.go("/api/connectors/jira/boards/x/sprints")).status).toBe(400);
    const answer = await browser.import(code, { sprint: 8 });
    expect(await answer.json()).toMatchObject({ added: 2 });
    const { state } = await loadedRoom(code);
    expect(state.queue?.items.map(({ key }) => key)).toEqual(["ABC-3", "ABC-4"]);
  });

  it("pages through a long list", async () => {
    jira.issues = fakeIssues(250);
    const { browser, code } = await connectedPo();
    await browser.sit(code, "Pia");
    const before = jira.calls.length;
    const answer = await browser.import(code, { jql: "project = X" });
    expect(await answer.json()).toMatchObject({ added: 250, beyond: 0 });
    const pages = jira.calls.slice(before).filter((call) => call.endsWith("/search/jql"));
    expect(pages).toHaveLength(3);
  });

  it("stops at the queue's limit and says how many were left out", async () => {
    jira.issues = fakeIssues(1200);
    const { browser, code } = await connectedPo();
    await browser.sit(code, "Pia");
    const before = jira.calls.length;
    const answer = await browser.import(code, { jql: "project = X" });
    const view = (await answer.json()) as ConnectorImportView;
    expect(view).toEqual({
      added: MAX_QUEUE_ITEMS,
      duplicates: 0,
      shortened: 0,
      leftOut: 100,
      beyond: 600,
    });
    const pages = jira.calls.slice(before).filter((call) => call.endsWith("/search/jql"));
    expect(pages).toHaveLength(6);
    expect((await loadedRoom(code)).state.queue?.items).toHaveLength(MAX_QUEUE_ITEMS);
  });

  it("says so when the count of what lies beyond is not to be had", async () => {
    jira.issues = fakeIssues(700);
    jira.fail = [{ match: "approximate-count", status: 500 }];
    const { browser, code } = await connectedPo();
    await browser.sit(code, "Pia");
    expect(await (await browser.import(code, { jql: "project = X" })).json()).toMatchObject({
      added: 500,
      beyond: null,
    });
  });

  it("drops what the queue holds, and counts it", async () => {
    const { browser, code } = await connectedPo();
    await browser.sit(code, "Pia");
    await browser.import(code, { jql: "project = X" });
    jira.issues = fakeIssues(4);
    expect(await (await browser.import(code, { jql: "project = X" })).json()).toMatchObject({
      added: 1,
      duplicates: 3,
    });
  });

  it("cuts a long title, keeps a ticket whose title cannot be read, leaves out a bad key", async () => {
    jira.issues = [
      { id: "1", key: "ABC-1", summary: "x".repeat(255) },
      { id: "2", key: "ABC-2", summary: `Hidden${String.fromCodePoint(0x200b)}text` },
      { id: "3", key: "ABC-3", summary: "" },
      { id: "4", key: "abc-0", summary: "Not a key" },
    ];
    const { browser, code } = await connectedPo();
    await browser.sit(code, "Pia");
    expect(await (await browser.import(code, { jql: "project = X" })).json()).toEqual({
      added: 3,
      duplicates: 0,
      shortened: 2,
      leftOut: 1,
      beyond: 0,
    });
    const items = (await loadedRoom(code)).state.queue?.items ?? [];
    expect(Array.from(items[0]?.title ?? "")).toHaveLength(200);
    expect(items[1]).not.toHaveProperty("title");
    expect(items[2]).not.toHaveProperty("title");
  });

  it("counts everything as left out when the queue is full, and sends no command", async () => {
    jira.issues = fakeIssues(3);
    const { browser, id } = await connectedPo();
    const { code } = await roomOf(id, (state) => {
      state.queue = {
        items: Array.from({ length: MAX_QUEUE_ITEMS }, (_, n) => ({ id: n + 1, title: `T${n}` })),
        lastId: MAX_QUEUE_ITEMS,
        rev: 1,
      };
    });
    await browser.sit(code, "Pia");
    expect(await (await browser.import(code, { jql: "project = X" })).json()).toMatchObject({
      added: 0,
      leftOut: 3,
    });
    expect((await loadedRoom(code)).state.queue?.rev).toBe(1);
  });

  it("refuses everyone but the PO, before any call to the tracker", async () => {
    const { browser, id } = await connectedPo();
    const other = await account();
    const { code } = await roomOf(other.id);
    await other.browser.connect(code);
    const before = jira.calls.length;
    const answer = await browser.import(code, { jql: "project = X" });
    expect(answer.status).toBe(403);
    expect(await codeOf(answer)).toBe("not_allowed");
    expect(jira.calls).toHaveLength(before);
    expect(id).not.toBe(other.id);
  });

  it("refuses a guest, who is told to sign in", async () => {
    const guest = new Browser();
    const id = await guest.guest();
    const { code } = await roomOf(id);
    const answer = await guest.import(code, { jql: "project = X" });
    expect(answer.status).toBe(403);
    expect(await codeOf(answer)).toBe("connector_sign_in");
  });

  it("asks a PO who is not connected to connect", async () => {
    const { browser, id } = await account();
    const { code } = await roomOf(id);
    const answer = await browser.import(code, { jql: "project = X" });
    expect(answer.status).toBe(409);
    expect(await codeOf(answer)).toBe("connector_not_connected");
  });

  it("refuses a query past the cap and an empty one, before it leaves", async () => {
    const { browser, code } = await connectedPo();
    const before = jira.calls.length;
    expect((await browser.import(code, { jql: "x".repeat(2001) })).status).toBe(400);
    expect((await browser.import(code, { jql: "   " })).status).toBe(400);
    expect((await browser.import(code, { sprint: -1 })).status).toBe(400);
    expect((await browser.import(code, { jql: "a", sprint: 1 })).status).toBe(400);
    expect(jira.calls).toHaveLength(before);
  });

  it("has its own limit, per person", async () => {
    const { browser, code } = await connectedPo();
    await browser.sit(code, "Pia");
    for (let n = 0; n < CONNECTOR_IMPORT_LIMIT.max; n++) {
      await browser.import(code, { jql: "project = X" });
    }
    const answer = await browser.import(code, { jql: "project = X" });
    expect(answer.status).toBe(429);
    expect(await codeOf(answer)).toBe("rate_limited");
    expect(answer.headers.get("retry-after")).not.toBeNull();
  });

  it("adds nothing when a page in the middle fails", async () => {
    jira.issues = fakeIssues(150);
    const { browser, code } = await connectedPo();
    await browser.sit(code, "Pia");
    jira.pageFailure = { page: 2, status: 500 };
    const answer = await browser.import(code, { jql: "project = X" });
    expect(answer.status).toBe(502);
    expect((await loadedRoom(code)).state.queue).toBeUndefined();
  });
});

describe("failures of the tracker", () => {
  const failures = [
    [429, "connector_rate_limited", 429, "120"],
    [403, "connector_forbidden", 403, undefined],
    [404, "connector_not_found", 404, undefined],
    [500, "connector_unavailable", 502, undefined],
    [503, "connector_unavailable", 502, undefined],
  ] as const;

  it.each(failures)("%i on an import is %s", async (status, code, answerStatus, retryAfter) => {
    const po = await connectedPo();
    jira.fail = [{ match: "/search/jql", status, ...(retryAfter ? { retryAfter } : {}) }];
    const answer = await po.browser.import(po.code, { jql: "project = SECRETPROJECT" });
    expect(answer.status).toBe(answerStatus);
    const body = (await answer.json()) as Record<string, unknown>;
    expect(body.code).toBe(code);
    if (retryAfter) {
      expect(answer.headers.get("retry-after")).toBe(retryAfter);
      expect(body.retryAfter).toBe(120);
    }
    expect((await po.browser.status()).connected).toBe(true);
  });

  it.each(failures)("%i on a write-back is %s", async (status, code, answerStatus, retryAfter) => {
    const { browser, code: room } = await connectedPo();
    const po = await browser.sit(room, "Pia");
    await browser.import(room, { jql: "project = X" });
    const round = await estimate(po, 1, "5");
    jira.fail = [{ match: "/rest/api/3/issue/", status, ...(retryAfter ? { retryAfter } : {}) }];
    const answer = await browser.writeBack(room, round);
    expect(answer.status).toBe(answerStatus);
    expect(await codeOf(answer)).toBe(code);
    // A failed write harms nothing, and the same press goes through.
    expect((await loadedRoom(room)).state.round?.final).toBe("5");
    expect((await browser.writeBack(room, round)).status).toBe(200);
  });

  it("a query Jira refuses is the person's to fix, and its text comes back from nowhere", async () => {
    const { browser, code } = await connectedPo();
    const answer = await browser.import(code, { jql: "bad jql with A very private ticket" });
    expect(answer.status).toBe(422);
    expect(await answer.text()).toBe('{"code":"connector_bad_query"}');
  });

  it("a field off the item's screen is said so", async () => {
    const { browser, code: room } = await connectedPo();
    const po = await browser.sit(room, "Pia");
    await browser.import(room, { jql: "project = X" });
    const round = await estimate(po, 1, "5");
    jira.fail = [{ match: "/rest/api/3/issue/", status: 400 }];
    const answer = await browser.writeBack(room, round);
    expect(answer.status).toBe(422);
    expect(await codeOf(answer)).toBe("connector_field_refused");
  });
});

describe("the token's life", () => {
  it("refreshes a token near its end, rotates the refresh token, and keeps the row", async () => {
    jira.expiresIn = 30;
    const { browser, id } = await account();
    const { code } = await roomOf(id);
    await browser.connect(code);
    const issued = jira.issued.length;
    jira.expiresIn = 3600;
    await browser.sit(code, "Pia");
    expect((await browser.import(code, { jql: "project = X" })).status).toBe(200);
    expect(jira.issued).toHaveLength(issued + 1);
    const before = jira.tokenRequests.at(-1);
    expect(before?.grant_type).toBe("refresh_token");
    expect((await browser.import(code, { jql: "project = Y" })).status).toBe(200);
    expect(jira.issued).toHaveLength(issued + 1);
  });

  it("a token Jira no longer takes is refreshed once, and the call goes through", async () => {
    const { browser, code } = await connectedPo();
    await browser.sit(code, "Pia");
    const last = jira.issued.at(-1);
    if (!last) throw new Error("no token");
    jira.revoked.add(last.access);
    expect((await browser.import(code, { jql: "project = X" })).status).toBe(200);
    expect(jira.issued.at(-1)).not.toEqual(last);
  });

  it("invalid_grant means connect again: the row is gone, and it is no error page", async () => {
    const { browser, id, code } = await connectedPo();
    const last = jira.issued.at(-1);
    if (!last) throw new Error("no token");
    jira.revoked.add(last.access);
    jira.fail = [
      { match: "/oauth/token", status: 403, body: { error: "invalid_grant" }, times: 1 },
    ];
    const answer = await browser.import(code, { jql: "project = X" });
    expect(answer.status).toBe(409);
    expect(await codeOf(answer)).toBe("connector_reconnect");
    expect(await browser.status()).toEqual({ connected: false });
    const { rowCount } = await admin.query("select 1 from connector_token where user_id = $1", [
      id,
    ]);
    expect(rowCount).toBe(0);
  });

  it("a bad minute at the token address costs no connection", async () => {
    const { browser, code } = await connectedPo();
    const last = jira.issued.at(-1);
    if (!last) throw new Error("no token");
    jira.revoked.add(last.access);
    jira.fail = [{ match: "/oauth/token", status: 503, times: 1 }];
    const answer = await browser.import(code, { jql: "project = X" });
    expect(await codeOf(answer)).toBe("connector_unavailable");
    expect((await browser.status()).connected).toBe(true);
  });

  /** Two instances: each has its own `createConnectorAccess`, as each has its own process. */
  function twoInstances() {
    const connector = createJiraConnector(FAKE_JIRA_CLIENT);
    const tokens = setup.database.connectorTokens;
    return [createConnectorAccess(tokens, connector), createConnectorAccess(tokens, connector)];
  }

  /** The token address holds both refreshes until both have arrived. */
  function overlap() {
    let arrived = 0;
    let release = () => {};
    const both = new Promise<void>((resolve) => {
      release = resolve;
    });
    jira.beforeRefresh = async () => {
      arrived += 1;
      if (arrived >= 2) release();
      await both;
    };
  }

  async function nearItsEnd() {
    jira.expiresIn = 30;
    const { browser, id } = await account();
    const { code } = await roomOf(id);
    await browser.connect(code);
    jira.expiresIn = 3600;
    const me = accountOf({ id, isAnonymous: false }) as AccountId;
    return { browser, me, code };
  }

  const useToken = (token: { reveal(): string }) =>
    Promise.resolve({ ok: true as const, value: token.reveal() });

  it("two instances refreshing at once both get a token, and one stays", async () => {
    const { browser, me } = await nearItsEnd();
    const [one, two] = twoInstances();
    const before = jira.issued.length;
    overlap();
    const [first, second] = await Promise.all([
      one?.withToken(me, useToken),
      two?.withToken(me, useToken),
    ]);
    expect(jira.issued).toHaveLength(before + 2);
    expect(first).toMatchObject({ ok: true });
    expect(second).toEqual(first);
    expect((await browser.status()).connected).toBe(true);
  });

  it("the loser of a race that Jira refuses keeps the connection: the row is the winner's", async () => {
    const { browser, me, code } = await nearItsEnd();
    const [one, two] = twoInstances();
    jira.strictRotation = true;
    const before = jira.issued.length;
    overlap();
    const [first, second] = await Promise.all([
      one?.withToken(me, useToken),
      two?.withToken(me, useToken),
    ]);
    expect(jira.issued).toHaveLength(before + 1);
    const winner = jira.issued.at(-1)?.access;
    expect(first).toEqual({ ok: true, value: winner });
    expect(second).toEqual({ ok: true, value: winner });
    await browser.sit(code, "Pia");
    expect((await browser.status()).connected).toBe(true);
    expect((await browser.import(code, { jql: "project = X" })).status).toBe(200);
  });

  it("a refresh that finishes after a disconnect brings nothing back", async () => {
    const { browser, me } = await nearItsEnd();
    const [one] = twoInstances();
    jira.beforeRefresh = async () => {
      expect((await browser.send("DELETE", "/api/connectors/jira", {})).status).toBe(204);
    };
    await expect(one?.withToken(me, useToken)).resolves.toEqual({
      ok: false,
      code: "connector_not_connected",
    });
    expect((await browser.status()).connected).toBe(false);
  });

  it("two people refreshing on one instance each get their own token", async () => {
    const first = await nearItsEnd();
    const second = await nearItsEnd();
    const [one] = twoInstances();
    const [mine, theirs] = await Promise.all([
      one?.withToken(first.me, useToken),
      one?.withToken(second.me, useToken),
    ]);
    if (!mine?.ok || !theirs?.ok) throw new Error("no token");
    expect(mine.value).not.toBe(theirs.value);
  });

  it("one instance makes one refresh for a page of calls", async () => {
    const { me } = await nearItsEnd();
    const [one] = twoInstances();
    const before = jira.issued.length;
    await Promise.all([
      one?.withToken(me, useToken),
      one?.withToken(me, useToken),
      one?.withToken(me, useToken),
    ]);
    expect(jira.issued).toHaveLength(before + 1);
  });
});

describe("disconnect", () => {
  it("deletes the row, and the next call asks to connect", async () => {
    const { browser, id, code } = await connectedPo();
    expect((await browser.go("/api/connectors/jira", { method: "DELETE" })).status).toBe(204);
    expect(await browser.status()).toEqual({ connected: false });
    const { rowCount } = await admin.query("select 1 from connector_token where user_id = $1", [
      id,
    ]);
    expect(rowCount).toBe(0);
    expect(await codeOf(await browser.import(code, { jql: "x" }))).toBe("connector_not_connected");
  });
});

describe("write-back", () => {
  const POINTS = (value: number) => ({ fields: { [STORY_POINTS]: value } });

  it("writes the final to the issue, by its id, with the PO's own token, twice harmlessly", async () => {
    const { browser, code } = await connectedPo();
    const po = await browser.sit(code, "Pia");
    await browser.import(code, { jql: "project = X" });
    const round = await estimate(po, 1, "8");
    const answer = await browser.writeBack(code, round);
    expect(answer.status).toBe(200);
    expect(await answer.json()).toEqual({ key: "ABC-1", value: 8 });
    expect(jira.writes.at(-1)).toMatchObject({
      site: FAKE_CLOUD,
      issue: "10001",
      body: POINTS(8),
      token: jira.issued.at(-1)?.access,
    });
    const writes = jira.writes.length;
    expect((await browser.writeBack(code, round)).status).toBe(200);
    expect(jira.writes).toHaveLength(writes + 1);
  });

  it("sends an anonymous round's final and not one thing more", async () => {
    const { browser, id, code } = await connectedPo();
    const po = await browser.sit(code, "Pia");
    const other = await account();
    const ana = await other.browser.sit(code, "Ana");
    await must(po.cmd("updateSettings", { patch: { revealNames: false } }));
    await browser.import(code, { jql: "project = X" });
    const round = await estimate(po, 1, "13", [ana]);
    expect((await loadedRoom(code)).state.round?.anonymous).toBe(true);
    await browser.writeBack(code, round);
    const write = jira.writes.at(-1);
    expect(write?.body).toEqual(POINTS(13));
    expect(JSON.stringify(write)).not.toMatch(/Pia|Ana/);
    expect(id).not.toBe(other.id);
  });

  it("writes a past round's final from history, for a retry", async () => {
    const { browser, code } = await connectedPo();
    const po = await browser.sit(code, "Pia");
    await browser.import(code, { jql: "project = X" });
    const first = await estimate(po, 1, "3");
    await estimate(po, 2, "5");
    await expect(po.history({})).resolves.toMatchObject({
      ok: true,
      rounds: [{ number: first, system: "jira", final: "3" }],
    });
    expect(await (await browser.writeBack(code, first)).json()).toEqual({ key: "ABC-1", value: 3 });
    expect(jira.writes.at(-1)).toMatchObject({ issue: "10001", body: POINTS(3) });
  });

  it("does not write a final with no number, and says so", async () => {
    const { browser, code } = await connectedPo();
    const po = await browser.sit(code, "Pia");
    await must(po.cmd("updateSettings", { patch: { deck: { kind: "preset", id: "tshirt" } } }));
    await browser.import(code, { jql: "project = X" });
    await must(po.cmd("startNext", { id: 1 }));
    await must(po.cmd("castVote", { card: "M", round: 1, restart: 0 }));
    await must(po.cmd("setFinal", { card: "M" }));
    const writes = jira.writes.length;
    const answer = await browser.writeBack(code, 1);
    expect(answer.status).toBe(422);
    expect(await codeOf(answer)).toBe("connector_not_numeric");
    expect(jira.writes).toHaveLength(writes);
  });

  it("refuses a round with no final, a pasted item and an unknown round", async () => {
    const { browser, code } = await connectedPo();
    const po = await browser.sit(code, "Pia");
    await must(po.cmd("queueAdd", { items: [{ key: "ABC-9", title: "Pasted" }] }));
    expect(await codeOf(await browser.writeBack(code, 1))).toBe("connector_no_final");
    const round = await estimate(po, 1, "5");
    const writes = jira.writes.length;
    expect(await codeOf(await browser.writeBack(code, round))).toBe("connector_no_source");
    expect(await codeOf(await browser.writeBack(code, 99))).toBe("connector_no_final");
    expect(jira.writes).toHaveLength(writes);
  });

  it("refuses a PO connected to another site, whose token never leaves", async () => {
    jira.sites = [ACME, GLOBEX];
    const { browser, id } = await account();
    const { code } = await roomOf(id);
    await browser.connect(code);
    await browser.send("PUT", "/api/connectors/jira/site", { id: FAKE_CLOUD });
    await browser.setField();
    const po = await browser.sit(code, "Pia");
    await browser.import(code, { jql: "project = X" });
    const round = await estimate(po, 1, "5");
    await browser.send("PUT", "/api/connectors/jira/site", { id: FAKE_CLOUD_TWO });
    await browser.setField();
    const before = jira.calls.length;
    const answer = await browser.writeBack(code, round);
    expect(answer.status).toBe(409);
    expect(await codeOf(answer)).toBe("connector_other_site");
    expect(jira.calls).toHaveLength(before);
  });

  it("asks for the field first", async () => {
    const { browser, id } = await account();
    const { code } = await roomOf(id);
    await browser.connect(code);
    const po = await browser.sit(code, "Pia");
    await browser.import(code, { jql: "project = X" });
    const round = await estimate(po, 1, "5");
    expect(await codeOf(await browser.writeBack(code, round))).toBe("connector_no_field");
  });

  it("uses the PO's token, never the keeper's for a PO who claimed the role", async () => {
    const keeper = await connectedPo();
    const keeperToken = jira.issued.at(-1)?.access;
    const claimed = await account();
    const { code: own } = await roomOf(claimed.id);
    await claimed.browser.connect(own);
    await claimed.browser.setField();
    const claimedToken = jira.issued.at(-1)?.access;
    const { code } = await roomOf(claimed.id, (state) => {
      state.keeperId = keeper.id;
    });
    const po = await claimed.browser.sit(code, "Claimer");
    await claimed.browser.import(code, { jql: "project = X" });
    const round = await estimate(po, 1, "5");
    const writes = jira.writes.length;
    expect((await claimed.browser.writeBack(code, round)).status).toBe(200);
    expect(jira.writes).toHaveLength(writes + 1);
    expect(jira.writes.at(-1)?.token).toBe(claimedToken);
    expect(jira.writes.at(-1)?.token).not.toBe(keeperToken);
    // The keeper, not the PO here, may not write through this room at all.
    expect((await keeper.browser.writeBack(code, round)).status).toBe(403);
  });

  it("a PO with no connection writes nothing, though others in the room have one", async () => {
    const connected = await connectedPo();
    const unconnected = await account();
    const { code } = await roomOf(unconnected.id, (state) => {
      state.keeperId = connected.id;
    });
    const seats = await unconnected.browser.sit(code, "Unconnected");
    await connected.browser.sit(code, "Connected");
    await must(seats.cmd("queueAdd", { items: [{ key: "ABC-1" }] }));
    await must(seats.cmd("startRound", { subject: { kind: "none" } }));
    const before = jira.calls.length;
    const answer = await unconnected.browser.import(code, { jql: "project = X" });
    expect(await codeOf(answer)).toBe("connector_not_connected");
    expect(jira.calls).toHaveLength(before);
  });

  it("is the PO's alone: a voter's press writes nothing", async () => {
    const { browser, code } = await connectedPo();
    const po = await browser.sit(code, "Pia");
    const voter = await connectedPo();
    const ana = await voter.browser.sit(code, "Ana");
    await browser.import(code, { jql: "project = X" });
    const round = await estimate(po, 1, "5", [ana]);
    const writes = jira.writes.length;
    const answer = await voter.browser.writeBack(code, round);
    expect(answer.status).toBe(403);
    expect(jira.writes).toHaveLength(writes);
  });

  it("has its own limit, per person", async () => {
    const { browser, code } = await connectedPo();
    for (let n = 0; n < CONNECTOR_WRITE_LIMIT.max; n++) await browser.writeBack(code, 1);
    expect((await browser.writeBack(code, 1)).status).toBe(429);
  });
});

describe("what other people see", () => {
  it("nobody else gets a token, a site or an item's text beyond what the queue shares", async () => {
    jira.issues = [
      { id: "10001", key: "ABC-1", summary: "A very private ticket", sprint: 7 },
      { id: "10002", key: "ABC-2", summary: "Another private ticket", sprint: 7 },
      { id: "10003", key: "ABC-3", summary: "A third private ticket", sprint: 7 },
    ];
    const { browser, code } = await connectedPo();
    const po = await browser.sit(code, "Pia");
    const other = await account();
    const ana = await other.browser.sit(code, "Ana");
    await browser.import(code, { jql: "project = X" });
    await ana.waitFor((s) => s.room.queue?.count === 3);
    await ana.history({});
    const queued = ana.frames.join("\n");
    expect(queued).toContain("ABC-1");
    expect(queued).not.toContain("private ticket");
    expect(queued).not.toContain("10001");

    await must(po.cmd("startNext", { id: 1 }));
    await ana.waitFor((s) => s.room.round?.phase === "voting");
    await ana.history({});
    const started = ana.frames.join("\n");
    // The round's subject is everyone's, as for any queue item: the next items stay the PO's.
    expect(started).toContain("A very private ticket");
    expect(started).not.toContain("Another private ticket");
    expect(started).not.toContain("A third private ticket");
    expect(ana.latest()?.room.round).not.toHaveProperty("system");
    expect(po.latest()?.room.round?.system).toBe("jira");
    for (const client of [po, ana]) {
      const wire = client.frames.join("\n");
      expect(wire).not.toContain(FAKE_CLOUD);
      expect(wire).not.toContain("acme.atlassian.net/rest");
      for (const { access, refresh } of jira.issued) {
        expect(wire).not.toContain(access);
        expect(wire).not.toContain(refresh);
      }
    }
    await must(po.cmd("reveal"));
    await must(po.cmd("setFinal", { card: "5" }));
    await ana.waitFor((s) => s.room.round?.phase === "revealed");
    await browser.writeBack(code, po.latest()?.room.round?.number ?? 0);
    await ana.history({});
    expect(ana.frames.join("\n")).not.toContain(FAKE_CLOUD);
  });
});

describe("dark without its keys", () => {
  const WITHOUT = [
    ["no client id or secret", { JIRA_CLIENT_ID: "", JIRA_CLIENT_SECRET: "" }],
    ["no vault", { POKER_VAULT_KEY: "" }],
  ] as const;

  it.each(WITHOUT)("%s: every route answers as absent", async (_, off) => {
    const config = testConfig({ DATABASE_URL: t.url, TRUST_PROXY: "1", ...KEYS, ...off });
    const dark = await setupServer(config, logs.logger);
    const darkServer = createServer(config, { ...dark.deps, logger: logs.logger });
    await darkServer.listen();
    const base = urlOf(darkServer);
    const asked = [
      fetch(`${base}/api/connectors/jira`),
      fetch(`${base}/api/connectors/jira/callback?state=x&code=y`),
      fetch(`${base}/api/connectors/jira/sites`),
      fetch(`${base}/api/rooms/abcdefghij/connectors/jira/import`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      }),
    ];
    for (const answer of await Promise.all(asked)) {
      expect(answer.status).toBe(404);
      expect(await answer.json()).toEqual({ code: "not_found" });
    }
    await darkServer.close();
    await dark.database.close();
  });
});
