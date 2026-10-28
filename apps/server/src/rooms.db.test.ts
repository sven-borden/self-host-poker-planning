/**
 * The room API against a real Postgres (#14): creating a room makes the caller its
 * product owner, codes are drawn again on a clash, every refusal answers its code, the
 * creation limit counts per client address (TRUST_PROXY hops), and the header route
 * gives a room's code and name, nothing more. Neither a room code nor a room name reaches
 * a log line.
 */
import { createRoom, DEFAULT_SETTINGS, MAX_ROOM_NAME_LENGTH } from "@pp/domain";
import { WIRE_LIMITS } from "@pp/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "./app.ts";
import type { Config } from "./config.ts";
import type { Database } from "./database.ts";
import { createTestDatabase, type TestDatabase, testClient } from "./db/test-db.ts";
import { memoryRateLimit } from "./rate-limit.ts";
import { type RandomBytes, ROOM_CODE_ALPHABET, ROOM_CODE_PATTERN } from "./room-code.ts";
import {
  CODE_ATTEMPTS,
  insertNewRoom,
  ROOM_CREATE_LIMIT,
  ROOM_HEADER_LIMIT,
  registerRoomApi,
} from "./rooms.ts";
import { createServer, type PokerServer } from "./server.ts";
import { setupServer } from "./setup.ts";
import { collectLogs, testConfig, VALID_ENV } from "./test-support.ts";

const ORIGIN = VALID_ENV.BASE_URL;
const COOKIE = "pp.session_token";
const logs = collectLogs("trace");

let t: TestDatabase;
let admin: ReturnType<typeof testClient>;
let config: Config;
let setup: Awaited<ReturnType<typeof setupServer>>;
let database: Database;
const servers: PokerServer[] = [];
const closers: (() => Promise<void>)[] = [];
/** Every room code and name created here: none may reach a log line. */
const secrets: string[] = [];

beforeAll(async () => {
  t = await createTestDatabase();
  admin = testClient(t.url);
  config = testConfig({ DATABASE_URL: t.url, LOG_LEVEL: "trace" });
  setup = await setupServer(config, logs.logger);
  database = setup.database;
  const server = createServer(config, { ...setup.deps, logger: logs.logger });
  await server.listen();
  servers.push(server);
});

afterAll(async () => {
  for (const server of servers) await server.close();
  for (const close of closers) await close();
  await database?.close();
  await admin?.end();
  await t?.drop();
  const written = logs.raw.join("");
  for (const secret of secrets) expect(written).not.toContain(secret);
});

function baseOf(server: PokerServer | undefined = servers[0]): string {
  const address = server?.httpServer.address();
  if (!address || typeof address === "string") throw new Error("not listening");
  return `http://localhost:${address.port}`;
}

interface Call {
  method?: string;
  cookie?: string;
  /** The client address, as the last proxy (TRUST_PROXY=1) reports it. */
  ip?: string;
  headers?: Record<string, string>;
  body?: unknown;
  server?: PokerServer;
}

async function call(path: string, { method = "GET", cookie, ip, headers, body, server }: Call) {
  const response = await fetch(`${baseOf(server)}${path}`, {
    method,
    headers: {
      origin: ORIGIN,
      ...(body !== undefined && { "content-type": "application/json" }),
      ...(cookie && { cookie }),
      ...(ip && { "x-forwarded-for": ip }),
      ...headers,
    },
    ...(body !== undefined && { body: typeof body === "string" ? body : JSON.stringify(body) }),
  });
  const text = await response.text();
  return { response, status: response.status, json: text ? (JSON.parse(text) as unknown) : null };
}

/** A new guest's session cookie and user id. */
async function signIn(ip: string, server?: PokerServer) {
  const { response, json } = await call("/api/auth/sign-in/anonymous", {
    method: "POST",
    body: {},
    ip,
    ...(server && { server }),
  });
  const pair = response.headers
    .getSetCookie()
    .find((line) => line.startsWith(`${COOKIE}=`))
    ?.split(";")[0];
  const id = (json as { user?: { id?: string } } | null)?.user?.id;
  if (!pair || !id) throw new Error("sign-in failed");
  return { cookie: pair, id };
}

async function create(cookie: string, body: unknown, ip: string, extra: Partial<Call> = {}) {
  const result = await call("/api/rooms", { method: "POST", cookie, body, ip, ...extra });
  const code = (result.json as { code?: string } | null)?.code;
  if (result.status === 201 && code) secrets.push(code);
  return result;
}

async function roomRow(code: string) {
  const { rows } = await admin.query(
    "select name, owner_user_id, version, password_hash from room where code = $1",
    [code],
  );
  return rows[0] as
    | { name: string | null; owner_user_id: string; version: number; password_hash: null }
    | undefined;
}

async function roomCount(): Promise<number> {
  const { rows } = await admin.query("select count(*)::int as n from room");
  return (rows[0] as { n: number }).n;
}

