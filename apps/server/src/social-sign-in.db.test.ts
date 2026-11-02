/**
 * Sign-in with Google and Microsoft against a real Postgres and a real HTTP stand-in for the
 * providers (`fake-oidc.ts`): a real redirect, a real callback, the real `state` row and
 * cookie, PKCE at the token address. Better Auth runs its own provider code, against the
 * providers' own addresses: this file's `fetch` sends those to the fake.
 *
 * What it holds: the allowlist, the narrow body, the return path, that no provider token is
 * stored, that a room's code never goes to a provider, that a guest loses nothing, that a
 * failed callback ends on a page with a code, that the rate limit holds, that no snapshot gains
 * an email, that retention keeps a signed-in owner's room, and that no code, token, `state` or
 * secret reaches a log line, stdout or stderr (all captured for the whole file).
 */
import { format } from "node:util";
import { createRoom } from "@pp/domain";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  type MockInstance,
  vi,
} from "vitest";
import { createAuth } from "./auth.ts";
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
import { createServer, type PokerServer } from "./server.ts";
import { setupServer } from "./setup.ts";
import { SOCIAL_SIGN_IN_LIMIT } from "./social-sign-in.ts";
import { roomCode, signInGuest, testClient as socketClient } from "./sync/test-support.ts";
import { collectLogs, testConfig, VALID_ENV } from "./test-support.ts";

const ORIGIN = VALID_ENV.BASE_URL;
const COOKIE = "pp.session_token";
const STATE_COOKIE = "pp.state";
const KEYS = {
  GOOGLE_CLIENT_ID: "test-google-client-id",
  GOOGLE_CLIENT_SECRET: "test-google-secret-do-not-log",
  MICROSOFT_CLIENT_ID: "test-microsoft-client-id",
  MICROSOFT_CLIENT_SECRET: "test-microsoft-secret-do-not-log",
  MICROSOFT_TENANT_ID: "organizations",
} as const;
const TENANT = "11111111-2222-3333-4444-555555555555";

const logs = collectLogs("trace");
const printed: string[] = [];
const captures: MockInstance[] = [];
let t: TestDatabase;
let admin: ReturnType<typeof testClient>;
let config: Config;
let fake: FakeOidc;
let restoreFetch: () => void;
let server: PokerServer;
let setup: Awaited<ReturnType<typeof setupServer>>;
/** Values that must reach no log line. */
const secrets: string[] = [KEYS.GOOGLE_CLIENT_SECRET, KEYS.MICROSOFT_CLIENT_SECRET];

beforeAll(async () => {
  for (const method of ["log", "info", "warn", "error", "debug", "trace"] as const) {
    captures.push(
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        printed.push(format(...args));
      }),
    );
  }
  for (const stream of [process.stdout, process.stderr]) {
    captures.push(
      vi.spyOn(stream, "write").mockImplementation((chunk: unknown) => {
        printed.push(String(chunk));
        return true;
      }),
    );
  }
  fake = await startFakeOidc();
  restoreFetch = routeProvidersTo(fake.origin);
  t = await createTestDatabase();
  admin = testClient(t.url);
  config = testConfig({ DATABASE_URL: t.url, LOG_LEVEL: "trace", ...KEYS });
  setup = await setupServer(config, logs.logger);
  server = createServer(config, { ...setup.deps, logger: logs.logger });
  await server.listen();
});

let addressSeq = 0;
/** A client address of its own for each test: limits are per address. */
let address = "";
beforeEach(() => {
  addressSeq += 1;
  address = `198.51.100.${addressSeq}`;
});

afterEach(() => {
  fake.failTokens = false;
});

afterAll(async () => {
  await server?.close();
  await setup?.database.close();
  await admin?.end();
  await t?.drop();
  await fake?.close();
  restoreFetch?.();
  for (const capture of captures.splice(0)) capture.mockRestore();
  // After the whole file, failure paths included.
  const everything = [...logs.raw, ...printed].join("\n");
  for (const secret of [...secrets, ...fake.codes]) expect(everything).not.toContain(secret);
  for (const issued of fake.issued) {
    expect(everything).not.toContain(issued.accessToken);
    expect(everything).not.toContain(issued.refreshToken);
    expect(everything).not.toContain(issued.idToken);
  }
  expect(printed).toEqual([]);
});

