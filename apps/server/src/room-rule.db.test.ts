/**
 * A room limited to an email domain or a Microsoft tenant (#50, ADR-028), against a real Postgres
 * and the stand-in for the providers: real sign-ins, real sockets, real frames.
 *
 * What it holds: a domain is met only by an address Google verified, and a Microsoft address
 * never meets one; a tenant is met only by `account.tenant_id`; a guest is asked to sign in; a
 * refused person gets no snapshot, no room name and nothing of the password; the rule goes
 * before the password, at `enter`, at `join` and at `/access`; the PO always stays; a seat stays
 * while its socket does and goes at the next enter; a visitor leaves when a rule arrives;
 * nobody the rule refuses becomes PO; a rule whose provider is gone fails closed; a guest's seat
 * and a refused guest both come through a sign-in as they should; and no address, tenant or
 * room code reaches a log line, or a frame for anyone who should not hold it.
 *
 * "The one invariant" attacks the place frames leave: no socket without a seat or the PO role gets
 * a frame unless it was judged against that frame's gate, whichever way it got there, with one
 * instance and, with `TEST_REDIS_URL`, with two.
 */
import { createRoom, type Restriction, type RoomState } from "@pp/domain";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Config } from "./config.ts";
import { DatabaseError } from "./db/errors.ts";
import { createTestDatabase, type TestDatabase, testClient } from "./db/test-db.ts";
import {
  atFake,
  FAKE_PERSON_PARAM,
  type FakeOidc,
  type FakePerson,
  fakePersonParam,
  routeProvidersTo,
  startFakeOidc,
} from "./fake-oidc.ts";
import { hashPassword } from "./password.ts";
import { RESTRICTION_READ_LIMIT, RESTRICTION_REMOVE_LIMIT } from "./room-rule-api.ts";
import { createServer, type PokerServer } from "./server.ts";
import { setupServer } from "./setup.ts";
import { type RoomSync, RULE_CHANGE_LIMIT } from "./sync/room-sync.ts";
import { roomCode, testClient as socketClient, type TestClient } from "./sync/test-support.ts";
import { collectLogs, testConfig, VALID_ENV } from "./test-support.ts";

const ORIGIN = VALID_ENV.BASE_URL;
const KEYS = {
  GOOGLE_CLIENT_ID: "test-google-client-id",
  GOOGLE_CLIENT_SECRET: "test-google-secret-do-not-log",
  MICROSOFT_CLIENT_ID: "test-microsoft-client-id",
  MICROSOFT_CLIENT_SECRET: "test-microsoft-secret-do-not-log",
  MICROSOFT_TENANT_ID: "common",
} as const;
const TENANT = "11111111-2222-3333-4444-555555555555";
const OTHER_TENANT = "99999999-9999-9999-9999-999999999999";
const PASSWORD = "the-right-password";

const logs = collectLogs("trace");
const open: TestClient[] = [];
const codes: string[] = [];
const frames: string[] = [];
let t: TestDatabase;
let admin: ReturnType<typeof testClient>;
let config: Config;
let fake: FakeOidc;
let restoreFetch: () => void;
let server: PokerServer;
let setup: Awaited<ReturnType<typeof setupServer>>;
let at: string;

const urlOf = (target: PokerServer) => {
  const bound = target.httpServer.address();
  if (!bound || typeof bound === "string") throw new Error("not listening");
  return `http://localhost:${bound.port}`;
};

beforeAll(async () => {
  fake = await startFakeOidc();
  restoreFetch = routeProvidersTo(fake.origin);
  t = await createTestDatabase();
  admin = testClient(t.url);
  config = testConfig({ DATABASE_URL: t.url, TRUST_PROXY: "1", ...KEYS });
  setup = await setupServer(config, logs.logger);
  server = createServer(config, { ...setup.deps, logger: logs.logger });
  await server.listen();
  at = urlOf(server);
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
  await fake?.close();
  restoreFetch?.();
  const everything = logs.raw.join("\n");
  expect(everything).not.toContain("@example.com");
  expect(everything).not.toContain("@contoso.com");
  expect(everything).not.toContain(TENANT);
  expect(everything).not.toContain(OTHER_TENANT);
  for (const code of codes) expect(everything).not.toContain(code);
  // Nobody's address or provider, in any frame of any test.
  const wire = frames.join("\n");
  expect(wire).not.toContain("@example.com");
  expect(wire).not.toContain("@contoso.com");
  expect(wire).not.toContain(OTHER_TENANT);
});

let addresses = 0;

/** A browser's cookie jar over `fetch`, following nothing by itself, at an address of its own. */
class Browser {
  readonly jar = new Map<string, string>();
  readonly address = `203.0.${Math.floor(addresses / 250)}.${(addresses++ % 250) + 1}`;

  constructor(readonly base = () => at) {}

  get cookie(): string {
    return [...this.jar].map(([name, value]) => `${name}=${value}`).join("; ");
  }

  async go(path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    if (this.jar.size > 0) headers.set("cookie", this.cookie);
    headers.set("x-forwarded-for", this.address);
    const response = await fetch(`${this.base()}${path}`, { ...init, headers, redirect: "manual" });
    for (const line of response.headers.getSetCookie()) {
      const [pair = "", ...rest] = line.split(";");
      const name = pair.slice(0, pair.indexOf("="));
      const value = pair.slice(pair.indexOf("=") + 1);
      if (/max-age=0/i.test(rest.join(";")) || value === "") this.jar.delete(name);
      else this.jar.set(name, value);
    }
    return response;
  }