describe("POST /api/rooms", () => {
  it("creates a room whose creator is the product owner, with the default settings", async () => {
    const me = await signIn("198.51.100.1");
    const name = "  Sprint 42 \t refinement ";
    secrets.push("Sprint 42 refinement");
    const { status, json, response } = await create(me.cookie, { name }, "198.51.100.1");
    expect(status).toBe(201);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const code = (json as { code: string }).code;
    expect(Object.keys(json as object)).toEqual(["code"]);
    expect(code).toMatch(ROOM_CODE_PATTERN);

    const stored = await database.store.loadRoom(code);
    expect(stored?.state).toEqual(createRoom({ ownerId: me.id }));
    expect(stored?.state.ownerId).toBe(me.id);
    expect(stored?.state.settings.deck).toEqual({ kind: "preset", id: "fib" });
    expect(await roomRow(code)).toEqual({
      name: "Sprint 42 refinement",
      owner_user_id: me.id,
      version: 1,
      password_hash: null,
    });
  });

  it("plays the chosen preset deck, and a room may have no name", async () => {
    const me = await signIn("198.51.100.2");
    const { status, json } = await create(me.cookie, { deck: "tshirt" }, "198.51.100.2");
    expect(status).toBe(201);
    const code = (json as { code: string }).code;
    const stored = await database.store.loadRoom(code);
    expect(stored?.state.settings).toEqual({
      ...DEFAULT_SETTINGS,
      deck: { kind: "preset", id: "tshirt" },
    });
    expect((await roomRow(code))?.name).toBeNull();
    const empty = await create(me.cookie, {}, "198.51.100.2");
    expect(empty.status).toBe(201);
    const plain = await database.store.loadRoom((empty.json as { code: string }).code);
    expect(plain?.state.settings.deck).toEqual({ kind: "preset", id: "fib" });
  });

  it("refuses without a session, from another origin, and a body that is not JSON", async () => {
    const ip = "198.51.100.3";
    const me = await signIn(ip);
    const before = await roomCount();
    expect(await create("", { name: "x" }, ip)).toMatchObject({
      status: 401,
      json: { code: "unauthenticated" },
    });
    expect(await create(`${COOKIE}=forged.value`, {}, ip)).toMatchObject({
      status: 401,
      json: { code: "unauthenticated" },
    });
    expect(
      await create(me.cookie, {}, ip, { headers: { origin: "https://evil.example.com" } }),
    ).toMatchObject({ status: 403, json: { code: "not_allowed" } });
    expect(
      await create(me.cookie, {}, ip, { headers: { "content-type": "text/plain" } }),
    ).toMatchObject({ status: 415, json: { code: "bad_payload" } });
    expect(await create(me.cookie, "{not json", ip)).toMatchObject({
      status: 400,
      json: { code: "bad_payload" },
    });
    expect(await roomCount()).toBe(before);
  });

  it("takes a strict body: unknown keys, a bad deck and a bad name are refused", async () => {
    const ip = "198.51.100.4";
    const me = await signIn(ip);
    const before = await roomCount();
    const refused = [
      [{ name: "Sprint", password: "x" }, "bad_payload"],
      [{ ownerId: "someone-else" }, "bad_payload"],
      [{ deck: "custom" }, "bad_payload"],
      [{ deck: { kind: "preset", id: "fib" } }, "bad_payload"],
      [{ name: 42 }, "bad_payload"],
      [{ name: null }, "bad_payload"],
      [[], "bad_payload"],
      [{ name: "x".repeat(MAX_ROOM_NAME_LENGTH + 1) }, "bad_room_name"],
      // Past the coarse cap (#36): refused before any cleaning.
      [{ name: "x".repeat(WIRE_LIMITS.name + 1) }, "bad_payload"],
      [{ name: "   " }, "bad_room_name"],
      [{ name: "Team\u{202E}lagel" }, "bad_room_name"],
      [{ name: "Sv\u{200B}en" }, "bad_room_name"],
    ] as const;
    for (const [body, code] of refused) {
      expect(await create(me.cookie, body, ip), JSON.stringify(body)).toMatchObject({
        status: 400,
        json: { code },
      });
    }
    expect(await roomCount()).toBe(before);
    // The longest name passes.
    const longest = "x".repeat(MAX_ROOM_NAME_LENGTH);
    expect((await create(me.cookie, { name: longest }, ip)).status).toBe(201);
  });

  it("limits creations per client address, counting TRUST_PROXY hops from the right", async () => {
    const twoHops = testConfig({ DATABASE_URL: t.url, TRUST_PROXY: "2" });
    const other = await setupServer(twoHops, logs.logger);
    closers.push(() => other.database.close());
    const server = createServer(twoHops, { ...other.deps, logger: logs.logger });
    await server.listen();
    servers.push(server);
    // The TLS proxy (172.18.0.2) is the right-most entry for everybody.
    const office = "203.0.113.50, 172.18.0.2";
    const me = await signIn(office, server);
    for (let i = 0; i < ROOM_CREATE_LIMIT.max; i++) {
      expect((await create(me.cookie, {}, office, { server })).status).toBe(201);
    }
    const throttled = await create(me.cookie, {}, office, { server });
    expect(throttled).toMatchObject({ status: 429, json: { code: "rate_limited" } });
    const retryAfter = Number(throttled.response.headers.get("retry-after"));
    expect(retryAfter).toBeGreaterThan(0);
    expect(retryAfter).toBeLessThanOrEqual(ROOM_CREATE_LIMIT.window);
    // A forged entry on the left changes nothing; the limit holds before the session.
    expect((await create(me.cookie, {}, `6.6.6.6, ${office}`, { server })).status).toBe(429);
    expect((await create("", {}, office, { server })).status).toBe(429);
    // Another address behind the same proxy is not affected.
    const neighbour = "203.0.113.51, 172.18.0.2";
    expect((await create(me.cookie, {}, neighbour, { server })).status).toBe(201);
  });
});

