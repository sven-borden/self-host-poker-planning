/**
 * Identity against a real Postgres: guest sign-in and its cookie, the display name, the
 * rate limit, the socket handshake, a lost connection, a database that refuses
 * connections, and that neither the signing secret nor a session token reaches a log
 * line, stdout or stderr (console and both streams are captured for the whole file).
 */
import { format } from "node:util";
import { userIdSchema } from "@pp/protocol";
import pg from "pg";
import { io as connect, type Socket } from "socket.io-client";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  type MockInstance,
  vi,
} from "vitest";
import {
  ANONYMOUS_SIGN_IN_LIMIT,
  AUTH_BODY_LIMIT_BYTES,
  CLIENT_IP_HEADER,
  cookieNaming,
  createAuth,
  memoryRateLimit,
  RENAME_LIMITS,
  sessionUser,
} from "./auth.ts";
import type { Config } from "./config.ts";
import { APP_NAME, type Database } from "./database.ts";
import { createTestDatabase, serverUrl, type TestDatabase, testClient } from "./db/test-db.ts";
import { createServer, type PokerServer } from "./server.ts";
import { setupServer } from "./setup.ts";
import { collectLogs, testConfig, VALID_ENV } from "./test-support.ts";

const ORIGIN = VALID_ENV.BASE_URL;
const COOKIE = "pp.session_token";
const logs = collectLogs("trace");
/** Every session token and cookie value seen: none may reach a log line. */
const seen: string[] = [];

let t: TestDatabase;
let admin: ReturnType<typeof testClient>;
let config: Config;
let database: Database;
const servers: PokerServer[] = [];
const sockets: Socket[] = [];

/** Whatever reached console or process.stdout/stderr: our pino lines go to `logs`. */
const printed: string[] = [];
const captures: MockInstance[] = [];

const crashes: unknown[] = [];
const onCrash = (error: unknown) => {
  crashes.push(error);
};

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
  process.on("uncaughtException", onCrash);
  process.on("unhandledRejection", onCrash);
  t = await createTestDatabase();
  admin = testClient(t.url);
  config = testConfig({ DATABASE_URL: t.url, LOG_LEVEL: "trace" });
  const setup = await setupServer(config, logs.logger);
  database = setup.database;
  const server = createServer(config, { ...setup.deps, logger: logs.logger });
  await server.listen();
  servers.push(server);
});

afterEach(() => {
  for (const socket of sockets.splice(0)) socket.disconnect();
});

afterAll(async () => {
  for (const server of servers) await server.close();
  await database?.close();
  await admin?.end();
  await t?.drop();
  process.off("uncaughtException", onCrash);
  process.off("unhandledRejection", onCrash);
  for (const capture of captures.splice(0)) capture.mockRestore();
  expect(crashes).toEqual([]);
});

function baseOf(server: PokerServer | undefined = servers[0]): string {
  const address = server?.httpServer.address();
  if (!address || typeof address === "string") throw new Error("not listening");
  return `http://localhost:${address.port}`;
}

interface Call {
  method?: string;
  cookie?: string;
  headers?: Record<string, string>;
  body?: unknown;
  server?: PokerServer;
}

async function call(
  path: string,
  { method = "GET", cookie, headers = {}, body, server }: Call = {},
) {
  const response = await fetch(`${baseOf(server)}${path}`, {
    method,
    headers: {
      origin: ORIGIN,
      ...(body !== undefined && { "content-type": "application/json" }),
      ...(cookie && { cookie }),
      ...headers,
    },
    ...(body !== undefined && { body: typeof body === "string" ? body : JSON.stringify(body) }),
  });
  const text = await response.text();
  return { response, status: response.status, json: text ? (JSON.parse(text) as unknown) : null };
}

/** Signs in as a new guest and returns the cookie to send back, and the user. */
async function signIn(headers: Record<string, string> = {}, server?: PokerServer) {
  const { response, status, json } = await call("/api/auth/sign-in/anonymous", {
    method: "POST",
    body: {},
    headers,
    ...(server && { server }),
  });
  const setCookie = response.headers.getSetCookie();
  const pair = setCookie.find((line) => line.startsWith(`${COOKIE}=`))?.split(";")[0] ?? "";
  if (pair) seen.push(pair.slice(COOKIE.length + 1));
  const token = (json as { token?: string } | null)?.token;
  if (token) seen.push(token);
  const user = (json as { user?: { id: string; name: string } } | null)?.user;
  return { status, setCookie, cookie: pair, user, json };
}

