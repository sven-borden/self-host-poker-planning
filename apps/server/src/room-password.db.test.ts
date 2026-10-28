/**
 * The room password against a real Postgres (#31): the PO sets, changes and removes it
 * over HTTP; people in the room stay, anyone else enters it once; a removed participant
 * must enter it again (AC 3); grants live in the database, so they survive a restart; a
 * brute force hits each limit, the per-room one across two instances (AC 1); and neither
 * a password nor its hash ever reaches a log line or a socket frame (AC 2).
 */
import { apply, type Command, createRoom, type RoomState } from "@pp/domain";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Config } from "./config.ts";
import type { Database } from "./database.ts";
import { createTestDatabase, testClient as dbClient, type TestDatabase } from "./db/test-db.ts";
import { hashPassword } from "./password.ts";
import { PASSWORD_LIMITS } from "./room-password.ts";
import { createServer, type PokerServer } from "./server.ts";
import { setupServer } from "./setup.ts";
import { roomCode, SESSION_COOKIE, type TestClient, testClient } from "./sync/test-support.ts";
import { collectLogs, testConfig, VALID_ENV } from "./test-support.ts";

const ORIGIN = VALID_ENV.BASE_URL;
const logs = collectLogs("trace");

let t: TestDatabase;
let admin: ReturnType<typeof dbClient>;
let config: Config;
const instances: Array<{ server: PokerServer; dispose: () => Promise<void>; database: Database }> =
  [];
const clients: TestClient[] = [];
/** Every password used here, and every hash stored: none may reach a log or a frame. */
const secrets: string[] = [];
let ipCounter = 0;
/** A fresh client address, so the sign-in limit (60 a minute per address) never bites. */
const freshIp = () => `10.9.${Math.floor(++ipCounter / 250)}.${ipCounter % 250}`;

async function startInstance() {
  const setup = await setupServer(config, logs.logger);
  const server = createServer(config, { ...setup.deps, logger: logs.logger });
  await server.listen();
  const instance = { server, dispose: setup.dispose, database: setup.database };
  instances.push(instance);
  return instance;
}

beforeAll(async () => {
  t = await createTestDatabase();
  admin = dbClient(t.url);
  config = testConfig({ DATABASE_URL: t.url, LOG_LEVEL: "trace" });
  await startInstance();
});

afterAll(async () => {
  for (const client of clients) client.close();
  for (const { server, dispose } of instances) {
    await server.close();
    await dispose();
  }
  // `live` holds the flag alone: never a password or a hash.
  const { rows } = await admin.query<{ live: string }>("select live::text as live from room");
  const live = rows.map((row) => row.live).join(" ");
  expect(live).toContain('"hasPassword": true');
  expect(live).not.toContain("argon2");
  await admin?.end();
  await t?.drop();
  // AC 2: no password and no hash, in any log line or any frame a socket received.
  const written = logs.raw.join("");
  const frames = clients.flatMap((c) => c.frames).join("\n");
  expect(secrets.length).toBeGreaterThan(5);
  // A secret this short could match by chance; every password the tests check is longer.
  for (const secret of secrets.filter((s) => s.length >= 6)) {
    expect(live).not.toContain(secret);
    expect(written).not.toContain(secret);
    expect(frames).not.toContain(secret);
  }
  expect(written).not.toContain("argon2id");
  expect(frames).not.toContain("argon2id");
}, 30_000);

function baseOf(server = instances[0]?.server): string {
  const address = server?.httpServer.address();
  if (!address || typeof address === "string") throw new Error("not listening");
  return `http://localhost:${address.port}`;
}

interface Call {
  method?: string;
  cookie?: string;
  ip?: string;
  body?: unknown;
  server?: PokerServer;
}

