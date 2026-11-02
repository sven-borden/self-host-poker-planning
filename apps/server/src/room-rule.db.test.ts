/**
 * A room limited to an email domain or a Microsoft tenant (#50, ADR-028), against a real Postgres
 * and the stand-in for the providers: real sign-ins, real sockets, real frames.
 *
 * What it holds: a domain is met only by an address Google verified, and a Microsoft address
 * never meets one; a tenant is met only by `account.tenant_id`; a guest is asked to sign in; a
 * refused person gets no snapshot, no room name and nothing of the password; the rule goes
 * before the password, at `enter`, at `join` and at `/access`; the PO always stays; a seat stays
 * while its socket does and is refused at the next enter; a visitor leaves when a rule arrives;
 * nobody the rule refuses becomes PO; a rule whose provider is gone fails closed; a guest's seat
 * and a refused guest both come through a sign-in as they should; and no address, tenant or
 * room code reaches a log line, or a frame for anyone who should not hold it.
 */
import { createRoom, type Restriction, type RoomState } from "@pp/domain";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Config } from "./config.ts";
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
import { RESTRICTION_READ_LIMIT } from "./room-rule-api.ts";
import { createServer, type PokerServer } from "./server.ts";
import { setupServer } from "./setup.ts";
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

  it("is refused at the next enter, and the seat and its vote stay", async () => {
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
    expect(await browser.socket().enter(room.code)).toEqual(
      refused("sign_in_required", ["example.com"], false),
    );
    const { state } = await loaded(room.code);
    expect(state.participants[guest]?.name).toBe("A guest");
    expect(state.round?.votes[guest]?.card).toBe("3");
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
    expect(client.received.length).toBe(before);
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
    // The seat moved, and it lets nobody around the rule.
    expect(await browser.socket().enter(room.code)).toEqual(
      refused("account_not_allowed", ["example.com"], false),
    );
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