async function sessionOf(cookie: string) {
  const { json } = await call("/api/auth/get-session", { cookie });
  return json as { user: { id: string; name: string; isAnonymous: boolean } } | null;
}

function handshake(
  headers: Record<string, string>,
): Promise<{ ok: true; socket: Socket } | { ok: false; message: string }> {
  const socket = connect(baseOf(), {
    transports: ["websocket"],
    reconnection: false,
    forceNew: true,
    extraHeaders: headers,
  });
  sockets.push(socket);
  return new Promise((resolve) => {
    socket.on("connect", () => resolve({ ok: true, socket }));
    socket.on("connect_error", (error) => resolve({ ok: false, message: error.message }));
  });
}

describe("anonymous sign-in", () => {
  it("creates a guest with an empty name and an httpOnly, SameSite=Lax session cookie", async () => {
    const { status, setCookie, user } = await signIn({ "x-forwarded-for": "198.51.100.1" });
    expect(status).toBe(200);
    expect(userIdSchema.safeParse(user?.id).success).toBe(true);
    expect(user?.name).toBe("");
    const line = setCookie.find((l) => l.startsWith(`${COOKIE}=`)) ?? "";
    expect(line).toMatch(/; HttpOnly/i);
    expect(line).toMatch(/; SameSite=Lax/i);
    expect(line).toMatch(/; Path=\//);
    expect(line).not.toMatch(/; Secure/i);
    // ROOM_TTL_DAYS (90 by default) after the last visit.
    expect(line).toContain(`Max-Age=${90 * 24 * 60 * 60}`);
  });

  it("names the cookie __Host-pp.session_token on https: Secure, Path=/ and no Domain", async () => {
    expect(cookieNaming("https://poker.example.com").sessionCookie).toBe("__Host-pp.session_token");
    expect(cookieNaming("http://192.168.1.20:3000").sessionCookie).toBe(COOKIE);
    const secure = createAuth(
      testConfig({ DATABASE_URL: t.url, BASE_URL: "https://poker.example.com" }),
      database.db,
      logs.logger,
    );
    const response = await secure.handler(
      new Request("https://poker.example.com/api/auth/sign-in/anonymous", {
        method: "POST",
        headers: {
          origin: "https://poker.example.com",
          "content-type": "application/json",
          [CLIENT_IP_HEADER]: "198.51.100.2",
        },
        body: "{}",
      }),
    );
    expect(response.status).toBe(200);
    const cookies = response.headers.getSetCookie();
    expect(cookies.length).toBeGreaterThan(0);
    for (const cookie of cookies) expect(cookie).toMatch(/^__Host-pp\./);
    const line = cookies.find((l) => l.startsWith(`__Host-${COOKIE}=`)) ?? "";
    const pair = line.split(";")[0] ?? "";
    seen.push(pair.slice(pair.indexOf("=") + 1));
    expect(line).toMatch(/; Secure/i);
    expect(line).toMatch(/; HttpOnly/i);
    expect(line).toMatch(/; SameSite=Lax/i);
    expect(line).toMatch(/; Path=\/(;|$)/);
    expect(line).not.toMatch(/; Domain=/i);
    // The cookie it set is the one it reads back; the http name means nothing there.
    const user = await sessionUser(secure, new Headers({ cookie: pair }));
    expect(user?.isAnonymous).toBe(true);
    const plain = `${COOKIE}=${pair.slice(pair.indexOf("=") + 1)}`;
    expect(await sessionUser(secure, new Headers({ cookie: plain }))).toBeNull();
  });

  it("returns the same user for the same cookie (a refresh) and another for a second browser", async () => {
    const first = await signIn({ "x-forwarded-for": "198.51.100.3" });
    expect((await sessionOf(first.cookie))?.user.id).toBe(first.user?.id);
    expect((await sessionOf(first.cookie))?.user.isAnonymous).toBe(true);
    const second = await signIn({ "x-forwarded-for": "198.51.100.3" });
    expect(second.user?.id).not.toBe(first.user?.id);
    expect((await sessionOf(second.cookie))?.user.id).toBe(second.user?.id);
    expect(await sessionOf("")).toBeNull();
  });

  it("stores neither the client address nor the user agent", async () => {
    const { user } = await signIn({
      "x-forwarded-for": "198.51.100.4",
      "user-agent": "Mozilla/5.0 (pp-test)",
    });
    const { rows } = await admin.query(
      "select ip_address, user_agent from session where user_id = $1",
      [user?.id],
    );
    expect(rows).toEqual([{ ip_address: null, user_agent: null }]);
  });

  it("forwards only get-session, sign-in/anonymous and sign-out", async () => {
    const { cookie } = await signIn({ "x-forwarded-for": "198.51.100.5" });
    for (const [method, path] of [
      ["POST", "/api/auth/update-user"],
      ["POST", "/api/auth/delete-anonymous-user"],
      ["GET", "/api/auth/list-sessions"],
      ["GET", "/api/auth/ok"],
      ["POST", "/api/auth/get-session"],
      ["GET", "/api/auth/sign-out"],
      ["GET", "/api/auth/get-session/"],
    ] as const) {
      const body = method === "POST" ? { name: "x" } : undefined;
      expect(await call(path, { method, cookie, body })).toMatchObject({
        status: 404,
        json: { code: "not_found" },
      });
    }
  });

  it("answers unknown paths before the limiter: no counter per path, never a 429", async () => {
    const ip = { "x-forwarded-for": "198.51.100.6" };
    const answers = await Promise.all(
      Array.from({ length: 150 }, (_, i) => call(`/api/auth/x-${i}`, { headers: ip })),
    );
    expect(new Set(answers.map((a) => a.status))).toEqual(new Set([404]));
  });

  it("refuses an auth body over 4 KB with bad_payload", async () => {
    const big = { pad: "x".repeat(AUTH_BODY_LIMIT_BYTES) };
    expect(await call("/api/auth/sign-in/anonymous", { method: "POST", body: big })).toMatchObject({
      status: 413,
      json: { code: "bad_payload" },
    });
  });

  it("answers with the app's codes and never a token or a sentence", async () => {
    const first = await signIn({ "x-forwarded-for": "198.51.100.7" });
    expect(first.status).toBe(200);
    expect(JSON.stringify(first.json)).not.toMatch(/token/i);
    const session = await call("/api/auth/get-session", { cookie: first.cookie });
    expect(session.status).toBe(200);
    expect(JSON.stringify(session.json)).not.toMatch(/token/i);
    // A second tab's sign-in while the first one's cookie is set.
    expect(
      await call("/api/auth/sign-in/anonymous", { method: "POST", cookie: first.cookie, body: {} }),
    ).toEqual(expect.objectContaining({ status: 400, json: { code: "not_allowed" } }));
    // Another origin (Better Auth's own check), then a body that is not JSON.
    expect(
      await call("/api/auth/sign-out", {
        method: "POST",
        cookie: first.cookie,
        body: {},
        headers: { origin: "https://evil.example.com" },
      }),
    ).toEqual(expect.objectContaining({ status: 403, json: { code: "not_allowed" } }));
    const notJson = await call("/api/auth/sign-in/anonymous", {
      method: "POST",
      body: "name=x",
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });
    expect(notJson.status).toBeGreaterThanOrEqual(400);
    expect(notJson.status).toBeLessThan(500);
    expect(notJson.json).toEqual({ code: "bad_payload" });
  });
});

describe("the display name", () => {
  const rename = (cookie: string, body: unknown, headers: Record<string, string> = {}) =>
    call("/api/me/name", { method: "POST", cookie, body, headers });

  it("is cleaned by the domain's rules and stored on the user", async () => {
    const { cookie, user } = await signIn({ "x-forwarded-for": "198.51.100.10" });
    expect(await rename(cookie, { name: "  Ada \t  Lovelace\n" })).toMatchObject({
      status: 200,
      json: { name: "Ada Lovelace" },
    });
    expect((await sessionOf(cookie))?.user).toMatchObject({ id: user?.id, name: "Ada Lovelace" });
    // 32 characters pass, whatever their code units.
    const family = "👨‍👩‍👧‍👦".repeat(32);
    expect(await rename(cookie, { name: family })).toMatchObject({
      status: 200,
      json: { name: family },
    });
  });

  it("refuses a name that is too long, malformed or blank with bad_name", async () => {
    const { cookie } = await signIn({ "x-forwarded-for": "198.51.100.11" });
    for (const name of ["x".repeat(33), "Ada\uD800", "   ", "", 42, null]) {
      expect(await rename(cookie, { name })).toMatchObject({
        status: 400,
        json: { code: "bad_name" },
      });
    }
    expect(await rename(cookie, "{not json")).toMatchObject({
      status: 400,
      json: { code: "bad_name" },
    });
  });

  it("needs a session, a JSON body, this origin and at most 4 KB", async () => {
    const { cookie } = await signIn({ "x-forwarded-for": "198.51.100.12" });
    expect(await rename("", { name: "Ada" })).toMatchObject({
      status: 401,
      json: { code: "unauthenticated" },
    });
    expect(
      await rename(cookie, { name: "Ada" }, { origin: "https://evil.example.com" }),
    ).toMatchObject({ status: 403, json: { code: "not_allowed" } });
    expect(await rename(cookie, { name: "Ada" }, { "content-type": "text/plain" })).toMatchObject({
      status: 415,
      json: { code: "bad_payload" },
    });
    expect(await rename(cookie, { name: "x".repeat(AUTH_BODY_LIMIT_BYTES) })).toMatchObject({
      status: 413,
      json: { code: "bad_payload" },
    });
  });

  it("is rate limited per user", async () => {
    const { cookie } = await signIn({ "x-forwarded-for": "198.51.100.13" });
    for (let i = 0; i < RENAME_LIMITS.user.max; i++) {
      expect((await rename(cookie, { name: `Ada ${i}` })).status).toBe(200);
    }
    const throttled = await rename(cookie, { name: "Ada again" });
    expect(throttled).toMatchObject({ status: 429, json: { code: "rate_limited" } });
    expect(Number(throttled.response.headers.get("retry-after"))).toBeGreaterThan(0);
    // Another user behind the same address is not affected.
    const other = await signIn({ "x-forwarded-for": "198.51.100.13" });
    expect((await rename(other.cookie, { name: "Grace" })).status).toBe(200);
  });

  it("is rate limited per address, before the session is read", async () => {
    const ip = { "x-forwarded-for": "198.51.100.14" };
    for (let i = 0; i < RENAME_LIMITS.ip.max; i++) {
      expect((await rename("", { name: "x" }, ip)).status).toBe(401);
    }
    expect(await rename("", { name: "x" }, ip)).toMatchObject({
      status: 429,
      json: { code: "rate_limited" },
    });
  });
});

describe("the anonymous sign-in rate limit", () => {
  it("lets a whole office behind one address in, then throttles", async () => {
    const office = { "x-forwarded-for": "6.6.6.6, 203.0.113.20" };
    const quick = await Promise.all(Array.from({ length: 20 }, () => signIn(office)));
    expect(quick.map((r) => r.status)).toEqual(Array(20).fill(200));
    for (let i = 20; i < ANONYMOUS_SIGN_IN_LIMIT.max; i++) {
      expect((await signIn(office)).status).toBe(200);
    }
    const throttled = await signIn(office);
    expect(throttled).toMatchObject({ status: 429, json: { code: "rate_limited" } });
    // Keyed on the right-most entry (TRUST_PROXY=1): a forged left entry or a forged
    // client-IP header changes nothing; another address is not affected.
    expect((await signIn({ "x-forwarded-for": "7.7.7.7, 203.0.113.20" })).status).toBe(429);
    expect((await signIn({ ...office, [CLIENT_IP_HEADER]: "203.0.113.99" })).status).toBe(429);
    expect((await signIn({ "x-forwarded-for": "203.0.113.21" })).status).toBe(200);
  });

  it("counts the proxies from the right with TRUST_PROXY=2", async () => {
    const twoHops = testConfig({ DATABASE_URL: t.url, TRUST_PROXY: "2" });
    const setup = await setupServer(twoHops, logs.logger);
    const server = createServer(twoHops, { ...setup.deps, logger: logs.logger });
    await server.listen();
    servers.push(server);
    try {
      // The TLS proxy (172.18.0.2) is the right-most entry for everybody.
      const first = { "x-forwarded-for": "203.0.113.30, 172.18.0.2" };
      for (let i = 0; i < ANONYMOUS_SIGN_IN_LIMIT.max; i++) {
        expect((await signIn(first, server)).status).toBe(200);
      }
      expect((await signIn(first, server)).status).toBe(429);
      const second = { "x-forwarded-for": "203.0.113.31, 172.18.0.2" };
      expect((await signIn(second, server)).status).toBe(200);
    } finally {
      await setup.database.close();
    }
  });

  it("uses a store of its own per instance", async () => {
    const store = memoryRateLimit(() => 1000);
    const rule = { window: 10, max: 1 };
    expect(await store.consume("a", rule)).toEqual({ allowed: true, retryAfter: null });
    expect(await store.consume("a", rule)).toEqual({ allowed: false, retryAfter: 10 });
    expect(await memoryRateLimit().consume("a", rule)).toEqual({ allowed: true, retryAfter: null });
  });

  it("keeps at most maxKeys counters, dropping the oldest tenth when full", async () => {
    let now = 0;
    const store = memoryRateLimit(() => now, 10);
    const rule = { window: 60, max: 1 };
    for (let i = 0; i < 10; i++) await store.consume(`k${i}`, rule);
    expect((await store.consume("k0", rule)).allowed).toBe(false);
    // The 11th key evicts k0, the oldest; newer keys keep counting.
    await store.consume("k10", rule);
    expect((await store.consume("k0", rule)).allowed).toBe(true);
    expect((await store.consume("k2", rule)).allowed).toBe(false);
    // Expired counters go at the next sweep; a new window starts.
    now = 61_000;
    expect((await store.consume("k2", rule)).allowed).toBe(true);
  });
});

describe("the socket handshake", () => {
  it("refuses a socket without a cookie, with a junk one, or a forged token", async () => {
    expect(await handshake({})).toEqual({ ok: false, message: "unauthenticated" });
    expect(await handshake({ cookie: `${COOKIE}=junk` })).toEqual({
      ok: false,
      message: "unauthenticated",
    });
    const { cookie } = await signIn({ "x-forwarded-for": "198.51.100.40" });
    const [token] = cookie.slice(COOKIE.length + 1).split(".");
    expect(await handshake({ cookie: `${COOKIE}=${token}.forgedsignature` })).toEqual({
      ok: false,
      message: "unauthenticated",
    });
  });

  it("refuses an expired session and a revoked one", async () => {
    const expired = await signIn({ "x-forwarded-for": "198.51.100.41" });
    await admin.query(
      "update session set expires_at = now() - interval '1 second' where user_id = $1",
      [expired.user?.id],
    );
    expect(await handshake({ cookie: expired.cookie })).toEqual({
      ok: false,
      message: "unauthenticated",
    });
    const revoked = await signIn({ "x-forwarded-for": "198.51.100.41" });
    expect(
      (await call("/api/auth/sign-out", { method: "POST", cookie: revoked.cookie, body: {} }))
        .status,
    ).toBe(200);
    expect(await handshake({ cookie: revoked.cookie })).toEqual({
      ok: false,
      message: "unauthenticated",
    });
  });

  it("accepts a valid session and sets socket.data.user", async () => {
    const { cookie, user } = await signIn({ "x-forwarded-for": "198.51.100.42" });
    await call("/api/me/name", { method: "POST", cookie, body: { name: "Grace" } });
    const result = await handshake({ cookie, origin: ORIGIN });
    expect(result.ok).toBe(true);
    const [remote] = (await servers[0]?.io.fetchSockets()) ?? [];
    expect(remote?.data.user).toEqual({ id: user?.id, name: "Grace", isAnonymous: true });
  });

  it("still refuses a foreign Origin, even with a valid session", async () => {
    const { cookie } = await signIn({ "x-forwarded-for": "198.51.100.43" });
    const result = await handshake({ cookie, origin: "https://evil.example.com" });
    expect(result.ok).toBe(false);
  });
});

describe("the auth tables (AC 3)", () => {
  it("are created by the migrations", async () => {
    const { rows } = await admin.query<{ table_name: string }>(
      "select table_name from information_schema.tables where table_schema = 'public' order by 1",
    );
    expect(rows.map((r) => r.table_name)).toEqual([
      "account",
      "room",
      "round_history",
      "session",
      "user",
      "verification",
    ]);
  });
});

describe("a backend terminated in the middle of an anonymous sign-in", () => {
  it("fails that request cleanly, never crashes, and the next sign-in works", async () => {
    const client = await admin.connect();
    await client.query("begin");
    // The insert into "user" waits on this lock.
    await client.query('lock table "user" in share mode');
    const running = signIn({ "x-forwarded-for": "198.51.100.50" });
    let pid: number | undefined;
    for (let i = 0; i < 250 && pid === undefined; i++) {
      const { rows } = await admin.query<{ pid: number }>(
        `select pid from pg_stat_activity where datname = current_database()
         and application_name = $1 and wait_event_type = 'Lock'`,
        [APP_NAME],
      );
      pid = rows[0]?.pid;
      if (pid === undefined) await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(pid).toBeDefined();
    await admin.query("select pg_terminate_backend($1)", [pid]);
    const outcome = await running;
    await client.query("rollback");
    client.release();
    expect(outcome).toMatchObject({ status: 500, json: { code: "internal" } });
    expect(outcome.cookie).toBe("");
    // Late socket events arrive within a few ticks.
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(crashes).toEqual([]);
    expect((await signIn({ "x-forwarded-for": "198.51.100.51" })).status).toBe(200);
  });
});

describe("a database that fails", () => {
  /** A handshake, a name update, a sign-in and a session read: each answers internal. */
  async function everythingFails(cookie: string, ip: string) {
    expect(await handshake({ cookie, origin: ORIGIN })).toEqual({
      ok: false,
      message: "internal",
    });
    expect(
      await call("/api/me/name", { method: "POST", cookie, body: { name: "Ada" } }),
    ).toMatchObject({ status: 500, json: { code: "internal" } });
    const refused = await signIn({ "x-forwarded-for": ip });
    expect(refused).toMatchObject({ status: 500, json: { code: "internal" }, cookie: "" });
    expect(await call("/api/auth/get-session", { cookie })).toMatchObject({
      status: 500,
      json: { code: "internal" },
    });
  }

  it("keeps the token out of every output when a query fails with it as a parameter", async () => {
    const { cookie } = await signIn({ "x-forwarded-for": "198.51.100.63" });
    // Drizzle puts a failed query's parameters (the session token) into its message.
    await admin.query('alter table "session" rename to "session_away"');
    try {
      await everythingFails(cookie, "198.51.100.64");
    } finally {
      await admin.query('alter table "session_away" rename to "session"');
    }
    expect((await sessionOf(cookie))?.user.id).toBeDefined();
  });

  it("answers internal while connections are refused, then recovers", async () => {
    const { cookie } = await signIn({ "x-forwarded-for": "198.51.100.60" });
    expect(cookie).not.toBe("");
    const name = new URL(t.url).pathname.slice(1);
    // Another database, so that terminating every backend of this one spares it.
    const dba = new pg.Client({ connectionString: serverUrl(), application_name: "pp-test" });
    dba.on("error", () => {});
    await dba.connect();
    const linesBefore = logs.lines.length;
    try {
      await dba.query(`alter database "${name}" allow_connections false`);
      await dba.query("select pg_terminate_backend(pid) from pg_stat_activity where datname = $1", [
        name,
      ]);
      await everythingFails(cookie, "198.51.100.61");
    } finally {
      await dba.query(`alter database "${name}" allow_connections true`);
      await dba.end();
    }
    // Each failure left a pino line with a code, never a driver message.
    const failures = logs.lines.slice(linesBefore).filter((line) => line.level === 50);
    expect(failures.length).toBeGreaterThanOrEqual(4);
    expect((await signIn({ "x-forwarded-for": "198.51.100.62" })).status).toBe(200);
  });
});

describe("the logs", () => {
  it("never carry the signing secret, a session token or a cookie, and nothing is printed", () => {
    const text = logs.raw.join("");
    expect(logs.raw.length).toBeGreaterThan(0);
    // Nothing of Better Auth's or better-call's reaches console, stdout or stderr: the
    // server's own lines are pino's, collected in `logs`.
    expect(printed).toEqual([]);
    expect(text).not.toContain(VALID_ENV.BETTER_AUTH_SECRET);
    expect(seen.length).toBeGreaterThan(20);
    for (const value of seen) {
      if (!value) continue;
      expect(text).not.toContain(value);
      // The token alone, without its signature.
      expect(text).not.toContain(decodeURIComponent(value).split(".")[0]);
    }
    expect(text).not.toContain(COOKIE);
  });
});