/** Stub randomness that spells `codes` one after the other, one batch per code. */
function spelling(codes: string[]): RandomBytes & { calls: number } {
  const random = Object.assign(
    () => {
      const code = codes[Math.min(random.calls++, codes.length - 1)] ?? "";
      return Uint8Array.from([...code].map((char) => ROOM_CODE_ALPHABET.indexOf(char)));
    },
    { calls: 0 },
  );
  return random;
}

describe("code collisions", () => {
  it("draws again when a code is taken", async () => {
    const taken = "Taken12345";
    const owner = { ownerId: "owner-1", name: null };
    expect(await insertNewRoom(database.store, owner, spelling([taken]))).not.toBeNull();
    const random = spelling([taken, taken, "Fresh12345"]);
    const stored = await insertNewRoom(database.store, owner, random);
    expect(stored?.code).toBe("Fresh12345");
    expect(random.calls).toBe(3);
  });

  it("gives up after five taken codes and answers internal", async () => {
    const taken = "Taken12345";
    await insertNewRoom(database.store, { ownerId: "o", name: null }, spelling([taken]));
    const random = spelling([taken]);
    expect(await insertNewRoom(database.store, { ownerId: "o", name: null }, random)).toBeNull();
    expect(random.calls).toBe(CODE_ATTEMPTS);

    // Through the route, on an app whose randomness only spells the taken code.
    const me = await signIn("198.51.100.5");
    const app = createApp(config, {
      logger: logs.logger,
      registerApi: (api) =>
        registerRoomApi(api, {
          auth: setup.auth,
          rooms: database.store,
          config,
          limiter: memoryRateLimit(),
          random: spelling([taken]),
        }),
    });
    const response = await app.request("/api/rooms", {
      method: "POST",
      headers: { origin: ORIGIN, "content-type": "application/json", cookie: me.cookie },
      body: "{}",
    });
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ code: "internal" });
    expect(logs.messages()).toContain("room creation: every code drawn was taken");
  });
});

describe("GET /api/rooms/:code", () => {
  it("limits reads per client address before the query, and only that address", async () => {
    const me = await signIn("198.51.100.8");
    const { json } = await create(me.cookie, { name: "Limited" }, "198.51.100.8");
    const code = (json as { code: string }).code;
    const reader = "203.0.113.77";
    for (let i = 0; i < ROOM_HEADER_LIMIT.max; i++) {
      expect((await call(`/api/rooms/${code}`, { ip: reader })).status).toBe(200);
    }
    const throttled = await call(`/api/rooms/${code}`, { ip: reader });
    expect(throttled).toMatchObject({ status: 429, json: { code: "rate_limited" } });
    expect(throttled.response.headers.get("cache-control")).toBe("no-store");
    const retryAfter = Number(throttled.response.headers.get("retry-after"));
    expect(retryAfter).toBeGreaterThan(0);
    expect(retryAfter).toBeLessThanOrEqual(ROOM_HEADER_LIMIT.window);
    // Malformed and unknown codes count too; another address is not affected.
    expect((await call("/api/rooms/abc", { ip: reader })).status).toBe(429);
    expect((await call(`/api/rooms/${code}`, { ip: "203.0.113.78" })).status).toBe(200);
  });

  it("gives a room's code and name, and nothing else", async () => {
    const me = await signIn("198.51.100.6");
    secrets.push("Refinement");
    const { json } = await create(me.cookie, { name: "Refinement" }, "198.51.100.6");
    const code = (json as { code: string }).code;
    // No session needed: the code is what grants access to the header.
    const found = await call(`/api/rooms/${code}`, {});
    expect(found.status).toBe(200);
    expect(found.json).toEqual({ code, name: "Refinement", hasPassword: false });
    expect(found.response.headers.get("cache-control")).toBe("no-store");
  });

  it("answers room_not_found, with the retention period, for an unknown or a malformed code", async () => {
    for (const code of ["Unknown123", "abc", "0OIl000000", "1234567890a", "%F0%9F%98%80"]) {
      const result = await call(`/api/rooms/${code}`, {});
      expect(result.status, code).toBe(404);
      expect(result.json, code).toEqual({
        code: "room_not_found",
        retentionDays: config.roomTtlDays,
      });
      expect(result.response.headers.get("cache-control")).toBe("no-store");
    }
  });
});