async function call(path: string, { method = "GET", cookie, ip, body, server }: Call = {}) {
  const response = await fetch(`${baseOf(server)}${path}`, {
    method,
    headers: {
      origin: ORIGIN,
      ...(body !== undefined && { "content-type": "application/json" }),
      ...(cookie && { cookie }),
      "x-forwarded-for": ip ?? freshIp(),
    },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return { response, status: response.status, json: text ? (JSON.parse(text) as unknown) : null };
}

interface Person {
  id: string;
  cookie: string;
}

async function guest(): Promise<Person> {
  const { response, json } = await call("/api/auth/sign-in/anonymous", {
    method: "POST",
    body: {},
  });
  const cookie = response.headers
    .getSetCookie()
    .find((line) => line.startsWith(`${SESSION_COOKIE}=`))
    ?.split(";")[0];
  const id = (json as { user?: { id?: string } }).user?.id;
  if (!cookie || !id) throw new Error("no guest");
  return { id, cookie };
}

function client(person: Person, server?: PokerServer): TestClient & { locked: { count: number } } {
  const c = testClient(baseOf(server), { cookie: person.cookie });
  const locked = { count: 0 };
  c.socket.on("locked", () => {
    locked.count += 1;
  });
  clients.push(c);
  return Object.assign(c, { locked });
}

/** A room whose PO is `po`, already seated with `seated`, written straight to the database. */
async function roomWith(po: Person, seated: Person[] = [], password?: string) {
  let state: RoomState = createRoom({ ownerId: po.id });
  const step = (actor: string, command: Command) => {
    const result = apply(state, command, { actor, now: Date.now() });
    if (!result.ok) throw new Error(result.error);
    state = result.state;
  };
  step(po.id, { type: "join", name: "Ana", role: "voter" });
  for (const [i, person] of seated.entries()) {
    step(person.id, { type: "join", name: `P${i}`, role: "voter" });
  }
  let passwordHash: string | null = null;
  if (password !== undefined) {
    step(po.id, { type: "password", on: true });
    passwordHash = await hashPassword(password);
    secrets.push(password, passwordHash);
  }
  const code = roomCode();
  const stored = await instances[0]?.database.store.insertRoom({
    code,
    name: "Locked",
    state,
    passwordHash,
  });
  if (!stored) throw new Error("no room");
  return { code, id: stored.id };
}

const setPassword = (code: string, who: Person, password: string) => {
  secrets.push(password);
  return call(`/api/rooms/${code}/password`, {
    method: "PUT",
    cookie: who.cookie,
    body: { password },
  });
};
const removePassword = (code: string, who: Person) =>
  call(`/api/rooms/${code}/password`, { method: "DELETE", cookie: who.cookie });
const tryPassword = (
  code: string,
  who: Person,
  password: string,
  ip?: string,
  server?: PokerServer,
) => {
  secrets.push(password);
  return call(`/api/rooms/${code}/access`, {
    method: "POST",
    cookie: who.cookie,
    body: { password },
    ...(ip !== undefined && { ip }),
    ...(server && { server }),
  });
};

async function storedHash(id: string): Promise<string | null> {
  const { rows } = await admin.query<{ password_hash: string | null }>(
    "select password_hash from room where id = $1",
    [id],
  );
  const hash = rows[0]?.password_hash ?? null;
  if (hash) secrets.push(hash);
  return hash;
}

describe("setting, changing and removing a password", () => {
  it("is the PO's alone, takes 4 to 128 characters, and keeps everyone in the room", async () => {
    const [ana, ben, cleo] = await Promise.all([guest(), guest(), guest()]);
    const { code, id } = await roomWith(ana, [ben]);
    const a = client(ana);
    const b = client(ben);
    const c = client(cleo);
    for (const x of [a, b, c]) expect((await x.enter(code)).ok).toBe(true);

    expect(await setPassword(code, ben, "not the PO")).toMatchObject({
      status: 403,
      json: { code: "not_allowed" },
    });
    expect(await setPassword(code, ana, "q#7")).toMatchObject({
      status: 400,
      json: { code: "bad_password" },
    });
    expect(await setPassword(code, ana, "x".repeat(129))).toMatchObject({
      status: 400,
      json: { code: "bad_password" },
    });
    expect(await storedHash(id)).toBeNull();

    const set = await setPassword(code, ana, "correct horse");
    expect(set.status).toBe(204);
    expect(set.response.headers.get("cache-control")).toBe("no-store");
    expect(await storedHash(id)).toMatch(/^\$argon2id\$/);
    for (const x of [a, b]) {
      const seen = await x.waitFor((s) => s.room.settings.hasPassword === true);
      expect(seen.snapshot.causes).toEqual([{ type: "settingsUpdated", password: "set" }]);
    }
    // Cleo watched the join form: her socket leaves the room, which she must enter again
    // with the password; she never saw the snapshot that says it has one.
    await expect.poll(() => c.locked.count).toBe(1);
    expect(c.latest()?.room.settings.hasPassword).toBe(false);
    expect(await c.cmd("join", { name: "Cleo", role: "voter" })).toEqual({
      ok: false,
      code: "room_not_found",
    });
    expect(await c.enter(code)).toEqual({ ok: false, code: "password_required" });

    // Ben leaves, and comes back later from the same device: he was in the room when the
    // password was set, so he enters without it.
    expect((await b.cmd("leave")).ok).toBe(true);
    b.close();
    const again = client(ben);
    expect((await again.enter(code)).ok).toBe(true);

    const header = await call(`/api/rooms/${code}`);
    expect(header.json).toEqual({ code, name: "Locked", hasPassword: true });
  });

  it("asks a newcomer once: a wrong password, then the right one, NFC either way", async () => {
    const [ana, dan] = await Promise.all([guest(), guest()]);
    const { code } = await roomWith(ana, [], "caf\u{e9} au lait");
    const d = client(dan);
    expect(await d.enter(code)).toEqual({ ok: false, code: "password_required" });
    expect(d.received).toHaveLength(0);
    expect(await tryPassword(code, dan, "cafe au lait")).toMatchObject({
      status: 403,
      json: { code: "wrong_password" },
    });
    const right = await tryPassword(code, dan, "cafe\u{301} au lait");
    expect(right.status).toBe(204);
    expect(right.response.headers.get("cache-control")).toBe("no-store");
    const entered = await d.enter(code);
    expect(entered.ok && entered.snapshot.room.settings.hasPassword).toBe(true);
    expect((await d.cmd("join", { name: "Dan", role: "voter" })).ok).toBe(true);
    // A second device of Dan's (the same session) needs nothing more.
    expect((await client(dan).enter(code)).ok).toBe(true);
  });

  it("makes a removed participant enter the password again (AC 3)", async () => {
    const [ana, eve] = await Promise.all([guest(), guest()]);
    const { code } = await roomWith(ana, [], "sesame street");
    const e = client(eve);
    expect((await tryPassword(code, eve, "sesame street")).status).toBe(204);
    expect((await e.enter(code)).ok).toBe(true);
    expect((await e.cmd("join", { name: "Eve", role: "voter" })).ok).toBe(true);

    const a = client(ana);
    expect((await a.enter(code)).ok).toBe(true);
    expect((await a.cmd("kick", { who: eve.id })).ok).toBe(true);
    await expect.poll(() => e.kicked.count).toBe(1);

    const back = client(eve);
    expect(await back.enter(code)).toEqual({ ok: false, code: "password_required" });
    expect((await tryPassword(code, eve, "sesame street")).status).toBe(204);
    expect((await back.enter(code)).ok).toBe(true);
    expect((await back.cmd("join", { name: "Eve", role: "voter" })).ok).toBe(true);
  });

  it("changing it drops every grant but those of the people in the room", async () => {
    const [ana, ben, fay] = await Promise.all([guest(), guest(), guest()]);
    const { code, id } = await roomWith(ana, [ben], "first one");
    // Fay entered with the password once, then left the room.
    expect((await tryPassword(code, fay, "first one")).status).toBe(204);
    const f = client(fay);
    expect((await f.enter(code)).ok).toBe(true);
    f.close();

    const a = client(ana);
    const b = client(ben);
    for (const x of [a, b]) expect((await x.enter(code)).ok).toBe(true);
    const before = await storedHash(id);
    expect((await setPassword(code, ana, "second one")).status).toBe(204);
    expect(await storedHash(id)).not.toBe(before);
    for (const x of [a, b]) {
      const seen = await x.waitFor((s) =>
        s.causes.some((cause) => cause.type === "settingsUpdated"),
      );
      expect(seen.snapshot.causes).toEqual([{ type: "settingsUpdated", password: "changed" }]);
    }
    expect(a.locked.count + b.locked.count).toBe(0);

    const returning = client(fay);
    expect(await returning.enter(code)).toEqual({ ok: false, code: "password_required" });
    expect((await tryPassword(code, fay, "first one")).status).toBe(403);
    expect((await tryPassword(code, fay, "second one")).status).toBe(204);
    expect((await returning.enter(code)).ok).toBe(true);
    // Ben stayed through the change; on another device he still enters freely.
    expect((await client(ben).enter(code)).ok).toBe(true);
  });

  it("removing it lets anyone in and drops every grant", async () => {
    const [ana, gus] = await Promise.all([guest(), guest()]);
    const { code, id } = await roomWith(ana, [], "remove me");
    const a = client(ana);
    expect((await a.enter(code)).ok).toBe(true);
    expect((await removePassword(code, gus)).status).toBe(403);
    expect((await removePassword(code, ana)).status).toBe(204);
    const seen = await a.waitFor((s) => s.room.settings.hasPassword === false);
    expect(seen.snapshot.causes).toEqual([{ type: "settingsUpdated", password: "removed" }]);
    expect(await storedHash(id)).toBeNull();
    const { rows } = await admin.query("select 1 from room_access where room_id = $1", [id]);
    expect(rows).toHaveLength(0);
    expect((await client(gus).enter(code)).ok).toBe(true);
    // Removing it again changes nothing.
    expect((await removePassword(code, ana)).status).toBe(204);
    expect(a.latest()?.version).toBe(seen.snapshot.version);
  });

  it("keeps grants in the database: they survive a restart", async () => {
    const [ana, hal] = await Promise.all([guest(), guest()]);
    const { code } = await roomWith(ana, [], "persist me");
    expect((await tryPassword(code, hal, "persist me")).status).toBe(204);
    const fresh = await startInstance();
    expect((await client(hal, fresh.server).enter(code)).ok).toBe(true);
  });

  it("refuses another origin, a body that is not JSON, and an unknown room", async () => {
    const ana = await guest();
    const { code } = await roomWith(ana, [], "origin check");
    const foreign = await fetch(`${baseOf()}/api/rooms/${code}/access`, {
      method: "POST",
      headers: {
        origin: "https://evil.example",
        "content-type": "application/json",
        cookie: ana.cookie,
      },
      body: JSON.stringify({ password: "origin check" }),
    });
    expect(foreign.status).toBe(403);
    const text = await fetch(`${baseOf()}/api/rooms/${code}/password`, {
      method: "PUT",
      headers: { origin: ORIGIN, "content-type": "text/plain", cookie: ana.cookie },
      body: "origin check",
    });
    expect(text.status).toBe(415);
    expect((await tryPassword(roomCode(), ana, "origin check")).status).toBe(404);
    expect(
      (await call(`/api/rooms/${code}/access`, { method: "POST", body: { password: "x" } })).status,
    ).toBe(401);
  });
});

describe("a brute force hits the limit (AC 1)", () => {
  it("10 wrong tries per address and room, then rate_limited, even for the right password", async () => {
    const [ana, ivy] = await Promise.all([guest(), guest()]);
    const { code } = await roomWith(ana, [], "per address");
    const ip = freshIp();
    for (let i = 0; i < PASSWORD_LIMITS.addressRoom.max; i++) {
      expect((await tryPassword(code, ivy, `guess ${i}`, ip)).status).toBe(403);
    }
    const limited = await tryPassword(code, ivy, "per address", ip);
    expect(limited).toMatchObject({ status: 429, json: { code: "rate_limited" } });
    const wait = Number(limited.response.headers.get("retry-after"));
    expect(wait).toBeGreaterThan(500);
    expect(wait).toBeLessThanOrEqual(600);
    // Another address still gets its own tries.
    expect((await tryPassword(code, ivy, "per address")).status).toBe(204);
  }, 60_000);

  it("50 wrong tries per room from any addresses, counted across two instances", async () => {
    const [ana, jon] = await Promise.all([guest(), guest()]);
    const { code } = await roomWith(ana, [], "per room");
    const second = instances[1]?.server ?? (await startInstance()).server;
    for (let i = 0; i < PASSWORD_LIMITS.room.max; i++) {
      const server = i % 2 === 0 ? instances[0]?.server : second;
      const ip = `10.50.${Math.floor(i / 5)}.1`;
      expect((await tryPassword(code, jon, `guess ${i}`, ip, server)).status).toBe(403);
    }
    for (const server of [instances[0]?.server, second]) {
      const limited = await tryPassword(code, jon, "per room", freshIp(), server);
      expect(limited).toMatchObject({ status: 429, json: { code: "rate_limited" } });
      expect(Number(limited.response.headers.get("retry-after"))).toBeGreaterThan(500);
    }
  }, 120_000);

  it("100 wrong tries per address across rooms", async () => {
    const [ana, kim] = await Promise.all([guest(), guest()]);
    const ip = freshIp();
    const rooms = PASSWORD_LIMITS.address.max / PASSWORD_LIMITS.addressRoom.max;
    for (let r = 0; r < rooms; r++) {
      const { code } = await roomWith(ana, [], `room ${r}`);
      for (let i = 0; i < PASSWORD_LIMITS.addressRoom.max; i++) {
        expect((await tryPassword(code, kim, `guess ${i}`, ip)).status).toBe(403);
      }
    }
    const { code } = await roomWith(ana, [], "one more room");
    expect(await tryPassword(code, kim, "one more room", ip)).toMatchObject({
      status: 429,
      json: { code: "rate_limited" },
    });
    expect((await tryPassword(code, kim, "one more room")).status).toBe(204);
  }, 180_000);

  it("a right password does not count against any limit", async () => {
    const [ana, lea] = await Promise.all([guest(), guest()]);
    const { code } = await roomWith(ana, [], "always right");
    const ip = freshIp();
    for (let i = 0; i < PASSWORD_LIMITS.addressRoom.max + 2; i++) {
      expect((await tryPassword(code, lea, "always right", ip)).status).toBe(204);
    }
  }, 60_000);
});