  post(path: string, body: unknown): Promise<Response> {
    return this.go(path, {
      method: "POST",
      headers: { origin: ORIGIN, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  async id(): Promise<string> {
    const response = await this.go("/api/auth/get-session");
    const session = (await response.json()) as { user: { id: string } } | null;
    return session?.user.id ?? "";
  }

  async guest(): Promise<string> {
    expect((await this.post("/api/auth/sign-in/anonymous", {})).status).toBe(200);
    return this.id();
  }

  /** A whole sign-in at the stand-in. */
  async signIn(provider: "google" | "microsoft", who: FakePerson, returnTo = "/") {
    const started = await this.post("/api/auth/sign-in/social", { provider, returnTo });
    expect(started.status).toBe(200);
    const { url } = (await started.json()) as { url: string };
    const answer = await fetch(
      `${atFake(url, fake.origin)}&${FAKE_PERSON_PARAM}=${fakePersonParam(who)}`,
      { redirect: "manual" },
    );
    const back = new URL(answer.headers.get("location") ?? "");
    const callback = await this.go(`${back.pathname}${back.search}`);
    expect(callback.status).toBe(302);
    return this.id();
  }

  socket(): TestClient {
    const client = socketClient(this.base(), { cookie: this.cookie });
    open.push(client);
    return client;
  }

  async sit(code: string, name: string): Promise<TestClient> {
    const client = this.socket();
    await expect(client.enter(code)).resolves.toMatchObject({ ok: true });
    await must(client.cmd("join", { name, role: "voter" }));
    return client;
  }

  async access(code: string, password = PASSWORD) {
    const answer = await this.post(`/api/rooms/${code}/access`, { password });
    return { status: answer.status, body: await answer.text() };
  }

  /** The room's public header, as the join page reads it. */
  async header(code: string) {
    return (await (await this.go(`/api/rooms/${code}`)).json()) as Record<string, unknown>;
  }

  async panel(code: string) {
    const answer = await this.go(`/api/rooms/${code}/restriction`);
    return { status: answer.status, body: (await answer.json()) as Record<string, unknown> };
  }
}

async function must(ack: Promise<{ ok: boolean }>) {
  await expect(ack).resolves.toMatchObject({ ok: true });
}

let people = 0;
function person(overrides: Partial<FakePerson> = {}): FakePerson {
  people += 1;
  return {
    id: `provider-person-${people}`,
    email: `person${people}@example.com`,
    name: `Provider Name ${people}`,
    emailVerified: true,
    tenant: TENANT,
    ...overrides,
  };
}

/** A Google account the domain rule refuses, with an address of its own. */
const outsider = () => person({ email: `person${people + 1}@elsewhere.example` });

const SECRET_NAME = "The confidential room";

/** A room owned by `ownerId`, with a name, a rule, and a password when asked. */
async function roomOf(
  ownerId: string,
  restriction?: Restriction,
  { password = false, seats = {} as RoomState["participants"] } = {},
) {
  const code = roomCode();
  codes.push(code);
  const state = createRoom({ ownerId });
  state.participants = seats;
  if (restriction) state.settings.restriction = restriction;
  if (password) state.hasPassword = true;
  const stored = await setup.database.store.insertRoom({
    code,
    name: SECRET_NAME,
    state,
    ...(password && { passwordHash: await hashPassword(PASSWORD) }),
  });
  if (!stored) throw new Error("code taken");
  return stored;
}

const loaded = async (code: string) => {
  const room = await setup.database.store.loadRoom(code);
  if (!room) throw new Error("no room");
  return room;
};

const DOMAIN_RULE: Restriction = { domains: ["example.com"], tenants: [] };
const TENANT_RULE: Restriction = { domains: [], tenants: [TENANT] };

/** A PO signed in with Google on example.com. */
async function signedInPo() {
  const browser = new Browser();
  const id = await browser.signIn("google", person());
  return { browser, id };
}

const refused = (code: string, domains: string[], organisation: boolean) => ({
  ok: false,
  code,
  requirement: { domains, organisation },
});

/**
 * Everything the server has sent this client so far has arrived: frames on one connection keep
 * their order, and this answer left after them. What a negative assert reads must come after it.
 */
const settled = async (client: TestClient) => {
  await client.history({});
};

/** Resolves when the client hears `event`. */
const hears = (client: TestClient, event: "locked" | "kicked") =>
  new Promise<void>((resolve) => client.socket.once(event, () => resolve()));

/** A socket connected, and not yet in a room. */
async function connected(client: TestClient) {
  if (!client.socket.connected) {
    await new Promise<void>((resolve) => client.socket.once("connect", () => resolve()));
  }
  return client;
}

/** The `nth` load of the room from now on reads, then waits to answer until `release`. */
function holdLoad(code: string, nth = 1) {
  const store = setup.database.store;
  const real = store.loadRoom;
  let read = () => {};
  let release = () => {};
  const reading = new Promise<void>((resolve) => {
    read = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let seen = 0;
  store.loadRoom = async (asked) => {
    const answer = await real(asked);
    if (asked === code && ++seen === nth) {
      read();
      await gate;
    }
    return answer;
  };
  return {
    reading,
    release,
    restore: () => {
      store.loadRoom = real;
    },
  };
}

/** Writes `live` as only hand-written SQL could: a rule `apply` would never store. */
async function storeRaw(id: string, rule: string) {
  await admin.query(
    `update room set live = jsonb_set(live, '{settings,restriction}', $1::jsonb) where id = $2`,
    [rule, id],
  );
}

const countOf = async (table: string, column: string, id: string) => {
  const { rows } = await admin.query(
    `select count(*)::int as n from ${table} where ${column} = $1`,
    [id],
  );
  return (rows[0] as { n: number }).n;
};

const ageSession = (user: string, days: number) =>
  admin.query(
    `update session set created_at = now() - make_interval(days => $1) where user_id = $2`,
    [days, user],
  );

describe("who passes", () => {
  it("a Google account whose address Google verified, on an allowed domain", async () => {
    const { id: po } = await signedInPo();
    const room = await roomOf(po, DOMAIN_RULE);
    const browser = new Browser();
    await browser.signIn("google", person());
    await browser.sit(room.code, "Colleague");
    expect(await browser.header(room.code)).toEqual({
      code: room.code,
      name: SECRET_NAME,
      hasPassword: false,
    });
  });

  it("not a Google address Google has not verified", async () => {
    const { id: po } = await signedInPo();
    const room = await roomOf(po, DOMAIN_RULE);
    const browser = new Browser();
    await browser.signIn("google", person({ emailVerified: false }));
    expect(await browser.socket().enter(room.code)).toEqual(
      refused("account_not_allowed", ["example.com"], false),
    );
  });

  it("not a neighbouring domain, a subdomain, or one that ends in it", async () => {
    const { id: po } = await signedInPo();
    const room = await roomOf(po, DOMAIN_RULE);
    for (const email of [
      "a@notexample.com",
      "a@example.com.evil.net",
      "a@mail.example.com",
      "a@EXAMPLE.org",
    ]) {
      const browser = new Browser();
      await browser.signIn("google", person({ email }));
      expect((await browser.socket().enter(room.code)).ok).toBe(false);
    }
  });

  it("whatever the case of the address's domain", async () => {
    const { id: po } = await signedInPo();
    const room = await roomOf(po, DOMAIN_RULE);
    const browser = new Browser();
    await browser.signIn("google", person({ email: "Upper@EXAMPLE.com" }));
    await browser.sit(room.code, "Upper");
  });

  it("never a Microsoft address, whatever it claims and whatever the token says", async () => {
    const { id: po } = await signedInPo();
    const room = await roomOf(po, DOMAIN_RULE);
    const browser = new Browser();
    await browser.signIn(
      "microsoft",
      person({ email: "ceo@example.com", emailVerified: true, tenant: OTHER_TENANT }),
    );
    expect(await browser.socket().enter(room.code)).toEqual(
      refused("account_not_allowed", ["example.com"], false),
    );
  });

  it("a Microsoft account of the tenant, by the token's id, whatever its address", async () => {
    const { id: po } = await signedInPo();
    const room = await roomOf(po, TENANT_RULE);
    const browser = new Browser();
    await browser.signIn(
      "microsoft",
      person({ email: "someone@elsewhere.example", tenant: TENANT.toUpperCase() }),
    );
    await browser.sit(room.code, "Tenant");
  });

  it("not a Microsoft account of another tenant, claiming the domain of the right one", async () => {
    const { id: po } = await signedInPo();
    const room = await roomOf(po, TENANT_RULE);
    const browser = new Browser();
    await browser.signIn("microsoft", person({ email: "a@contoso.com", tenant: OTHER_TENANT }));
    expect(await browser.socket().enter(room.code)).toEqual(
      refused("account_not_allowed", [], true),
    );
  });

  it("not a Google account on a tenant's rule", async () => {
    const { id: po } = await signedInPo();
    const room = await roomOf(po, TENANT_RULE);
    const browser = new Browser();
    await browser.signIn("google", person());
    expect((await browser.socket().enter(room.code)).ok).toBe(false);
  });
});

describe("someone refused", () => {
  it("a guest is asked to sign in, and hears the domains and no tenant's id", async () => {
    const { id: po } = await signedInPo();
    const room = await roomOf(po, { domains: ["example.com"], tenants: [TENANT] });
    const browser = new Browser();
    await browser.guest();
    const client = browser.socket();
    expect(await client.enter(room.code)).toEqual(
      refused("sign_in_required", ["example.com"], true),
    );
    expect(client.frames.join("\n")).not.toContain(TENANT);
  });

  it("gets no snapshot and no name: not over HTTP, not on the socket", async () => {
    const { browser: poBrowser, id: po } = await signedInPo();
    const room = await roomOf(po, DOMAIN_RULE, { password: true });
    const owner = await poBrowser.sit(room.code, "The PO");
    await must(owner.cmd("startRound", { subject: { kind: "title", text: "Secret ticket" } }));

    const browser = new Browser();
    await browser.guest();
    const client = browser.socket();
    expect((await client.enter(room.code)).ok).toBe(false);
    await must(owner.cmd("rename", { name: "The renamed PO" }));
    await owner.waitFor((s) => s.room.participants[0]?.name === "The renamed PO");
    await settled(client);
    expect(client.received).toEqual([]);
    const wire = client.frames.join("\n");
    expect(wire).not.toContain("Secret ticket");
    expect(wire).not.toContain("renamed");
    expect(wire).not.toContain(SECRET_NAME);
    // Neither the name nor that the room has a password.
    expect(await browser.header(room.code)).toEqual({
      code: room.code,
      name: null,
      hasPassword: false,
    });
    expect(await new Browser().header(room.code)).toEqual({
      code: room.code,
      name: null,
      hasPassword: false,
    });
  });

  it("cannot join, and a join does not reach the room", async () => {
    const { browser: poBrowser, id: po } = await signedInPo();
    const room = await roomOf(po);
    const owner = await poBrowser.sit(room.code, "The PO");
    const browser = new Browser();
    await browser.guest();
    const client = browser.socket();
    await expect(client.enter(room.code)).resolves.toMatchObject({ ok: true });
    await must(owner.cmd("updateSettings", { patch: { restriction: DOMAIN_RULE } }));
    await expect(client.cmd("join", { name: "Late", role: "voter" })).resolves.toMatchObject({
      ok: false,
    });
    expect(Object.keys((await loaded(room.code)).state.participants)).toEqual([po]);
  });

  it("is stopped at the join by the join's own guard, with the socket still in the room", async () => {
    const { browser: poBrowser, id: po } = await signedInPo();
    const room = await roomOf(po);
    await poBrowser.sit(room.code, "The PO");
    const browser = new Browser();
    await browser.guest();
    const client = browser.socket();
    await expect(client.enter(room.code)).resolves.toMatchObject({ ok: true });
    // No commit, so no `locked` took the socket out first: only the join's guard is left.
    await storeRaw(room.id, JSON.stringify(DOMAIN_RULE));
    await expect(client.cmd("join", { name: "Late", role: "voter" })).resolves.toEqual({
      ok: false,
      code: "sign_in_required",
    });
    expect(Object.keys((await loaded(room.code)).state.participants)).toEqual([po]);
  });
});

describe("with the room password", () => {
  it("the rule comes first: a right password gets someone refused nothing", async () => {
    const { id: po } = await signedInPo();
    const room = await roomOf(po, DOMAIN_RULE, { password: true });
    const browser = new Browser();
    await browser.signIn("microsoft", person({ tenant: OTHER_TENANT }));
    const right = await browser.access(room.code);
    const wrong = await browser.access(room.code, "not-the-password");
    expect(right).toEqual({ status: 403, body: '{"code":"account_not_allowed"}' });
    expect(wrong).toEqual(right);
    const { rows } = await admin.query("select 1 from room_access where room_id = $1", [room.id]);
    expect(rows).toEqual([]);
    const { rows: tries } = await admin.query<{ password_failures: number }>(
      "select password_failures from room where id = $1",
      [room.id],
    );
    expect(tries[0]?.password_failures).toBe(0);
    expect((await browser.socket().enter(room.code)).ok).toBe(false);
  });

  it("someone who passes the rule still needs the password", async () => {
    const { id: po } = await signedInPo();
    const room = await roomOf(po, DOMAIN_RULE, { password: true });
    const browser = new Browser();
    await browser.signIn("google", person());
    await expect(browser.socket().enter(room.code)).resolves.toEqual({
      ok: false,
      code: "password_required",
    });
    expect(await browser.header(room.code)).toMatchObject({
      name: SECRET_NAME,
      hasPassword: true,
    });
    expect((await browser.access(room.code)).status).toBe(204);
    await browser.sit(room.code, "Both");
  });

  it("a grant from before the rule does not get past it", async () => {
    const { browser: poBrowser, id: po } = await signedInPo();
    const room = await roomOf(po, undefined, { password: true });
    const browser = new Browser();
    await browser.guest();
    expect((await browser.access(room.code)).status).toBe(204);
    const owner = await poBrowser.sit(room.code, "The PO");
    await must(owner.cmd("updateSettings", { patch: { restriction: DOMAIN_RULE } }));
    expect(await browser.socket().enter(room.code)).toEqual(
      refused("sign_in_required", ["example.com"], false),
    );
  });
});

describe("the PO", () => {
  it("always stays, whatever the rule says, and sets a rule they do not meet", async () => {
    const browser = new Browser();
    const po = await browser.signIn("microsoft", person({ tenant: OTHER_TENANT }));
    const room = await roomOf(po);
    const owner = await browser.sit(room.code, "The PO");
    await must(owner.cmd("updateSettings", { patch: { restriction: DOMAIN_RULE } }));
    owner.close();
    await expect(browser.socket().enter(room.code)).resolves.toMatchObject({ ok: true });
    expect(await browser.header(room.code)).toMatchObject({ name: SECRET_NAME });
  });

  it("alone reads the rule's tenant ids", async () => {
    const { browser: poBrowser, id: po } = await signedInPo();
    const room = await roomOf(po, { domains: ["example.com"], tenants: [TENANT] });
    const owner = await poBrowser.sit(room.code, "The PO");
    expect(owner.latest()?.room.settings.restriction).toEqual({
      domains: ["example.com"],
      organisation: true,
      tenants: [TENANT],
    });
    const browser = new Browser();
    await browser.signIn("google", person());
    const colleague = await browser.sit(room.code, "Colleague");
    expect(colleague.latest()?.room.settings.restriction).toEqual({
      domains: ["example.com"],
      organisation: true,
    });
    expect(colleague.frames.join("\n")).not.toContain(TENANT);
  });

  it("must be signed in to set a rule, and only for a provider this install has", async () => {
    const guest = new Browser();
    const po = await guest.guest();
    const room = await roomOf(po);
    const owner = await guest.sit(room.code, "The PO");
    await expect(
      owner.cmd("updateSettings", { patch: { restriction: DOMAIN_RULE } }),
    ).resolves.toEqual({ ok: false, code: "sign_in_required" });
    expect((await loaded(room.code)).state.settings.restriction).toBeUndefined();
  });

  it("is the only one who sets it", async () => {
    const { id: po } = await signedInPo();
    const room = await roomOf(po);
    const browser = new Browser();
    await browser.signIn("google", person());
    const other = await browser.sit(room.code, "Other");
    await expect(
      other.cmd("updateSettings", { patch: { restriction: DOMAIN_RULE } }),
    ).resolves.toEqual({ ok: false, code: "not_owner" });
  });

  it("stores an international domain in its ASCII form, and refuses a malformed one", async () => {
    const { browser: poBrowser, id: po } = await signedInPo();
    const room = await roomOf(po);
    const owner = await poBrowser.sit(room.code, "The PO");
    await must(
      owner.cmd("updateSettings", {
        patch: { restriction: { domains: ["BÜCHER.example"], tenants: [] } },
      }),
    );
    expect((await loaded(room.code)).state.settings.restriction?.domains).toEqual([
      "xn--bcher-kva.example",
    ]);
    for (const domains of [["a@b.com/x"], ["*.example.com"], ["bücher..example"]]) {
      await expect(
        owner.cmd("updateSettings", { patch: { restriction: { domains, tenants: [] } } }),
      ).resolves.toEqual({ ok: false, code: "bad_restriction" });
    }
  });

  it("refuses a character no host holds, however the rest of the entry reads", async () => {
    const { browser: poBrowser, id: po } = await signedInPo();
    const room = await roomOf(po);
    const owner = await poBrowser.sit(room.code, "The PO");
    for (const entry of [
      "bücher.example/x",
      "example.com/ü",
      "example.com#ü",
      "example.com?ü",
      "example.com\\ü",
      "a@bücher.example",
      "bücher.example:80",
      "exam\u00adple.com",
      "bücher\u3002example",
    ]) {
      await expect(
        owner.cmd("updateSettings", { patch: { restriction: { domains: [entry], tenants: [] } } }),
      ).resolves.toEqual({ ok: false, code: "bad_restriction" });
    }
    expect((await loaded(room.code)).state.settings.restriction).toBeUndefined();
  });

  it("removes a rule, and the room is open again", async () => {
    const { browser: poBrowser, id: po } = await signedInPo();
    const room = await roomOf(po, DOMAIN_RULE);
    const owner = await poBrowser.sit(room.code, "The PO");
    await must(owner.cmd("updateSettings", { patch: { restriction: null } }));
    const browser = new Browser();
    await browser.guest();
    await browser.sit(room.code, "A guest");
  });
});

describe("someone already seated", () => {
  it("stays while the socket does, and is counted for the PO, without a name or a reason", async () => {
    const { browser: poBrowser, id: po } = await signedInPo();
    const room = await roomOf(po);
    const owner = await poBrowser.sit(room.code, "The PO");
    const browser = new Browser();
    await browser.guest();
    const seated = await browser.sit(room.code, "A guest");
    const colleagueBrowser = new Browser();
    await colleagueBrowser.signIn("google", person());
    await colleagueBrowser.sit(room.code, "Colleague");

    await must(owner.cmd("updateSettings", { patch: { restriction: DOMAIN_RULE } }));
    await must(seated.cmd("rename", { name: "Still here" }));
    expect((await poBrowser.panel(room.code)).body).toEqual({
      outsiders: 1,
      own: { domain: "example.com", tenant: null },
    });
    expect((await browser.panel(room.code)).status).toBe(403);
  });

  it("is refused at the next enter, and the seat goes there and then, as `leave` takes it", async () => {
    const { browser: poBrowser, id: po } = await signedInPo();
    const room = await roomOf(po);
    const owner = await poBrowser.sit(room.code, "The PO");
    await must(owner.cmd("startRound", { subject: { kind: "none" } }));
    const browser = new Browser();
    const guest = await browser.guest();
    const seated = await browser.sit(room.code, "A guest");
    await seated.waitFor((s) => s.room.round !== null);
    await must(seated.cmd("castVote", { card: "3", round: 1 }));
    await must(owner.cmd("updateSettings", { patch: { restriction: DOMAIN_RULE } }));
    seated.close();
    const before = owner.received.length;
    expect(await browser.socket().enter(room.code)).toEqual(
      refused("sign_in_required", ["example.com"], false),
    );
    const { state } = await loaded(room.code);
    expect(Object.hasOwn(state.participants, guest)).toBe(false);
    expect(state.round?.votes[guest]).toBeUndefined();
    await owner.waitFor((s) => s.room.participants.length === 1, 3000, before);
    expect((await poBrowser.panel(room.code)).body.outsiders).toBe(0);
  });

  it("a refused enter on one tab sends the person's other tabs out as well", async () => {
    const { browser: poBrowser, id: po } = await signedInPo();
    const room = await roomOf(po);
    const owner = await poBrowser.sit(room.code, "The PO");
    const browser = new Browser();
    await browser.guest();
    const seated = await browser.sit(room.code, "A guest");
    await must(owner.cmd("updateSettings", { patch: { restriction: DOMAIN_RULE } }));
    const locked = hears(seated, "locked");
    expect((await browser.socket().enter(room.code)).ok).toBe(false);
    await locked;
  });

  it("cannot sit down again after leaving, and hears `locked`", async () => {
    const { browser: poBrowser, id: po } = await signedInPo();
    const room = await roomOf(po);
    const owner = await poBrowser.sit(room.code, "The PO");
    const browser = new Browser();
    await browser.guest();
    const seated = await browser.sit(room.code, "A guest");
    await must(owner.cmd("updateSettings", { patch: { restriction: DOMAIN_RULE } }));
    const locked = new Promise<void>((resolve) => seated.socket.once("locked", () => resolve()));
    await must(seated.cmd("leave"));
    await locked;
    const before = seated.received.length;
    await must(owner.cmd("rename", { name: "Not for you" }));
    await owner.waitFor((s) => s.room.participants[0]?.name === "Not for you");
    await settled(seated);
    expect(seated.received.length).toBe(before);
    await expect(seated.cmd("join", { name: "Back", role: "voter" })).resolves.toMatchObject({
      ok: false,
    });
  });

  it("cannot become PO, by a hand-over or a claim, and someone who passes can", async () => {
    const { browser: poBrowser, id: po } = await signedInPo();
    const room = await roomOf(po);
    const owner = await poBrowser.sit(room.code, "The PO");
    const browser = new Browser();
    const guest = await browser.guest();
    const seated = await browser.sit(room.code, "A guest");
    const colleagueBrowser = new Browser();
    const colleague = await colleagueBrowser.signIn("google", person());
    const claimer = await colleagueBrowser.sit(room.code, "Colleague");
    await must(owner.cmd("updateSettings", { patch: { restriction: DOMAIN_RULE } }));

    await expect(owner.cmd("transferOwner", { to: guest })).resolves.toEqual({
      ok: false,
      code: "owner_not_allowed",
    });
    // The PO left the table: the role is open to claim, and not to someone the rule refuses.
    await must(owner.cmd("leave"));
    await expect(seated.cmd("claimOwner")).resolves.toEqual({
      ok: false,
      code: "owner_not_allowed",
    });
    expect((await loaded(room.code)).state.ownerId).toBe(po);
    await must(claimer.cmd("claimOwner"));
    expect((await loaded(room.code)).state.ownerId).toBe(colleague);
  });

  it("a hand-over to someone who passes goes through", async () => {
    const { browser: poBrowser, id: po } = await signedInPo();
    const room = await roomOf(po, DOMAIN_RULE);
    const owner = await poBrowser.sit(room.code, "The PO");
    const browser = new Browser();
    const colleague = await browser.signIn("google", person());
    await browser.sit(room.code, "Colleague");
    await must(owner.cmd("transferOwner", { to: colleague }));
    expect((await loaded(room.code)).state.ownerId).toBe(colleague);
  });
});

describe("a visitor on the join form when a rule arrives", () => {
  it("hears `locked` and gets nothing more, unless the rule admits them", async () => {
    const { browser: poBrowser, id: po } = await signedInPo();
    const room = await roomOf(po);
    const owner = await poBrowser.sit(room.code, "The PO");
    const outsider = new Browser();
    await outsider.guest();
    const client = outsider.socket();
    await expect(client.enter(room.code)).resolves.toMatchObject({ ok: true });
    const colleagueBrowser = new Browser();
    await colleagueBrowser.signIn("google", person());
    const colleague = colleagueBrowser.socket();
    await expect(colleague.enter(room.code)).resolves.toMatchObject({ ok: true });

    const locked = new Promise<void>((resolve) => client.socket.once("locked", () => resolve()));
    const before = client.received.length;
    await must(owner.cmd("updateSettings", { patch: { restriction: DOMAIN_RULE } }));
    await locked;
    expect(client.received.length).toBe(before);
    await colleague.waitFor((s) => s.room.settings.restriction !== undefined);
    await must(owner.cmd("rename", { name: "After the rule" }));
    await colleague.waitFor((s) => s.room.participants[0]?.name === "After the rule");
    await settled(client);
    expect(client.received.length).toBe(before);
  });
});

describe("the one invariant: no frame without a judgement of its gate", () => {
  /** A PO at the table, and a guest the domain rule refuses, seated before it. */
  async function seatedOutsider() {
    const { browser: poBrowser, id: po } = await signedInPo();
    const room = await roomOf(po);
    const owner = await poBrowser.sit(room.code, "The PO");
    const browser = new Browser();
    const guest = await browser.guest();
    const seated = await browser.sit(room.code, "An outsider");
    return { room, owner, poBrowser, browser, guest, seated };
  }

  it("a second tab of someone who leaves hears `locked`, and gets nothing more", async () => {
    const { room, owner, poBrowser, browser, guest, seated } = await seatedOutsider();
    const tab = browser.socket();
    await expect(tab.enter(room.code)).resolves.toMatchObject({ ok: true });
    await must(owner.cmd("updateSettings", { patch: { restriction: DOMAIN_RULE } }));
    const lockedHere = hears(seated, "locked");
    const lockedThere = hears(tab, "locked");
    await must(seated.cmd("leave"));
    await Promise.all([lockedHere, lockedThere]);
    const before = tab.received.length;
    await must(owner.cmd("startRound", { subject: { kind: "title", text: "Next round" } }));
    await settled(tab);
    expect(tab.received.length).toBe(before);
    expect(tab.frames.join("\n")).not.toContain("Next round");
    await expect(owner.cmd("kick", { who: guest })).resolves.toEqual({
      ok: false,
      code: "unknown_participant",
    });
    expect((await poBrowser.panel(room.code)).body.outsiders).toBe(0);
  });

  it("someone who leaves through My rooms over HTTP hears `locked` on the socket", async () => {
    const { browser: poBrowser, id: po } = await signedInPo();
    const room = await roomOf(po);
    const owner = await poBrowser.sit(room.code, "The PO");
    const browser = new Browser();
    await browser.signIn("google", outsider());
    const seated = await browser.sit(room.code, "An outsider");
    await must(owner.cmd("updateSettings", { patch: { restriction: DOMAIN_RULE } }));
    const locked = hears(seated, "locked");
    expect((await browser.post(`/api/my-rooms/${room.id}/leave`, {})).status).toBe(204);
    await locked;
    const before = seated.received.length;
    await must(owner.cmd("startRound", { subject: { kind: "title", text: "Next round" } }));
    await settled(seated);
    expect(seated.received.length).toBe(before);
  });

  it("a PO with no seat who loses the role to a claim is read, and goes", async () => {
    const browser = new Browser();
    const po = await browser.signIn("microsoft", person({ tenant: OTHER_TENANT }));
    const room = await roomOf(po);
    const owner = await browser.sit(room.code, "The PO");
    const colleagueBrowser = new Browser();
    await colleagueBrowser.signIn("google", person());
    const colleague = await colleagueBrowser.sit(room.code, "Colleague");
    await must(owner.cmd("updateSettings", { patch: { restriction: DOMAIN_RULE } }));
    await must(owner.cmd("leave"));
    const locked = hears(owner, "locked");
    await must(colleague.cmd("claimOwner"));
    await locked;
    const before = owner.received.length;
    await must(
      colleague.cmd("startRound", { subject: { kind: "title", text: "After the claim" } }),
    );
    await settled(owner);
    expect(owner.received.length).toBe(before);
  });

  it("a PO who entered under the rule holds no judgement of it, so a claim sends them out", async () => {
    const browser = new Browser();
    const po = await browser.signIn("microsoft", person({ tenant: OTHER_TENANT }));
    const room = await roomOf(po, DOMAIN_RULE);
    const owner = browser.socket();
    await expect(owner.enter(room.code)).resolves.toMatchObject({ ok: true });
    const colleagueBrowser = new Browser();
    await colleagueBrowser.signIn("google", person());
    const colleague = await colleagueBrowser.sit(room.code, "Colleague");
    const locked = hears(owner, "locked");
    await must(colleague.cmd("claimOwner"));
    await locked;
    const before = owner.received.length;
    await must(
      colleague.cmd("startRound", { subject: { kind: "title", text: "After the claim" } }),
    );
    await settled(owner);
    expect(owner.received.length).toBe(before);
  });

  it("a visitor read again and let in is not read again for the next frame", async () => {
    const { browser: poBrowser, id: po } = await signedInPo();
    const room = await roomOf(po, DOMAIN_RULE);
    const owner = await poBrowser.sit(room.code, "The PO");
    const browser = new Browser();
    await browser.signIn("google", person());
    const visitor = browser.socket();
    await expect(visitor.enter(room.code)).resolves.toMatchObject({ ok: true });
    await must(
      owner.cmd("updateSettings", {
        patch: { restriction: { domains: ["example.com", "other.example"], tenants: [] } },
      }),
    );
    await visitor.waitFor((s) => s.room.settings.restriction?.domains.length === 2);
    await must(owner.cmd("rename", { name: "Goes straight out" }));
    const { snapshot } = await visitor.waitFor(
      (s) => s.room.participants[0]?.name === "Goes straight out",
    );
    // Read again, it would go out alone, with no causes.
    expect(snapshot.causes).toEqual([{ type: "renamed", who: po }]);
  });

  it("an `enter` that loaded just before the rule committed is read as soon as it is in", async () => {
    const { browser: poBrowser, id: po } = await signedInPo();
    const room = await roomOf(po);
    const owner = await poBrowser.sit(room.code, "The PO");
    const browser = new Browser();
    await browser.guest();
    const client = await connected(browser.socket());
    const locked = hears(client, "locked");
    const hold = holdLoad(room.code);
    const entering = client.enter(room.code);
    await hold.reading;
    await must(owner.cmd("updateSettings", { patch: { restriction: DOMAIN_RULE } }));
    hold.release();
    await expect(entering).resolves.toMatchObject({ ok: true });
    hold.restore();
    await locked;
    const before = client.received.length;
    await must(owner.cmd("startRound", { subject: { kind: "title", text: "After the rule" } }));
    await settled(client);
    expect(client.received.length).toBe(before);
  });

  it("a rule the last load shows is judged, though the first load had none to read for", async () => {
    const { browser: poBrowser, id: po } = await signedInPo();
    const room = await roomOf(po, undefined, { password: true });
    const owner = await poBrowser.sit(room.code, "The PO");
    const browser = new Browser();
    await browser.guest();
    expect((await browser.access(room.code)).status).toBe(204);
    const client = await connected(browser.socket());
    const hold = holdLoad(room.code);
    const entering = client.enter(room.code);
    await hold.reading;
    await must(owner.cmd("updateSettings", { patch: { restriction: DOMAIN_RULE } }));
    hold.release();
    expect(await entering).toEqual(refused("sign_in_required", ["example.com"], false));
    hold.restore();
  });

  it("the rule as the last load has it, not as the first: an enter that passed the old one", async () => {
    const { browser: poBrowser, id: po } = await signedInPo();
    const room = await roomOf(po, DOMAIN_RULE);
    const owner = await poBrowser.sit(room.code, "The PO");
    const browser = new Browser();
    await browser.signIn("google", person());
    const client = await connected(browser.socket());
    const hold = holdLoad(room.code);
    const entering = client.enter(room.code);
    await hold.reading;
    await must(
      owner.cmd("updateSettings", {
        patch: { restriction: { domains: ["other.example"], tenants: [] } },
      }),
    );
    hold.release();
    expect(await entering).toEqual(refused("account_not_allowed", ["other.example"], false));
    hold.restore();
    await settled(client).catch(() => {});
    expect(client.received).toEqual([]);
  });

  it("a socket still at the door gets no frame of a room with a rule", async () => {
    const { browser: poBrowser, id: po } = await signedInPo();
    const room = await roomOf(po, DOMAIN_RULE);
    const owner = await poBrowser.sit(room.code, "The PO");
    const browser = new Browser();
    await browser.guest();
    const client = await connected(browser.socket());
    const hold = holdLoad(room.code);
    const entering = client.enter(room.code);
    await hold.reading;
    await must(owner.cmd("startRound", { subject: { kind: "title", text: "Past the door" } }));
    await must(owner.cmd("rename", { name: "Renamed at the door" }));
    hold.release();
    expect((await entering).ok).toBe(false);
    hold.restore();
    await settled(client).catch(() => {});
    expect(client.received).toEqual([]);
    expect(client.frames.join("\n")).not.toContain("Past the door");
  });

  it("someone the first load refuses never holds a pass, so no frame meets them at a second", async () => {
    const { browser: poBrowser, id: po } = await signedInPo();
    const room = await roomOf(po, DOMAIN_RULE);
    const owner = await poBrowser.sit(room.code, "The PO");
    const browser = new Browser();
    await browser.guest();
    const client = await connected(browser.socket());
    const hold = holdLoad(room.code, 2);
    const entering = client.enter(room.code);
    // The answer comes without a second load; were there one, this frame would fall inside it.
    const first = await Promise.race([
      entering.then(() => "answered"),
      hold.reading.then(() => "held"),
    ]);
    // Answered, the rename's own load must not be the one held.
    if (first === "answered") hold.restore();
    await must(owner.cmd("rename", { name: "Not for the door" }));
    await owner.waitFor((s) => s.room.participants[0]?.name === "Not for the door");
    hold.release();
    expect((await entering).ok).toBe(false);
    hold.restore();
    await settled(client).catch(() => {});
    expect(client.received).toEqual([]);
    expect(client.frames.join(" ")).not.toContain("Not for the door");
  });

  it("a refused socket keeps no pass: a later `enter` that is refused hears nothing meanwhile", async () => {
    const { browser: poBrowser, id: po } = await signedInPo();
    const room = await roomOf(po);
    const owner = await poBrowser.sit(room.code, "The PO");
    const outsider = new Browser();
    await outsider.guest();
    const seated = await outsider.sit(room.code, "An outsider");
    await must(owner.cmd("updateSettings", { patch: { restriction: DOMAIN_RULE } }));

    // Someone who passes, held after the pass, while another visitor is read and refused: the
    // enter answers `busy`, with the socket's pass taken back.
    const browser = new Browser();
    await browser.signIn("google", person());
    const client = await connected(browser.socket());
    const first = holdLoad(room.code, 2);
    const entering = client.enter(room.code);
    await first.reading;
    const locked = hears(seated, "locked");
    await must(seated.cmd("leave"));
    await locked;
    first.release();
    await expect(entering).resolves.toEqual({ ok: false, code: "busy" });
    first.restore();

    await must(
      owner.cmd("updateSettings", {
        patch: { restriction: { domains: ["other.example"], tenants: [] } },
      }),
    );
    await settled(client).catch(() => {});
    const before = client.received.length;
    const second = holdLoad(room.code);
    const again = client.enter(room.code);
    await second.reading;
    await must(
      owner.cmd("startRound", { subject: { kind: "title", text: "Not for the refused" } }),
    );
    second.release();
    expect((await again).ok).toBe(false);
    second.restore();
    await settled(client).catch(() => {});
    expect(client.received.length).toBe(before);
    expect(client.frames.join("\n")).not.toContain("Not for the refused");
  });

  it("a commit that landed with its reply lost: the visitor is read, and hears `locked`", async () => {
    const { browser: poBrowser, id: po } = await signedInPo();
    const room = await roomOf(po);
    const owner = await poBrowser.sit(room.code, "The PO");
    const browser = new Browser();
    await browser.guest();
    const visitor = browser.socket();
    await expect(visitor.enter(room.code)).resolves.toMatchObject({ ok: true });
    const locked = hears(visitor, "locked");
    const store = setup.database.store;
    const commit = store.commitRoom;
    store.commitRoom = async (...args) => {
      await commit(...args);
      store.commitRoom = commit;
      throw new DatabaseError("commit room", "57P01");
    };
    await expect(
      owner.cmd("updateSettings", { patch: { restriction: DOMAIN_RULE } }),
    ).resolves.toEqual({ ok: false, code: "internal" });
    await locked;
    expect((await loaded(room.code)).state.settings.restriction).toEqual(DOMAIN_RULE);
  });

  it("a password the first load did not show is read for on the last", async () => {
    const { browser: poBrowser, id: po } = await signedInPo();
    const room = await roomOf(po, DOMAIN_RULE);
    const owner = await poBrowser.sit(room.code, "The PO");
    const browser = new Browser();
    await browser.signIn("google", person());
    const client = await connected(browser.socket());
    const hold = holdLoad(room.code);
    const entering = client.enter(room.code);
    await hold.reading;
    const put = await poBrowser.go(`/api/rooms/${room.code}/password`, {
      method: "PUT",
      headers: { origin: ORIGIN, "content-type": "application/json" },
      body: JSON.stringify({ password: PASSWORD }),
    });
    expect(put.status).toBe(204);
    hold.release();
    const ack = await entering;
    hold.restore();
    expect(ack.ok).toBe(false);
    await must(owner.cmd("rename", { name: "Behind the password" }));
    await settled(client).catch(() => {});
    expect(client.received).toEqual([]);
  });
});

describe.skipIf(!process.env.TEST_REDIS_URL)("the one invariant across two instances", () => {
  type Instance = { setup: Awaited<ReturnType<typeof setupServer>>; server: PokerServer };
  const started: Instance[] = [];
  let a = "";
  let b = "";

  beforeAll(async () => {
    const shared = testConfig({
      DATABASE_URL: t.url,
      TRUST_PROXY: "1",
      REDIS_URL: process.env.TEST_REDIS_URL ?? "",
      ...KEYS,
    });
    for (const _ of [1, 2]) {
      const own = await setupServer(shared, logs.logger);
      const running = createServer(shared, { ...own.deps, logger: logs.logger });
      await running.listen();
      started.push({ setup: own, server: running });
    }
    a = urlOf((started[0] as Instance).server);
    b = urlOf((started[1] as Instance).server);
  });

  afterAll(async () => {
    for (const client of open.splice(0)) client.close();
    for (const { setup: own, server: running } of started) {
      await running.close();
      await own.dispose?.();
    }
  });

  /** The same person's browser, reaching the other instance. */
  function onB(browser: Browser) {
    const there = new Browser(() => b);
    for (const [name, value] of browser.jar) there.jar.set(name, value);
    return there;
  }

  async function poOnA() {
    const browser = new Browser(() => a);
    const po = await browser.signIn("google", person());
    const room = await roomOf(po);
    return { browser, room, owner: await browser.sit(room.code, "The PO") };
  }

  it("a `leave` on one instance reaches the tab on the other, which gets nothing after", async () => {
    const { room, owner } = await poOnA();
    const browser = new Browser(() => a);
    await browser.guest();
    const seated = await browser.sit(room.code, "An outsider");
    const tab = onB(browser).socket();
    await expect(tab.enter(room.code)).resolves.toMatchObject({ ok: true });
    await must(owner.cmd("updateSettings", { patch: { restriction: DOMAIN_RULE } }));
    await tab.waitFor((s) => s.room.settings.restriction !== undefined);
    const locked = hears(tab, "locked");
    await must(seated.cmd("leave"));
    await locked;
    const before = tab.received.length;
    await must(owner.cmd("startRound", { subject: { kind: "title", text: "Next round" } }));
    await settled(tab);
    expect(tab.received.length).toBe(before);
  });

  it("an HTTP leave on one instance reaches a socket on the other", async () => {
    const { room, owner } = await poOnA();
    const browser = new Browser(() => a);
    await browser.signIn("google", outsider());
    const seated = await onB(browser).sit(room.code, "An outsider");
    await must(owner.cmd("updateSettings", { patch: { restriction: DOMAIN_RULE } }));
    const locked = hears(seated, "locked");
    expect((await browser.post(`/api/my-rooms/${room.id}/leave`, {})).status).toBe(204);
    await locked;
  });

  it("a rule set on one instance reads the visitors of the other", async () => {
    const { room, owner } = await poOnA();
    const browser = new Browser(() => b);
    await browser.guest();
    const visitor = browser.socket();
    await expect(visitor.enter(room.code)).resolves.toMatchObject({ ok: true });
    const locked = hears(visitor, "locked");
    await must(owner.cmd("updateSettings", { patch: { restriction: DOMAIN_RULE } }));
    await locked;
  });

  it("a seat refused on one instance goes, and the person's tab on the other hears it", async () => {
    const { room, owner } = await poOnA();
    const browser = new Browser(() => a);
    await browser.guest();
    const seated = await browser.sit(room.code, "An outsider");
    await must(owner.cmd("updateSettings", { patch: { restriction: DOMAIN_RULE } }));
    const locked = hears(seated, "locked");
    const there = onB(browser).socket();
    expect((await there.enter(room.code)).ok).toBe(false);
    await locked;
    expect(Object.keys((await loaded(room.code)).state.participants)).toHaveLength(1);
  });

  it("a new password whose signal was lost reaches a visitor already being read", async () => {
    const poBrowser = new Browser(() => a);
    const po = await poBrowser.signIn("google", person());
    const room = await roomOf(po, undefined, { password: true });
    const owner = await poBrowser.sit(room.code, "The PO");
    const onInstanceB = onB(poBrowser).socket();
    await must(onInstanceB.enter(room.code));
    const browser = new Browser(() => b);
    await browser.signIn("google", person());
    expect((await browser.access(room.code)).status).toBe(204);
    const visitor = browser.socket();
    await must(visitor.enter(room.code));
    const before = visitor.received.length;
    let locked = false;
    visitor.socket.once("locked", () => {
      locked = true;
    });

    // B reads the visitor for the rule: the grant comes back at once, the account read waits.
    const locker = await admin.connect();
    await locker.query("begin");
    await locker.query("lock table account in access exclusive mode");
    await must(owner.cmd("updateSettings", { patch: { restriction: DOMAIN_RULE } }));
    await vi.waitFor(async () => {
      const { rows } = await admin.query(
        "select count(*)::int as n from pg_locks where relation = 'account'::regclass and not granted",
      );
      expect((rows[0] as { n: number }).n).toBeGreaterThan(0);
    });

    // The password changes on A, and B never hears: the visitor's grant goes.
    const { setup: own, server: running } = started[0] as Instance;
    const lost = vi.spyOn(running.io, "serverSideEmit").mockReturnValue(true);
    const sync = own.deps?.handlers as unknown as RoomSync;
    await must(sync.changePassword(room.code, po, await hashPassword("a-new-password")));
    lost.mockRestore();
    expect(await countOf("room_access", "room_id", room.id)).toBe(1);

    // The next version reaches B with a gap, so it goes out blind, past the visitor being read.
    const ack = await owner.cmd("rename", { name: "Next" });
    const version = ack.ok ? ack.version : 0;
    await onInstanceB.waitFor((snapshot) => snapshot.version >= version);
    expect(visitor.received.length).toBe(before);

    await locker.query("commit");
    locker.release();
    await vi.waitFor(() => expect(locked).toBe(true));

    await must(owner.cmd("startRound", { subject: { kind: "title", text: "Behind it" } }));
    await settled(onInstanceB);
    await settled(visitor);
    expect(visitor.received.length).toBe(before);
    expect(visitor.frames.join("")).not.toContain("Behind it");
    await expect(browser.socket().enter(room.code)).resolves.toMatchObject({
      ok: false,
      code: "password_required",
    });
  });
});

describe("what a stored rule that is not a rule does: it refuses", () => {
  for (const [name, rule] of [
    ["a JSON null", "null"],
    ["domains as a string", '{"domains":"example.com","tenants":[]}'],
    ["a list that holds a number", '{"domains":[1],"tenants":[]}'],
    ["an empty object", "{}"],
  ] as const) {
    it(`${name}: everyone but the PO, at every door`, async () => {
      const { browser: poBrowser, id: po } = await signedInPo();
      const room = await roomOf(po);
      await storeRaw(room.id, rule);
      const browser = new Browser();
      await browser.signIn("google", person());
      await expect(browser.socket().enter(room.code)).resolves.toEqual(
        refused("restriction_unavailable", [], false),
      );
      expect(await browser.header(room.code)).toEqual({
        code: room.code,
        name: null,
        hasPassword: false,
      });
      expect((await poBrowser.socket().enter(room.code)).ok).toBe(true);
      expect((await poBrowser.header(room.code)).name).toBe(SECRET_NAME);
    });
  }
});

describe("what an account proves", () => {
  it("not an address whose domain is only what a URL parser reads into it", async () => {
    const { id: po } = await signedInPo();
    const room = await roomOf(po, DOMAIN_RULE);
    for (const email of [
      "a@example.com/ü",
      "a@example.com#ü",
      "a@example.com?ü",
      "a@example.com\\ü",
      "a@exam\u00adple.com",
    ]) {
      const browser = new Browser();
      await browser.signIn("google", person({ email }));
      expect(await browser.socket().enter(room.code)).toEqual(
        refused("account_not_allowed", ["example.com"], false),
      );
    }
  });

  it("an international address, by its ASCII form", async () => {
    const { id: po } = await signedInPo();
    const room = await roomOf(po, { domains: ["xn--bcher-kva.example"], tenants: [] });
    const browser = new Browser();
    await browser.signIn("google", person({ email: "a@bücher.example" }));
    await browser.sit(room.code, "Books");
  });

  it("a tenant only from a Microsoft account, whatever another account's row holds", async () => {
    const { id: po } = await signedInPo();
    const room = await roomOf(po, TENANT_RULE);
    const browser = new Browser();
    const id = await browser.signIn("google", person());
    await admin.query("update account set tenant_id = $1 where user_id = $2", [TENANT, id]);
    expect(await browser.socket().enter(room.code)).toEqual(
      refused("account_not_allowed", [], true),
    );
  });

  it("stores Google's `hd` beside the account, and no rule reads it", async () => {
    const { id: po } = await signedInPo();
    const room = await roomOf(po, DOMAIN_RULE);
    const browser = new Browser();
    const id = await browser.signIn(
      "google",
      person({ email: "a@elsewhere.example", hostedDomain: "example.com" }),
    );
    const { rows } = await admin.query<{ hosted_domain: string | null }>(
      "select hosted_domain from account where user_id = $1",
      [id],
    );
    expect(rows).toEqual([{ hosted_domain: "example.com" }]);
    expect((await browser.socket().enter(room.code)).ok).toBe(false);
    expect((await new Browser().signIn("microsoft", person())) !== "").toBe(true);
    const { rows: others } = await admin.query<{ n: string }>(
      "select count(*) as n from account where provider_id = 'microsoft' and hosted_domain is not null",
    );
    expect(others).toEqual([{ n: "0" }]);
  });
});

describe("a sign-in older than a rule asks for", () => {
  it("must sign in again, says so, and keeps the seat for when they do", async () => {
    const { browser: poBrowser, id: po } = await signedInPo();
    const room = await roomOf(po, DOMAIN_RULE, { password: true });
    await poBrowser.sit(room.code, "The PO");
    const browser = new Browser();
    const id = await browser.signIn("google", person());
    expect((await browser.access(room.code)).status).toBe(204);
    const seated = await browser.sit(room.code, "A colleague");
    seated.close();
    await ageSession(id, 31);

    expect(await browser.socket().enter(room.code)).toEqual(
      refused("session_too_old", ["example.com"], false),
    );
    expect(await browser.access(room.code)).toEqual({
      status: 403,
      body: '{"code":"session_too_old"}',
    });
    expect(await browser.header(room.code)).toEqual({
      code: room.code,
      name: null,
      hasPassword: false,
    });
    expect((await loaded(room.code)).state.participants[id]?.name).toBe("A colleague");
    await admin.query(`update session set created_at = now() where user_id = $1`, [id]);
    await expect(browser.socket().enter(room.code)).resolves.toMatchObject({ ok: true });
  });

  it("not before 30 days, and not its PO, and not in a room with no rule", async () => {
    const browser = new Browser();
    const po = await browser.signIn("google", person());
    const ruled = await roomOf(po, DOMAIN_RULE);
    const open = await roomOf(po);
    await ageSession(po, 400);
    await expect(browser.socket().enter(ruled.code)).resolves.toMatchObject({ ok: true });

    const other = new Browser();
    const id = await other.signIn("google", person());
    await ageSession(id, 29);
    await expect(other.socket().enter(ruled.code)).resolves.toMatchObject({ ok: true });
    await ageSession(id, 31);
    await expect(other.socket().enter(open.code)).resolves.toMatchObject({ ok: true });
  });

  it("a visitor's socket is read when a rule arrives, and a claim is refused", async () => {
    const { browser: poBrowser, id: po } = await signedInPo();
    const room = await roomOf(po);
    const owner = await poBrowser.sit(room.code, "The PO");
    const visitorBrowser = new Browser();
    const visitorId = await visitorBrowser.signIn("google", person());
    await ageSession(visitorId, 31);
    const visitor = visitorBrowser.socket();
    await expect(visitor.enter(room.code)).resolves.toMatchObject({ ok: true });
    const seatedBrowser = new Browser();
    const seatedId = await seatedBrowser.signIn("google", person());
    await ageSession(seatedId, 31);
    const seated = await seatedBrowser.sit(room.code, "Old session");

    const locked = hears(visitor, "locked");
    await must(owner.cmd("updateSettings", { patch: { restriction: DOMAIN_RULE } }));
    await locked;
    await must(owner.cmd("leave"));
    await expect(seated.cmd("claimOwner")).resolves.toEqual({
      ok: false,
      code: "owner_not_allowed",
    });
  });

  it("is asked of a hand-over too: whom the door keeps out is not given the role", async () => {
    const { browser: poBrowser, id: po } = await signedInPo();
    const room = await roomOf(po, DOMAIN_RULE);
    const owner = await poBrowser.sit(room.code, "The PO");
    const browser = new Browser();
    const id = await browser.signIn("google", person());
    (await browser.sit(room.code, "Left the company")).close();
    await ageSession(id, 31);
    const door = refused("session_too_old", ["example.com"], false);
    const notAllowed = { ok: false, code: "owner_not_allowed" };

    expect(await browser.socket().enter(room.code)).toEqual(door);
    expect((await loaded(room.code)).state.participants[id]?.name).toBe("Left the company");
    await expect(owner.cmd("transferOwner", { to: id })).resolves.toEqual(notAllowed);
    const { state } = await loaded(room.code);
    expect(state.ownerId).toBe(po);
    expect(state.settings.restriction).toEqual(DOMAIN_RULE);
    expect(await browser.socket().enter(room.code)).toEqual(door);

    // A young session that ended counts for nothing.
    await admin.query(
      `update session set created_at = now(), expires_at = now() - interval '1 minute'
        where user_id = $1`,
      [id],
    );
    await expect(owner.cmd("transferOwner", { to: id })).resolves.toEqual(notAllowed);
    await admin.query(
      `update session set expires_at = now() + interval '1 day' where user_id = $1`,
      [id],
    );
    await must(owner.cmd("transferOwner", { to: id }));
    expect((await loaded(room.code)).state.ownerId).toBe(id);
  });

  it("a hand-over needs a live session, and asks nothing in a room with no rule", async () => {
    const { browser: poBrowser, id: po } = await signedInPo();
    const room = await roomOf(po, DOMAIN_RULE);
    const owner = await poBrowser.sit(room.code, "The PO");
    const browser = new Browser();
    const id = await browser.signIn("google", person());
    (await browser.sit(room.code, "Signed out everywhere")).close();
    await admin.query(`delete from session where user_id = $1`, [id]);
    await expect(owner.cmd("transferOwner", { to: id })).resolves.toEqual({
      ok: false,
      code: "owner_not_allowed",
    });
    expect((await loaded(room.code)).state.ownerId).toBe(po);

    await must(owner.cmd("updateSettings", { patch: { restriction: null } }));
    await must(owner.cmd("transferOwner", { to: id }));
    expect((await loaded(room.code)).state.ownerId).toBe(id);
  });
});

describe("how many times a rule can be set", () => {
  it("is limited per account, a refused commit costs nothing, and taking it off is free", async () => {
    const { browser: poBrowser, id: po } = await signedInPo();
    const room = await roomOf(po);
    const owner = await poBrowser.sit(room.code, "The PO");
    await expect(
      owner.cmd("updateSettings", { patch: { restriction: { domains: ["*"], tenants: [] } } }),
    ).resolves.toEqual({ ok: false, code: "bad_restriction" });
    for (let commit = 0; commit < RULE_CHANGE_LIMIT.max; commit += 1) {
      await must(
        owner.cmd("updateSettings", {
          patch: { restriction: { domains: [`d${commit}.example`], tenants: [] } },
        }),
      );
    }
    await expect(
      owner.cmd("updateSettings", { patch: { restriction: DOMAIN_RULE } }),
    ).resolves.toEqual({ ok: false, code: "rate_limited" });
    await must(owner.cmd("updateSettings", { patch: { restriction: null } }));
    expect((await loaded(room.code)).state.settings.restriction).toBeUndefined();
  });

  it("the rule already there stores nothing, so it costs nothing", async () => {
    const { browser: poBrowser, id: po } = await signedInPo();
    const room = await roomOf(po);
    const owner = await poBrowser.sit(room.code, "The PO");
    const patch = { restriction: DOMAIN_RULE };
    const first = await owner.cmd("updateSettings", { patch });
    expect(first.ok).toBe(true);
    for (let again = 0; again < RULE_CHANGE_LIMIT.max + 2; again += 1) {
      await expect(owner.cmd("updateSettings", { patch })).resolves.toEqual(first);
    }
    for (let commit = 1; commit < RULE_CHANGE_LIMIT.max; commit += 1) {
      await must(
        owner.cmd("updateSettings", {
          patch: { restriction: { domains: [`d${commit}.example`], tenants: [] } },
        }),
      );
    }
    await expect(owner.cmd("updateSettings", { patch })).resolves.toEqual({
      ok: false,
      code: "rate_limited",
    });
  });
});

describe("removing everyone who would not pass", () => {
  it("takes those seats through `apply`, leaves the others, and says how many, never who", async () => {
    const { browser: poBrowser, id: po } = await signedInPo();
    const room = await roomOf(po);
    const owner = await poBrowser.sit(room.code, "The PO");
    const outsider = new Browser();
    const guest = await outsider.guest();
    const seated = await outsider.sit(room.code, "An outsider");
    const colleagueBrowser = new Browser();
    const colleague = await colleagueBrowser.signIn("google", person());
    await colleagueBrowser.sit(room.code, "Colleague");
    await must(owner.cmd("updateSettings", { patch: { restriction: DOMAIN_RULE } }));
    expect((await poBrowser.panel(room.code)).body.outsiders).toBe(1);

    const kicked = hears(seated, "kicked");
    const answer = await poBrowser.post(`/api/rooms/${room.code}/restriction/remove-outsiders`, {});
    expect(answer.status).toBe(200);
    expect(answer.headers.get("cache-control")).toBe("no-store");
    expect(await answer.json()).toEqual({ removed: 1 });
    await kicked;
    const { state } = await loaded(room.code);
    expect(Object.keys(state.participants).sort()).toEqual([po, colleague].sort());
    expect(Object.hasOwn(state.participants, guest)).toBe(false);
    expect((await poBrowser.panel(room.code)).body.outsiders).toBe(0);
  });

  it("spares someone a rule taken off while the removal was on its way", async () => {
    const { browser: poBrowser, id: po } = await signedInPo();
    const room = await roomOf(po);
    const owner = await poBrowser.sit(room.code, "The PO");
    const outsider = new Browser();
    const guest = await outsider.guest();
    await outsider.sit(room.code, "An outsider");
    await must(owner.cmd("updateSettings", { patch: { restriction: DOMAIN_RULE } }));
    const hold = holdLoad(room.code);
    const removing = poBrowser.post(`/api/rooms/${room.code}/restriction/remove-outsiders`, {});
    await hold.reading;
    await must(owner.cmd("updateSettings", { patch: { restriction: null } }));
    hold.release();
    expect(await (await removing).json()).toEqual({ removed: 0 });
    hold.restore();
    expect((await loaded(room.code)).state.participants[guest]?.name).toBe("An outsider");
  });

  it("is the PO's, from the page's origin, with nobody to remove in a room with no rule", async () => {
    const { browser: poBrowser, id: po } = await signedInPo();
    const room = await roomOf(po);
    const path = `/api/rooms/${room.code}/restriction/remove-outsiders`;
    const other = new Browser();
    await other.guest();
    expect((await other.post(path, {})).status).toBe(403);
    expect((await new Browser().post(path, {})).status).toBe(401);
    const foreign = await poBrowser.go(path, {
      method: "POST",
      headers: { origin: "https://elsewhere.example", "content-type": "application/json" },
      body: "{}",
    });
    expect(foreign.status).toBe(403);
    expect(await (await poBrowser.post(path, {})).json()).toEqual({ removed: 0 });
    for (let press = 1; press < RESTRICTION_REMOVE_LIMIT.max; press += 1) {
      await poBrowser.post(path, {});
    }
    expect((await poBrowser.post(path, {})).status).toBe(429);
  });
});

describe('"My rooms" and a room with a rule', () => {
  /** A room its keeper left, with a rule on it, whose role someone the rule passes claimed. */
  async function handedOver() {
    const keeperBrowser = new Browser();
    const keeper = await keeperBrowser.signIn("google", outsider());
    const room = await roomOf(keeper);
    await admin.query(
      `insert into round_history
         (room_id, number, subject, deck, votes, stats, started_at, revealed_at, finished_at)
       values ($1, 1, '{}', '{}', '{"kind":"anonymous","cards":[]}', '{}', now(), now(), now())`,
      [room.id],
    );
    const owner = await keeperBrowser.sit(room.code, "The maker");
    const colleagueBrowser = new Browser();
    const colleague = await colleagueBrowser.signIn("google", person());
    const newPo = await colleagueBrowser.sit(room.code, "Colleague");
    await must(owner.cmd("updateSettings", { patch: { restriction: DOMAIN_RULE } }));
    await must(owner.cmd("leave"));
    await must(newPo.cmd("claimOwner"));
    await must(newPo.cmd("startRound", { subject: { kind: "none" } }));
    owner.close();
    return { room, keeperBrowser, colleagueBrowser, colleague, newPo };
  }

  const list = async (browser: Browser) => (await browser.go("/api/my-rooms")).json();

  it("leaves off a room that would refuse the person, and its name with it", async () => {
    const { browser: poBrowser, id: po } = await signedInPo();
    const room = await roomOf(po);
    const owner = await poBrowser.sit(room.code, "The PO");
    const browser = new Browser();
    await browser.signIn("google", outsider());
    await browser.sit(room.code, "An outsider");
    expect(JSON.stringify(await list(browser))).toContain(room.code);
    await must(owner.cmd("updateSettings", { patch: { restriction: DOMAIN_RULE } }));
    const text = JSON.stringify(await list(browser));
    expect(text).not.toContain(room.code);
    expect(text).not.toContain(SECRET_NAME);
    // The seat is still theirs to give up.
    expect((await browser.post(`/api/my-rooms/${room.id}/leave`, {})).status).toBe(204);
  });

  const remove = (browser: Browser, id: string) =>
    browser.go(`/api/my-rooms/${id}`, { method: "DELETE", headers: { origin: ORIGIN } });

  it("leaves a keeper the rule refuses with no row and no delete, and the room whole", async () => {
    const { room, keeperBrowser } = await handedOver();
    const text = JSON.stringify(await list(keeperBrowser));
    expect(await list(keeperBrowser)).toMatchObject({ rooms: [] });
    expect(text).not.toContain(room.code);
    expect(text).not.toContain(SECRET_NAME);
    // The same answer as for anyone who is not the PO, and nothing about the room beyond it.
    const refused = await remove(keeperBrowser, room.id);
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual({ code: "not_owner" });
    expect(refused.headers.get("cache-control")).toBe("no-store");
    await expect(setup.database.store.loadRoom(room.code)).resolves.not.toBeNull();
    expect(await countOf("round_history", "room_id", room.id)).toBe(1);
  });

  it("answers a refused keeper's delete as it answers a seat that holds no role", async () => {
    const { room, keeperBrowser, colleagueBrowser } = await handedOver();
    const refusedKeeper = await remove(keeperBrowser, room.id);
    const seated = await remove(colleagueBrowser, room.id);
    // The colleague holds the role, not the right; the keeper holds the right, not the role.
    expect(await seated.json()).toEqual({ code: "not_keeper" });
    expect(await refusedKeeper.json()).toEqual({ code: "not_owner" });
    const stranger = new Browser();
    await stranger.signIn("google", person());
    const unknown = await remove(stranger, room.id);
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toEqual({ code: "room_not_found" });
  });

  it("brings the row and the right back once the rule no longer refuses the keeper", async () => {
    const { room, keeperBrowser, newPo } = await handedOver();
    expect(await list(keeperBrowser)).toMatchObject({ rooms: [] });
    // The rule changes to one that lets the keeper's address in, and then it goes altogether.
    await must(
      newPo.cmd("updateSettings", {
        patch: { restriction: { domains: ["elsewhere.example"], tenants: [] } },
      }),
    );
    expect(await list(keeperBrowser)).toMatchObject({
      rooms: [{ id: room.id, name: SECRET_NAME, keeper: true, owned: false }],
    });
    await must(newPo.cmd("updateSettings", { patch: { restriction: null } }));
    const row = ((await list(keeperBrowser)) as { rooms: Record<string, unknown>[] }).rooms[0];
    expect(row).toMatchObject({ id: room.id, name: SECRET_NAME, keeper: true, owned: false });
    // Still no delete without the role; the role comes back by a claim, and then the delete is theirs.
    expect((await remove(keeperBrowser, room.id)).status).toBe(403);
    await must(newPo.cmd("leave"));
    const seat = await keeperBrowser.sit(room.code, "The maker");
    await must(seat.cmd("claimOwner"));
    expect((await remove(keeperBrowser, room.id)).status).toBe(204);
    await expect(setup.database.store.loadRoom(room.code)).resolves.toBeNull();
  });

  it("keeps a room for the keeper the rule refuses: retention follows the keeper, not the rule", async () => {
    const { room, newPo } = await handedOver();
    // The role's holder is a guest here, so that only the keeper's account can keep the room.
    const guest = await new Browser().guest();
    await admin.query(
      `update room set owner_user_id = $2, live = jsonb_set(live, '{ownerId}', to_jsonb($2::text))
       where id = $1`,
      [room.id, guest],
    );
    newPo.close();
    // The room is the sync's to say empty: `setupServer` hands it over as the socket handlers.
    const sync = setup.deps?.handlers as unknown as RoomSync;
    await expect.poll(() => sync.occupiedRooms()).not.toContain(room.id);
    await admin.query("update room set last_active_at = '2020-01-01T00:00:00Z' where id = $1", [
      room.id,
    ]);
    await setup.retention.runNow();
    expect(await countOf("room", "id", room.id)).toBe(1);
    expect(await countOf("round_history", "room_id", room.id)).toBe(1);
  });

  it("a keeper the rule passes takes the role back to delete, as without a rule", async () => {
    const browser = new Browser();
    const keeper = await browser.signIn("google", person());
    const room = await roomOf(keeper);
    const owner = await browser.sit(room.code, "The maker");
    const colleagueBrowser = new Browser();
    await colleagueBrowser.signIn("google", person());
    const colleague = await colleagueBrowser.sit(room.code, "Colleague");
    await must(owner.cmd("updateSettings", { patch: { restriction: DOMAIN_RULE } }));
    await must(owner.cmd("leave"));
    await must(colleague.cmd("claimOwner"));
    const refused = await browser.go(`/api/my-rooms/${room.id}`, {
      method: "DELETE",
      headers: { origin: ORIGIN },
    });
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual({ code: "not_owner" });
    await expect(setup.database.store.loadRoom(room.code)).resolves.not.toBeNull();
  });

  it("hides the rule's rooms from a sign-in too old for them, and says so", async () => {
    const { browser: poBrowser, id: po } = await signedInPo();
    const room = await roomOf(po, DOMAIN_RULE);
    await poBrowser.sit(room.code, "The PO");
    const browser = new Browser();
    const id = await browser.signIn("google", person());
    await browser.sit(room.code, "Colleague");
    await ageSession(id, 31);
    expect(await list(browser)).toMatchObject({ rooms: [], signInAgain: true });
    await ageSession(po, 31);
    expect(await list(poBrowser)).toMatchObject({ rooms: [{ name: SECRET_NAME }] });
  });
});

describe("a sign-in with a rule on the room", () => {
  it("a refused guest signs in with the right account and sits down", async () => {
    const { id: po } = await signedInPo();
    const room = await roomOf(po, DOMAIN_RULE);
    const browser = new Browser();
    await browser.guest();
    expect((await browser.socket().enter(room.code)).ok).toBe(false);
    await browser.signIn("google", person(), `/r/${room.code}`);
    await browser.sit(room.code, "Now signed in");
  });

  it("a seated guest's seat moves to the account, which still has to pass", async () => {
    const { browser: poBrowser, id: po } = await signedInPo();
    const room = await roomOf(po);
    const owner = await poBrowser.sit(room.code, "The PO");
    const browser = new Browser();
    const guest = await browser.guest();
    await browser.sit(room.code, "A guest");
    await must(owner.cmd("updateSettings", { patch: { restriction: DOMAIN_RULE } }));

    const account = await browser.signIn(
      "microsoft",
      person({ tenant: OTHER_TENANT }),
      `/r/${room.code}`,
    );
    const { state } = await loaded(room.code);
    expect(Object.hasOwn(state.participants, guest)).toBe(false);
    expect(state.participants[account]?.name).toBe("A guest");
    // The seat moved, and it lets nobody around the rule: refused, it goes.
    expect(await browser.socket().enter(room.code)).toEqual(
      refused("account_not_allowed", ["example.com"], false),
    );
    expect(Object.keys((await loaded(room.code)).state.participants)).toEqual([po]);
  });

  it("a person who signs out mid-room is a guest, and the account's seat waits", async () => {
    const { id: po } = await signedInPo();
    const room = await roomOf(po, DOMAIN_RULE);
    const browser = new Browser();
    const account = await browser.signIn("google", person());
    const seated = await browser.sit(room.code, "Colleague");
    seated.close();
    expect((await browser.post("/api/auth/sign-out", {})).status).toBe(200);
    await browser.guest();
    expect(await browser.socket().enter(room.code)).toEqual(
      refused("sign_in_required", ["example.com"], false),
    );
    expect((await loaded(room.code)).state.participants[account]?.name).toBe("Colleague");
  });
});

describe("a rule whose provider is gone", () => {
  /** A second server on this database with only `env`'s provider keys. */
  async function withoutKeys(env: Record<string, string>, run: (base: string) => Promise<void>) {
    const own = testConfig({ DATABASE_URL: t.url, TRUST_PROXY: "1", ...env });
    const ownSetup = await setupServer(own, logs.logger);
    const ownServer = createServer(own, { ...ownSetup.deps, logger: logs.logger });
    await ownServer.listen();
    try {
      await run(urlOf(ownServer));
    } finally {
      await ownServer.close();
      await ownSetup.database.close();
    }
  }

  it("refuses everyone but the PO, signed in or not, and says so", async () => {
    const { browser: poBrowser, id: po } = await signedInPo();
    const room = await roomOf(po, DOMAIN_RULE);
    const colleague = new Browser();
    await colleague.signIn("google", person());
    await withoutKeys({}, async (base) => {
      const there = new Browser(() => base);
      there.jar.clear();
      for (const [name, value] of colleague.jar) there.jar.set(name, value);
      await expect(there.socket().enter(room.code)).resolves.toEqual(
        refused("restriction_unavailable", [], false),
      );
      const guest = new Browser(() => base);
      await guest.guest();
      await expect(guest.socket().enter(room.code)).resolves.toEqual(
        refused("restriction_unavailable", [], false),
      );
      expect(await guest.header(room.code)).toEqual({
        code: room.code,
        name: null,
        hasPassword: false,
      });

      const owner = new Browser(() => base);
      for (const [name, value] of poBrowser.jar) owner.jar.set(name, value);
      const client = await owner.sit(room.code, "The PO");
      // The PO cannot set a rule nothing can check, and can take this one off.
      await expect(
        client.cmd("updateSettings", { patch: { restriction: TENANT_RULE } }),
      ).resolves.toEqual({ ok: false, code: "restriction_unavailable" });
      await must(client.cmd("updateSettings", { patch: { restriction: null } }));
    });
  });

  it("with one provider left, still offers what can work", async () => {
    const { id: po } = await signedInPo();
    const room = await roomOf(po, { domains: ["example.com"], tenants: [TENANT] });
    const { MICROSOFT_CLIENT_ID, MICROSOFT_CLIENT_SECRET, MICROSOFT_TENANT_ID } = KEYS;
    await withoutKeys(
      { MICROSOFT_CLIENT_ID, MICROSOFT_CLIENT_SECRET, MICROSOFT_TENANT_ID },
      async (base) => {
        const guest = new Browser(() => base);
        await guest.guest();
        await expect(guest.socket().enter(room.code)).resolves.toEqual(
          refused("sign_in_required", [], true),
        );
      },
    );
  });
});

describe("the panel's read", () => {
  it("is the PO's, and limited", async () => {
    const { browser: poBrowser, id: po } = await signedInPo();
    const room = await roomOf(po);
    expect((await poBrowser.panel(room.code)).body).toEqual({
      outsiders: 0,
      own: { domain: "example.com", tenant: null },
    });
    expect((await new Browser().panel(room.code)).status).toBe(401);
    for (let read = 1; read < RESTRICTION_READ_LIMIT.max; read += 1) {
      await poBrowser.panel(room.code);
    }
    expect((await poBrowser.panel(room.code)).status).toBe(429);
  });

  it("answers an unknown room as one, and a Microsoft PO's own tenant", async () => {
    const browser = new Browser();
    const po = await browser.signIn("microsoft", person());
    expect((await browser.panel(roomCode())).status).toBe(404);
    const room = await roomOf(po);
    expect((await browser.panel(room.code)).body).toEqual({
      outsiders: 0,
      own: { domain: null, tenant: TENANT },
    });
  });
});