function base(target: PokerServer = server): string {
  const bound = target.httpServer.address();
  if (!bound || typeof bound === "string") throw new Error("not listening");
  return `http://localhost:${bound.port}`;
}

/** A browser's cookie jar over `fetch`, following nothing by itself. */
class Browser {
  readonly jar = new Map<string, string>();
  constructor(readonly at: string = base()) {}

  get cookie(): string {
    return [...this.jar].map(([name, value]) => `${name}=${value}`).join("; ");
  }

  async go(path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    if (this.jar.size > 0) headers.set("cookie", this.cookie);
    headers.set("x-forwarded-for", address);
    const response = await fetch(`${this.at}${path}`, { ...init, headers, redirect: "manual" });
    for (const line of response.headers.getSetCookie()) {
      const [pair = "", ...rest] = line.split(";");
      const name = pair.slice(0, pair.indexOf("="));
      const value = pair.slice(pair.indexOf("=") + 1);
      if (/max-age=0/i.test(rest.join(";")) || value === "") this.jar.delete(name);
      else this.jar.set(name, value);
    }
    return response;
  }

  post(path: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
    return this.go(path, {
      method: "POST",
      headers: { origin: ORIGIN, "content-type": "application/json", ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
  }

  async session() {
    const response = await this.go("/api/auth/get-session");
    return (await response.json()) as {
      user: {
        id: string;
        name: string;
        email: string;
        image: string | null;
        isAnonymous: boolean | null;
      };
      session: Record<string, unknown>;
    } | null;
  }

  async guest(): Promise<string> {
    const response = await this.post("/api/auth/sign-in/anonymous", {});
    expect(response.status).toBe(200);
    const session = await this.session();
    if (!session) throw new Error("no guest");
    return session.user.id;
  }
}

/** The provider's URL for a start; fails the test when the server refuses. */
async function start(browser: Browser, provider: string, returnTo = "/"): Promise<string> {
  const response = await browser.post("/api/auth/sign-in/social", { provider, returnTo });
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  const { url, redirect } = (await response.json()) as { url: string; redirect: boolean };
  expect(redirect).toBe(false);
  return url;
}

/** The person answers at the provider: the address the provider sends the browser back to. */
async function atProvider(url: string, person: FakePerson | "denied"): Promise<string> {
  const answer = await fetch(
    `${atFake(url, fake.origin)}&${FAKE_PERSON_PARAM}=${fakePersonParam(person)}`,
    { redirect: "manual" },
  );
  expect(answer.status).toBe(302);
  const back = new URL(answer.headers.get("location") ?? "");
  expect(back.origin).toBe(ORIGIN);
  return `${back.pathname}${back.search}`;
}

/** A whole sign-in: where the callback sent the browser. */
async function signIn(
  browser: Browser,
  provider: "google" | "microsoft",
  person: FakePerson | "denied",
  returnTo = "/",
) {
  const callback = await atProvider(await start(browser, provider, returnTo), person);
  const response = await browser.go(callback);
  expect(response.status).toBe(302);
  expect(response.headers.get("cache-control")).toBe("no-store");
  return response.headers.get("location");
}

let people = 0;
function person(overrides: Partial<FakePerson> = {}): FakePerson {
  people += 1;
  return {
    id: `provider-person-${people}`,
    email: `person${people}@example.com`,
    name: `Person Number ${people}`,
    emailVerified: true,
    tenant: TENANT,
    ...overrides,
  };
}

async function roomOf(ownerId: string) {
  const stored = await setup.database.store.insertRoom({
    code: roomCode(),
    name: null,
    state: createRoom({ ownerId }),
  });
  if (!stored) throw new Error("code taken");
  return stored;
}

const accounts = (userId: string) =>
  admin
    .query<Record<string, unknown>>("select * from account where user_id = $1", [userId])
    .then((result) => result.rows);

describe("the routes sign-in adds", () => {
  it("forwards a callback by GET for a configured provider, and nothing new besides", async () => {
    const browser = new Browser();
    for (const [method, path] of [
      ["GET", "/api/auth/list-accounts"],
      ["POST", "/api/auth/link-social"],
      ["POST", "/api/auth/unlink-account"],
      ["POST", "/api/auth/get-access-token"],
      ["POST", "/api/auth/refresh-token"],
      ["GET", "/api/auth/account-info"],
      ["POST", "/api/auth/sign-in/email"],
      ["POST", "/api/auth/sign-up/email"],
      ["POST", "/api/auth/sign-in/oauth2"],
      ["GET", "/api/auth/sign-in/social"],
      ["GET", "/api/auth/error"],
      ["GET", "/api/auth/ok"],
      ["POST", "/api/auth/callback/google"],
      ["GET", "/api/auth/callback/github"],
      ["GET", "/api/auth/callback/GOOGLE"],
    ] as const) {
      const response = await browser.go(path, {
        method,
        headers: { origin: ORIGIN, "content-type": "application/json" },
        ...(method === "POST" && { body: "{}" }),
      });
      expect(`${method} ${path} ${response.status}`).toBe(`${method} ${path} 404`);
      expect(await response.json()).toEqual({ code: "not_found" });
    }
  });

  it("does not exist at all on an install without keys", async () => {
    const plainConfig = testConfig({ DATABASE_URL: t.url });
    const plain = await setupServer(plainConfig, logs.logger);
    const plainServer = createServer(plainConfig, { ...plain.deps, logger: logs.logger });
    await plainServer.listen();
    try {
      const browser = new Browser(base(plainServer));
      const started = await browser.post("/api/auth/sign-in/social", {
        provider: "google",
        returnTo: "/",
      });
      expect(started.status).toBe(404);
      for (const id of ["google", "microsoft"]) {
        const back = await browser.go(`/api/auth/callback/${id}?code=x&state=y`);
        expect(back.status).toBe(404);
        expect(await back.json()).toEqual({ code: "not_found" });
      }
    } finally {
      await plainServer.close();
      await plain.database.close();
    }
  });
});

describe("starting a sign-in", () => {
  it("answers with the provider's own address, for the page to navigate to", async () => {
    const browser = new Browser();
    const google = new URL(await start(browser, "google"));
    expect(google.origin + google.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(google.searchParams.get("redirect_uri")).toBe(`${ORIGIN}/api/auth/callback/google`);
    expect(google.searchParams.get("client_id")).toBe(KEYS.GOOGLE_CLIENT_ID);
    expect(google.searchParams.get("prompt")).toBe("select_account");
    expect(google.searchParams.get("access_type")).toBeNull();
    expect(google.searchParams.get("code_challenge_method")).toBe("S256");
    expect(google.search).not.toContain(KEYS.GOOGLE_CLIENT_SECRET);

    const microsoft = new URL(await start(browser, "microsoft"));
    expect(microsoft.origin + microsoft.pathname).toBe(
      "https://login.microsoftonline.com/organizations/oauth2/v2.0/authorize",
    );
    expect(microsoft.searchParams.get("redirect_uri")).toBe(
      `${ORIGIN}/api/auth/callback/microsoft`,
    );
    // A name and an email: no refresh token, no Microsoft Graph.
    expect(microsoft.searchParams.get("scope")).toBe("openid profile email");
  });

  it("takes a provider and a return path, and nothing else", async () => {
    const browser = new Browser();
    for (const body of [
      { provider: "google", returnTo: "/", idToken: { token: "forged" } },
      { provider: "google", returnTo: "/", scopes: ["https://mail.google.com/"] },
      { provider: "google", returnTo: "/", callbackURL: "https://evil.example/" },
      { provider: "google", returnTo: "/", errorCallbackURL: "https://evil.example/" },
      { provider: "google", returnTo: "/", newUserCallbackURL: "https://evil.example/" },
      { provider: "google", returnTo: "/", additionalData: { a: 1 } },
      { provider: "google", returnTo: "/", loginHint: "someone@example.com" },
      { provider: "google", returnTo: "/", additionalParams: { hd: "example.com" } },
      { provider: "github", returnTo: "/" },
      { provider: "google" },
      { returnTo: "/" },
      [],
      "not json",
    ]) {
      const response = await browser.post("/api/auth/sign-in/social", body);
      expect(response.status, JSON.stringify(body)).toBe(400);
      expect(await response.json()).toEqual({ code: "bad_payload" });
    }
    expect(
      (
        await browser.go("/api/auth/sign-in/social", {
          method: "POST",
          headers: { origin: ORIGIN, "content-type": "text/plain" },
          body: JSON.stringify({ provider: "google", returnTo: "/" }),
        })
      ).status,
    ).toBe(415);
  });

  it("returns only to this site's landing page or a room", async () => {
    const browser = new Browser();
    for (const returnTo of [
      "https://evil.example/",
      "//evil.example/",
      "/\\evil.example",
      "\\\\evil.example",
      "http:evil.example",
      "javascript:alert(1)",
      "/r/short",
      "/r/1111111111/",
      "/r/1111111111?x=1",
      "/r/1111111111#x",
      "/r/1111111111/../../evil",
      "/api/auth/get-session",
      "",
      " /",
      "/%2F/evil.example",
      `/r/${"1".repeat(40)}`,
    ]) {
      const response = await browser.post("/api/auth/sign-in/social", {
        provider: "google",
        returnTo,
      });
      expect(response.status, returnTo).toBe(400);
      expect(await response.json()).toEqual({ code: "bad_payload" });
    }
  });

  it("refuses another site's page", async () => {
    const browser = new Browser();
    const response = await browser.post(
      "/api/auth/sign-in/social",
      { provider: "google", returnTo: "/" },
      { origin: "https://evil.example" },
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ code: "not_allowed" });
  });

  it("is limited per address, and the limit is the app's code with Retry-After", async () => {
    const browser = new Browser();
    for (let n = 0; n < SOCIAL_SIGN_IN_LIMIT.max; n++) await start(browser, "google");
    const refused = await browser.post("/api/auth/sign-in/social", {
      provider: "google",
      returnTo: "/",
    });
    expect(refused.status).toBe(429);
    expect(await refused.json()).toEqual({ code: "rate_limited" });
    expect(Number(refused.headers.get("retry-after"))).toBeGreaterThan(0);
    await admin.query("delete from verification");
  });
});

describe("signing in", () => {
  it("creates an account, comes back to the room, and keeps no provider token", async () => {
    const browser = new Browser();
    const guestId = await browser.guest();
    const code = roomCode();
    const who = person({ name: "Ada Lovelace" });
    expect(await signIn(browser, "google", who, `/r/${code}`)).toBe(`${ORIGIN}/r/${code}`);

    const session = await browser.session();
    expect(session?.user).toMatchObject({
      name: "Ada Lovelace",
      email: who.email,
      isAnonymous: false,
      image: null,
    });
    expect(JSON.stringify(session)).not.toContain("token");
    const userId = session?.user.id ?? "";
    expect(userId).not.toBe(guestId);

    const [account, ...others] = await accounts(userId);
    expect(others).toEqual([]);
    expect(account).toMatchObject({
      provider_id: "google",
      account_id: who.id,
      access_token: null,
      refresh_token: null,
      id_token: null,
      access_token_expires_at: null,
      refresh_token_expires_at: null,
      tenant_id: null,
    });
    const issued = fake.issued.at(-1);
    const row = JSON.stringify(account);
    expect(row).not.toContain(issued?.accessToken);
    expect(row).not.toContain(issued?.refreshToken);
    // Nothing of the sign-in is left waiting.
    const { rows } = await admin.query("select id from verification");
    expect(rows).toEqual([]);
  });

  it("stores no token either on a later sign-in, and finds the same person", async () => {
    const who = person();
    const first = new Browser();
    await signIn(first, "google", who);
    const userId = (await first.session())?.user.id ?? "";
    const second = new Browser();
    await signIn(second, "google", who);
    expect((await second.session())?.user.id).toBe(userId);
    expect(await accounts(userId)).toEqual([
      expect.objectContaining({ access_token: null, refresh_token: null, id_token: null }),
    ]);
  });

  it("signs in with Microsoft and keeps the tenant for #50, not the token", async () => {
    const browser = new Browser();
    const who = person({ emailVerified: undefined });
    await signIn(browser, "microsoft", who);
    const session = await browser.session();
    expect(session?.user).toMatchObject({ email: who.email, isAnonymous: false, image: null });
    expect(await accounts(session?.user.id ?? "")).toEqual([
      expect.objectContaining({
        provider_id: "microsoft",
        account_id: who.id,
        tenant_id: TENANT,
        access_token: null,
        refresh_token: null,
        id_token: null,
      }),
    ]);
  });

  it("puts a provider's name through the domain's rules", async () => {
    const browser = new Browser();
    await signIn(browser, "google", person({ name: `  Grace\u{200B}Hopper ` }));
    expect((await browser.session())?.user.name).toBe("");
    const other = new Browser();
    await signIn(other, "google", person({ name: "  Grace   Hopper  " }));
    expect((await other.session())?.user.name).toBe("Grace Hopper");
  });

  it("keeps a room's code away from the provider", async () => {
    const browser = new Browser();
    const code = roomCode();
    const before = fake.authorizations.length;
    const tokensBefore = fake.tokenRequests.length;
    await signIn(browser, "google", person(), `/r/${code}`);
    await signIn(new Browser(), "microsoft", person(), `/r/${code}`);
    const sent = [
      ...fake.authorizations.slice(before),
      ...fake.tokenRequests.slice(tokensBefore),
    ].map(String);
    expect(sent.length).toBe(4);
    for (const request of sent) expect(request).not.toContain(code);
    // And away from the logs, on the way in and on the way back.
    expect(logs.raw.join("\n")).not.toContain(code);
  });

  it("keeps the guest and what it owns, and leaves a place for #48", async () => {
    const browser = new Browser();
    const guestId = await browser.guest();
    const { id } = await roomOf(guestId);
    await signIn(browser, "google", person());
    const { rows } = await admin.query(
      `select u.id, u.is_anonymous, r.owner_user_id from "user" u
       join room r on r.owner_user_id = u.id where r.id = $1`,
      [id],
    );
    expect(rows).toEqual([{ id: guestId, is_anonymous: true, owner_user_id: guestId }]);
  });

  it("sets a state cookie that is __Host- on https, and needs it on the way back", async () => {
    const https = testConfig({
      DATABASE_URL: t.url,
      BASE_URL: "https://poker.example.com",
      ...KEYS,
    });
    const auth = createAuth(https, setup.database.db, logs.logger);
    const response = await auth.handler(
      new Request("https://poker.example.com/api/auth/sign-in/social", {
        method: "POST",
        headers: { origin: "https://poker.example.com", "content-type": "application/json" },
        body: JSON.stringify({
          provider: "google",
          callbackURL: "https://poker.example.com/",
          disableRedirect: true,
        }),
      }),
    );
    const [line, ...more] = response.headers.getSetCookie();
    expect(more).toEqual([]);
    expect(line).toMatch(/^__Host-pp\.state=/);
    expect(line).toMatch(/; Secure/i);
    expect(line).toMatch(/; HttpOnly/i);
    expect(line).toMatch(/; SameSite=Lax/i);
    expect(line).toMatch(/; Path=\/(;|$)/);
    expect(line).not.toMatch(/; Domain=/i);
    await admin.query("delete from verification");
  });
});

describe("a sign-in that fails", () => {
  const codeIn = (location: string | null) =>
    new URL(location ?? "", ORIGIN).searchParams.get("sign_in_error");

  it("comes back to the room with a code when the person cancels", async () => {
    const browser = new Browser();
    const guestId = await browser.guest();
    const code = roomCode();
    const location = await signIn(browser, "google", "denied", `/r/${code}`);
    const url = new URL(location ?? "");
    expect(url.pathname).toBe(`/r/${code}`);
    expect(url.search).toBe("?sign_in_error=cancelled");
    expect(location).not.toContain("error_description");
    expect((await browser.session())?.user.id).toBe(guestId);
  });

  it("drops a state it does not know, and anything a link carries with it", async () => {
    const browser = new Browser();
    const response = await browser.go(
      "/api/auth/callback/google?state=forged-state-value&code=forged-code-value&error=<script>&error_description=gotcha",
    );
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(`${ORIGIN}/?sign_in_error=failed`);
    expect(logs.raw.join("\n")).not.toContain("forged-state-value");
    expect(logs.raw.join("\n")).not.toContain("forged-code-value");
    expect(logs.raw.join("\n")).not.toContain("gotcha");
  });

  it("wants the state cookie of the browser that started", async () => {
    const callback = await atProvider(await start(new Browser(), "google"), person());
    const other = new Browser();
    const response = await other.go(callback);
    expect(codeIn(response.headers.get("location"))).toBe("failed");
    expect(await other.session()).toBeNull();
  });

  it("takes a callback once", async () => {
    const browser = new Browser();
    const callback = await atProvider(await start(browser, "google"), person());
    const state = browser.jar.get(STATE_COOKIE) ?? "";
    expect((await browser.go(callback)).headers.get("location")).toBe(`${ORIGIN}/`);
    browser.jar.set(STATE_COOKIE, state);
    expect(codeIn((await browser.go(callback)).headers.get("location"))).toBe("failed");
  });

  it("wants a state at all", async () => {
    const response = await new Browser().go("/api/auth/callback/google?code=abc");
    expect(response.headers.get("location")).toBe(`${ORIGIN}/?sign_in_error=failed`);
  });

  it("logs a reason from a fixed list when the token address fails", async () => {
    const browser = new Browser();
    const code = roomCode();
    const callback = await atProvider(await start(browser, "google", `/r/${code}`), person());
    fake.failTokens = true;
    const response = await browser.go(callback);
    expect(response.headers.get("location")).toBe(`${ORIGIN}/r/${code}?sign_in_error=failed`);
    expect(logs.lines).toContainEqual(
      expect.objectContaining({
        msg: "sign-in did not finish",
        code: "failed",
        reason: "invalid_code",
        provider: "google",
      }),
    );
  });

  it("says which way in an email already has, and links nothing it cannot trust", async () => {
    const email = `same${people}@example.com`;
    const browser = new Browser();
    await signIn(browser, "google", person({ email }));
    const owner = (await browser.session())?.user.id ?? "";
    // Entra's `email` claim is not verified (OQ-6): it must not reach the Google account.
    const other = new Browser();
    const location = await signIn(other, "microsoft", person({ email, emailVerified: undefined }));
    expect(codeIn(location)).toBe("account_exists");
    expect(await other.session()).toBeNull();
    expect(await accounts(owner)).toHaveLength(1);
  });

  it("explains a provider that gives no email", async () => {
    const location = await signIn(new Browser(), "microsoft", person({ email: undefined }));
    expect(codeIn(location)).toBe("no_email");
  });
});

describe("signing out", () => {
  it("ends the session, and the browser can be a new guest", async () => {
    const browser = new Browser();
    await signIn(browser, "google", person());
    const userId = (await browser.session())?.user.id ?? "";
    expect((await browser.post("/api/auth/sign-out", {})).status).toBe(200);
    expect(await browser.session()).toBeNull();
    const guestId = await browser.guest();
    expect(guestId).not.toBe(userId);
    expect((await browser.session())?.user.isAnonymous).toBe(true);
  });
});

describe("in a room", () => {
  it("shows no email and no provider id in any frame", async () => {
    const owner = await signInGuest(base(), ORIGIN);
    const created = await fetch(`${base()}/api/rooms`, {
      method: "POST",
      headers: { origin: ORIGIN, "content-type": "application/json", cookie: owner.cookie },
      body: "{}",
    });
    const { code } = (await created.json()) as { code: string };
    const browser = new Browser();
    const who = person({ name: "Linus Pauling" });
    await signIn(browser, "google", who);
    const signedIn = socketClient(base(), { cookie: `${COOKIE}=${browser.jar.get(COOKIE)}` });
    const watcher = socketClient(base(), { cookie: owner.cookie });
    try {
      await signedIn.enter(code);
      await watcher.enter(code);
      const ack = await signedIn.cmd("join", { name: "Linus Pauling", role: "voter" });
      expect(ack.ok).toBe(true);
      await watcher.waitFor((snapshot) =>
        snapshot.room.participants.some((seat) => seat.name === "Linus Pauling"),
      );
      expect(watcher.frames.length).toBeGreaterThan(0);
      for (const frame of [...signedIn.frames, ...watcher.frames]) {
        expect(frame).not.toContain(who.email);
        expect(frame).not.toContain(who.id);
      }
    } finally {
      signedIn.close();
      watcher.close();
    }
  });
});

describe("retention", () => {
  it("keeps the room of a signed-in owner and purges what a guest left", async () => {
    const browser = new Browser();
    await signIn(browser, "google", person());
    const ownerId = (await browser.session())?.user.id ?? "";
    expect(await accounts(ownerId)).toHaveLength(1);
    const guestBrowser = new Browser();
    const guestId = await guestBrowser.guest();
    const kept = await roomOf(ownerId);
    const gone = await roomOf(guestId);
    await admin.query("update room set last_active_at = now() - interval '200 days'");
    const counts = await setup.database.retention.purge({ ttlDays: 90 });
    expect(counts?.rooms).toBeGreaterThanOrEqual(1);
    const { rows } = await admin.query<{ id: string }>("select id from room where id = any($1)", [
      [kept.id, gone.id],
    ]);
    expect(rows.map((row) => row.id)).toEqual([kept.id]);
    expect(await accounts(ownerId)).toHaveLength(1);
  });
});
