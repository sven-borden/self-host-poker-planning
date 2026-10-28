/**
 * The room password against a real Postgres (#31): the PO sets, changes and removes it
 * over HTTP; people in the room stay, anyone else enters it once; a removed participant
 * must enter it again (AC 3); grants live in the database, so they survive a restart; a
 * brute force hits each limit, the per-room one across two instances (AC 1); and neither
 * a password nor its hash ever reaches a log line or a socket frame (AC 2), even with a
 * logger that redacts nothing; each limit counts exactly, with tries sent at once; members
 * skip the check; a burst of right passwords waits in line instead of being refused; and a
 * grant never outlives the password it was given for (B1), over HTTP or on the socket.
 */
import { apply, type Command, createRoom, type RoomState } from "@pp/domain";
import pino from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Config } from "./config.ts";
import type { Database } from "./database.ts";
import { createTestDatabase, testClient as dbClient, type TestDatabase } from "./db/test-db.ts";
import { hashPassword } from "./password.ts";
import { PASSWORD_LIMITS } from "./room-password.ts";
import { createServer, type PokerServer } from "./server.ts";
import { setupServer } from "./setup.ts";
import { createRoomSync } from "./sync/room-sync.ts";
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
  const instance = {
    server,
    dispose: () => setup.dispose?.() ?? Promise.resolve(),
    database: setup.database,
  };
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
  it("is the PO's alone, takes 6 to 128 characters, and keeps everyone in the room", async () => {
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
    for (const short of ["q#7", "5char"]) {
      expect(await setPassword(code, ana, short)).toMatchObject({
        status: 400,
        json: { code: "bad_password" },
      });
    }
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

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** How many answers had each status. */
function statuses(answers: ReadonlyArray<{ status: number }>): Record<number, number> {
  const by: Record<number, number> = {};
  for (const { status } of answers) by[status] = (by[status] ?? 0) + 1;
  return by;
}

const retryAfterOf = (answer: { response: Response }) =>
  Number(answer.response.headers.get("retry-after"));

describe("a brute force hits the limits (AC 1), counted exactly", () => {
  it("10 wrong tries per person and room, sent at once; others at that address go on", async () => {
    const [ana, ivy, max] = await Promise.all([guest(), guest(), guest()]);
    const { code } = await roomWith(ana, [], "per person");
    const ip = freshIp();
    // Each try is reserved before the check, so tries at once are counted exactly.
    const tries = await Promise.all(
      Array.from({ length: 14 }, (_, i) => tryPassword(code, ivy, `guess ${i} wrong`, ip)),
    );
    expect(statuses(tries)).toEqual({ 403: 10, 429: 4 });
    const limited = await tryPassword(code, ivy, "per person", ip);
    expect(limited).toMatchObject({ status: 429, json: { code: "rate_limited" } });
    expect(retryAfterOf(limited)).toBeGreaterThan(500);
    expect(retryAfterOf(limited)).toBeLessThanOrEqual(600);
    // Max sits behind the same address (one office, one proxy): Ivy's tries cost him nothing.
    expect((await tryPassword(code, max, "per person", ip)).status).toBe(204);
  }, 60_000);

  it("25 wrong tries per address and room, whatever the sessions: the room keeps the rest", async () => {
    const [ana, ...burners] = (await Promise.all(Array.from({ length: 5 }, () => guest()))) as [
      Person,
      ...Person[],
    ];
    const { code } = await roomWith(ana, [], "per address");
    const ip = freshIp();
    // Three sessions on one address, ten each at once: 25 are checked, never more.
    const tries = await Promise.all(
      burners
        .slice(0, 3)
        .flatMap((who, n) =>
          Array.from({ length: 10 }, (_, i) => tryPassword(code, who, `burn ${n}.${i} wrong`, ip)),
        ),
    );
    expect(statuses(tries)).toEqual({ 403: 25, 429: 5 });
    const limited = await tryPassword(code, burners[3] as Person, "per address", ip);
    expect(limited).toMatchObject({ status: 429, json: { code: "rate_limited" } });
    expect(retryAfterOf(limited)).toBeGreaterThan(500);
    // A newcomer elsewhere still gets in: the room spent 25 of its 50.
    expect((await tryPassword(code, burners[3] as Person, "per address")).status).toBe(204);
    const { rows } = await admin.query<{ password_failures: number }>(
      "select password_failures from room where code = $1",
      [code],
    );
    expect(rows[0]?.password_failures).toBe(25);
  }, 60_000);

  it("50 wrong tries per room from anyone, across two instances, sent at once", async () => {
    const [ana, ...people] = (await Promise.all(Array.from({ length: 10 }, () => guest()))) as [
      Person,
      ...Person[],
    ];
    const { code } = await roomWith(ana, [], "per room");
    const second = instances[1]?.server ?? (await startInstance()).server;
    const servers = [instances[0]?.server, second];
    const wrong = (who: Person, n: number, i: number) =>
      tryPassword(code, who, `guess ${n}.${i} wrong`, freshIp(), servers[i % 2]);
    // 40 wrong tries: five people, eight each at once.
    for (const [n, who] of people.slice(0, 5).entries()) {
      const batch = await Promise.all(Array.from({ length: 8 }, (_, i) => wrong(who, n, i)));
      expect(statuses(batch)).toEqual({ 403: 8 });
    }
    // A right password is reserved like any other try, and given back.
    for (const who of people.slice(5, 7)) {
      expect((await tryPassword(code, who, "per room", freshIp(), second)).status).toBe(204);
    }
    // 18 at once, for the last 10 places.
    const last = await Promise.all(
      [7, 8].flatMap((n) => Array.from({ length: 9 }, (_, i) => wrong(people[n] as Person, n, i))),
    );
    expect(statuses(last)).toEqual({ 403: 10, 429: 8 });
    for (const server of servers) {
      const limited = await tryPassword(code, people[4] as Person, "per room", freshIp(), server);
      expect(limited).toMatchObject({ status: 429, json: { code: "rate_limited" } });
      expect(retryAfterOf(limited)).toBeGreaterThan(500);
    }
  }, 120_000);

  it("300 checks per address, right, wrong or for no room, then rate_limited", async () => {
    const [ana, lea] = await Promise.all([guest(), guest()]);
    const { code } = await roomWith(ana, [], "address guard");
    const ip = freshIp();
    expect((await tryPassword(code, lea, "address guard", ip)).status).toBe(204);
    // A 404 tells that a room does not exist: those count too.
    for (let sent = 1; sent < PASSWORD_LIMITS.address.max; sent += 33) {
      const n = Math.min(33, PASSWORD_LIMITS.address.max - sent);
      const batch = await Promise.all(
        Array.from({ length: n }, (_, i) =>
          i % 3 === 0
            ? tryPassword(code, lea, "address guard", ip)
            : tryPassword(roomCode(), lea, "no such room", ip),
        ),
      );
      expect(batch.every(({ status }) => status === 204 || status === 404)).toBe(true);
    }
    const limited = await tryPassword(code, lea, "address guard", ip);
    expect(limited).toMatchObject({ status: 429, json: { code: "rate_limited" } });
    expect(retryAfterOf(limited)).toBeGreaterThan(500);
    expect((await tryPassword(code, lea, "address guard")).status).toBe(204);
  }, 60_000);

  it("a password outside the bounds is wrong without a check or a try counted (N4)", async () => {
    const [ana, mia] = await Promise.all([guest(), guest()]);
    const { code } = await roomWith(ana, [], "in bounds");
    const ip = freshIp();
    for (const outside of ["short", "x".repeat(129)]) {
      for (let i = 0; i < PASSWORD_LIMITS.user.max + 2; i++) {
        expect(await tryPassword(code, mia, outside, ip)).toMatchObject({
          status: 403,
          json: { code: "wrong_password" },
        });
      }
    }
    expect((await tryPassword(code, mia, "in bounds", ip)).status).toBe(204);
  }, 60_000);
});

describe("who is checked, and how many at once", () => {
  it("the PO, a participant and a grant holder get in for any password, unchecked", async () => {
    const [ana, ben, dan, eli] = await Promise.all([guest(), guest(), guest(), guest()]);
    const { code } = await roomWith(ana, [ben], "members skip");
    expect((await tryPassword(code, dan, "members skip")).status).toBe(204);
    for (const who of [ana, ben, dan]) {
      expect((await tryPassword(code, who, "not the password")).status).toBe(204);
    }
    expect((await tryPassword(code, eli, "not the password")).status).toBe(403);
  });

  it("16 right passwords sent at once all pass: they wait in line, none is refused (S1)", async () => {
    const [ana, ...people] = (await Promise.all(Array.from({ length: 17 }, () => guest()))) as [
      Person,
      ...Person[],
    ];
    const { code } = await roomWith(ana, [], "all at once");
    const answers = await Promise.all(
      people.map((who) => tryPassword(code, who, "all at once", freshIp())),
    );
    expect(statuses(answers)).toEqual({ 204: 16 });
  }, 60_000);
});

describe("a grant never outlives the password it was given for (B1)", () => {
  it("waits for a change in progress and is not written under the old hash", async () => {
    const [ana, dan] = await Promise.all([guest(), guest()]);
    const { code, id } = await roomWith(ana, [], "before change");
    const store = instances[0]?.database.store;
    if (!store) throw new Error("not started");
    const old = await storedHash(id);
    if (!old) throw new Error("no hash");
    const next = await hashPassword("after change");
    secrets.push("after change", next);
    // The PO's change, held open mid-transaction: the hash written, every grant dropped.
    const change = await admin.connect();
    try {
      await change.query("begin");
      await change.query("update room set password_hash = $1 where id = $2", [next, id]);
      await change.query("delete from room_access where room_id = $1", [id]);
      let settled = false;
      const grant = store.grantAccess(id, dan.id, old).finally(() => {
        settled = true;
      });
      await sleep(150);
      expect(settled).toBe(false);
      await change.query("commit");
      expect(await grant).toBe(false);
    } finally {
      change.release();
    }
    const { rows } = await admin.query(
      "select 1 from room_access where room_id = $1 and user_id = $2",
      [id, dan.id],
    );
    expect(rows).toHaveLength(0);
    expect(await store.grantAccess(id, dan.id, next)).toBe(true);
    expect(await store.grantAccess(id, dan.id, next)).toBe(true);
    expect((await client(dan).enter(code)).ok).toBe(true);
  });

  it("the old password, checked while the PO changes it, lets nobody in over HTTP", async () => {
    const ana = await guest();
    let current = "old password 0";
    const { code } = await roomWith(ana, [], current);
    for (const [n, delay] of [0, 5, 10, 15, 20, 25, 30, 40].entries()) {
      const joiner = await guest();
      const old = current;
      current = `new password ${n + 1}`;
      const [change, check] = await Promise.all([
        setPassword(code, ana, current),
        sleep(delay).then(() => tryPassword(code, joiner, old)),
      ]);
      expect(change.status).toBe(204);
      expect([204, 403]).toContain(check.status);
      expect(await client(joiner).enter(code)).toEqual({ ok: false, code: "password_required" });
    }
  }, 60_000);

  it("an enter that reads a grant while the password changes is refused on the socket", async () => {
    const [ana, dan] = await Promise.all([guest(), guest()]);
    const { code } = await roomWith(ana, [], "socket before");
    expect((await tryPassword(code, dan, "socket before")).status).toBe(204);
    // An instance whose grant check lets the PO's change commit (and lock the room out)
    // between reading the grant and admitting the socket.
    const setup = await setupServer(config, logs.logger);
    const { runner, store } = setup.database;
    let during: (() => Promise<void>) | undefined;
    const sync = createRoomSync({
      runner,
      store,
      logger: logs.logger,
      access: {
        hasAccess: async (roomId, who) => {
          const granted = await store.hasAccess(roomId, who);
          const run = during;
          during = undefined;
          await run?.();
          return granted;
        },
      },
    });
    const server = createServer(config, { ...setup.deps, handlers: sync, logger: logs.logger });
    await server.listen();
    instances.push({
      server,
      dispose: async () => {
        sync.close();
        await setup.dispose?.();
      },
      database: setup.database,
    });
    const next = await hashPassword("socket after");
    secrets.push("socket after", next);
    during = async () => {
      expect((await sync.changePassword(code, ana.id, next)).ok).toBe(true);
    };
    const d = client(dan, server);
    expect(await d.enter(code)).toEqual({ ok: false, code: "password_required" });
    expect(during).toBeUndefined();
    expect(d.received).toHaveLength(0);
    // With the new password, Dan enters on that instance.
    expect((await tryPassword(code, dan, "socket after")).status).toBe(204);
    expect((await d.enter(code)).ok).toBe(true);
  });
});

describe("a join commits only with the grant it needs (B1, the kick race)", () => {
  it("the commit itself refuses a join without a grant, and writes nothing", async () => {
    const [ana, eve] = await Promise.all([guest(), guest()]);
    const { code, id } = await roomWith(ana, [], "commit check");
    const store = instances[0]?.database.store;
    if (!store) throw new Error("not started");
    const loaded = await store.loadRoom(code);
    if (!loaded) throw new Error("no room");
    const joined = apply(
      loaded.state,
      { type: "join", name: "Eve", role: "voter" },
      { actor: eve.id, now: Date.now() },
    );
    if (!joined.ok) throw new Error(joined.error);
    const needs = { requireGrant: eve.id };
    expect(await store.commitRoom(id, loaded.version, joined.state, undefined, needs)).toBe(
      "password_required",
    );
    expect((await store.loadRoom(code))?.version).toBe(loaded.version);
    expect((await tryPassword(code, eve, "commit check")).status).toBe(204);
    expect(await store.commitRoom(id, loaded.version, joined.state, undefined, needs)).toBe(true);
  });

  /**
   * Eve's sockets send `join` every 105 ms (the socket limit is 10 a second) while the PO
   * removes her, then changes the password: a join that passed the check before the kick
   * waits behind it, and must not seat her again. On one instance, and with her sockets on
   * another instance than the PO's, where nothing but the database orders them.
   */
  it("a removed person's joins in flight never bring them back, on one or two instances", async () => {
    const second = instances[1]?.server ?? (await startInstance()).server;
    for (const [trial, eveOn] of [undefined, undefined, second, second, second].entries()) {
      const [ana, eve] = await Promise.all([guest(), guest()]);
      const { code } = await roomWith(ana, [], `kick race ${trial}`);
      expect((await tryPassword(code, eve, `kick race ${trial}`)).status).toBe(204);
      const a = client(ana);
      expect((await a.enter(code)).ok).toBe(true);
      const eves = [0, 1, 2, 3].map(() => client(eve, eveOn));
      for (const e of eves) expect((await e.enter(code)).ok).toBe(true);
      expect((await eves[0]?.cmd("join", { name: "Eve", role: "voter" }))?.ok).toBe(true);
      let stop = false;
      const loop = async (e: TestClient, offset: number) => {
        await sleep(offset);
        while (!stop && e.socket.connected) {
          void e.cmd("join", { name: "Eve", role: "voter" }).catch(() => undefined);
          await sleep(105);
        }
      };
      const loops = eves.map((e, i) => loop(e, (i * 105) / eves.length));
      await sleep(300 + trial * 20);
      expect((await a.cmd("kick", { who: eve.id })).ok).toBe(true);
      expect((await setPassword(code, ana, `kick race new ${trial}`)).status).toBe(204);
      await sleep(500);
      stop = true;
      await Promise.all(loops);
      await sleep(200);
      const view = await client(ana).enter(code);
      expect(view.ok && view.snapshot.room.participants.some((p) => p.id === eve.id)).toBe(false);
      expect(await client(eve, eveOn).enter(code)).toEqual({
        ok: false,
        code: "password_required",
      });
      for (const e of eves) e.close();
    }
  }, 60_000);
});

describe("a request body never reaches a log line", () => {
  it("not even through a logger that redacts nothing", async () => {
    const raw: string[] = [];
    const bare = pino({ level: "trace" }, { write: (chunk: string) => void raw.push(chunk) });
    const setup = await setupServer(config, bare);
    const server = createServer(config, { ...setup.deps, logger: bare });
    await server.listen();
    instances.push({
      server,
      dispose: () => setup.dispose?.() ?? Promise.resolve(),
      database: setup.database,
    });
    const [ana, ben] = await Promise.all([guest(), guest()]);
    const { code, id } = await roomWith(ana);
    const secret = "plain sight 1";
    const wrongOne = "plain sight 2";
    secrets.push(secret, wrongOne);
    const send = (method: string, path: string, who: Person, body: unknown) =>
      call(path, { method, cookie: who.cookie, body, server });
    const set = await send("PUT", `/api/rooms/${code}/password`, ana, { password: secret });
    expect(set.status).toBe(204);
    const access = `/api/rooms/${code}/access`;
    expect((await send("POST", access, ben, { password: wrongOne })).status).toBe(403);
    expect((await send("POST", access, ben, { password: secret, x: 1 })).status).toBe(400);
    expect((await send("POST", access, ben, { password: secret })).status).toBe(204);
    const hash = await storedHash(id);
    const written = raw.join("");
    expect(written).toContain("room access granted");
    for (const text of [secret, wrongOne, hash ?? "argon2id", "argon2id", code]) {
      expect(written).not.toContain(text);
    }
  });
});
