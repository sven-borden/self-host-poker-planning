/**
 * "My rooms" (#49, ADR-027) over the real thing: Postgres, a real sign-in against the stand-in
 * provider, real sockets and their frames.
 *
 * What it holds: only an account reaches any of this; the list is the rooms a person owns or holds
 * a seat in, and says nothing of anyone else; a guest's pending move is finished first, and a
 * failing one breaks nothing; rename and delete are the owner's alone, on a fresh read; a room
 * that goes takes everything with it, and its sockets and timers stop; retention leaves what
 * ADR-014 says; and the list reads indexes, however many rooms the instance holds.
 */
import { performance } from "node:perf_hooks";
import { createRoom } from "@pp/domain";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Config } from "./config.ts";
import { createGuestLinkStore } from "./db/guest-links.ts";
import { createTestDatabase, type TestDatabase, testClient } from "./db/test-db.ts";
import {
  atFake,
  FAKE_PERSON_PARAM,
  type FakeOidc,
  fakePersonParam,
  routeProvidersTo,
  startFakeOidc,
} from "./fake-oidc.ts";
import { MY_ROOMS_CHANGE_LIMIT, MY_ROOMS_PAGE, MY_ROOMS_SETTLE_MS } from "./my-rooms.ts";
import { createServer, type PokerServer } from "./server.ts";
import { setupServer } from "./setup.ts";
import type { RoomSync } from "./sync/room-sync.ts";
import {
  roomCode,
  snapshotsIn,
  testClient as socketClient,
  type TestClient,
} from "./sync/test-support.ts";
import { collectLogs, testConfig, VALID_ENV } from "./test-support.ts";

const ORIGIN = VALID_ENV.BASE_URL;
const KEYS = {
  GOOGLE_CLIENT_ID: "test-google-client-id",
  GOOGLE_CLIENT_SECRET: "test-google-secret-do-not-log",
} as const;
const A_ROOM_NAME = "Quiet-Room-Name-In-No-Log";

const logs = collectLogs("debug");
let t: TestDatabase;
let admin: ReturnType<typeof testClient>;
let config: Config;
let fake: FakeOidc;
let restoreFetch: () => void;
let server: PokerServer;
let setup: Awaited<ReturnType<typeof setupServer>>;
let sync: RoomSync;
let at = "";
const open: TestClient[] = [];
const codes: string[] = [];

beforeAll(async () => {
  fake = await startFakeOidc();
  restoreFetch = routeProvidersTo(fake.origin);
  t = await createTestDatabase();
  admin = testClient(t.url);
  config = testConfig({ DATABASE_URL: t.url, TRUST_PROXY: "1", ...KEYS });
  setup = await setupServer(config, logs.logger);
  sync = setup.deps?.handlers as RoomSync;
  server = createServer(config, { ...setup.deps, logger: logs.logger });
  await server.listen();
  const bound = server.httpServer.address();
  if (!bound || typeof bound === "string") throw new Error("not listening");
  at = `http://localhost:${bound.port}`;
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const client of open.splice(0)) client.close();
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
  expect(everything).not.toContain(A_ROOM_NAME);
  for (const code of codes) expect(everything).not.toContain(code);
});

let addresses = 0;
let people = 0;

/** A browser's cookie jar over `fetch`, at an address of its own. */
class Browser {
  readonly jar = new Map<string, string>();
  readonly address = `198.51.${Math.floor(addresses / 250)}.${(addresses++ % 250) + 1}`;
  id = "";

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

  post(path: string, body: unknown): Promise<Response> {
    return this.go(path, {
      method: "POST",
      headers: { origin: ORIGIN, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  patch(path: string, body: unknown): Promise<Response> {
    return this.go(path, {
      method: "PATCH",
      headers: { origin: ORIGIN, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  remove(path: string): Promise<Response> {
    return this.go(path, { method: "DELETE", headers: { origin: ORIGIN } });
  }

  async whoAmI(): Promise<string> {
    const response = await this.go("/api/auth/get-session");
    const session = (await response.json()) as { user: { id: string } } | null;
    this.id = session?.user.id ?? "";
    return this.id;
  }

  async asGuest(): Promise<this> {
    const response = await this.post("/api/auth/sign-in/anonymous", {});
    expect(response.status).toBe(200);
    await this.whoAmI();
    return this;
  }

  /** Signs in as a new person of the stand-in provider, or `who` when given. */
  async asAccount(who = ++people): Promise<this> {
    const started = await this.post("/api/auth/sign-in/social", {
      provider: "google",
      returnTo: "/rooms",
    });
    expect(started.status).toBe(200);
    const { url } = (await started.json()) as { url: string };
    const person = fakePersonParam({
      id: `my-rooms-person-${who}`,
      email: `my-rooms-${who}@example.com`,
      name: `My Rooms Person ${who}`,
      emailVerified: true,
    });
    const answer = await fetch(`${atFake(url, fake.origin)}&${FAKE_PERSON_PARAM}=${person}`, {
      redirect: "manual",
    });
    const back = new URL(answer.headers.get("location") ?? "");
    const landed = await this.go(`${back.pathname}${back.search}`);
    expect(landed.headers.get("location")).toBe(`${ORIGIN}/rooms`);
    await this.whoAmI();
    return this;
  }

  socket(): TestClient {
    const client = socketClient(at, { cookie: this.cookie });
    open.push(client);
    return client;
  }

  async sit(code: string, name = "Sitter"): Promise<TestClient> {
    const client = this.socket();
    await expect(client.enter(code)).resolves.toMatchObject({ ok: true });
    await expect(client.cmd("join", { name, role: "voter" })).resolves.toMatchObject({ ok: true });
    return client;
  }

  async list(query = ""): Promise<ListAnswer> {
    const response = await this.go(`/api/my-rooms${query}`);
    expect(response.status).toBe(200);
    return (await response.json()) as ListAnswer;
  }
}

interface ListedRoom {
  id: string;
  code: string;
  name: string | null;
  owned: boolean;
  rounds: number;
  lastActiveAt: string;
}

interface ListAnswer {
  rooms: ListedRoom[];
  retentionDays: number;
  next?: string;
  moving?: true;
}

const signedIn = () => new Browser().asAccount();

async function roomOf(ownerId: string, name: string | null = null) {
  const code = roomCode();
  codes.push(code);
  const stored = await setup.database.store.insertRoom({
    code,
    name,
    state: createRoom({ ownerId }),
  });
  if (!stored) throw new Error("code taken");
  return stored;
}

const countOf = async (table: string, column: string, id: string) => {
  const { rows } = await admin.query(
    `select count(*)::int as n from ${table} where ${column} = $1`,
    [id],
  );
  return (rows[0] as { n: number }).n;
};

const nameIn = async (id: string) => {
  const { rows } = await admin.query("select name from room where id = $1", [id]);
  return (rows[0] as { name: string | null } | undefined)?.name;
};

describe("who may reach it", () => {
  const routes = (id: string): [string, (b: Browser) => Promise<Response>][] => [
    ["list", (b) => b.go("/api/my-rooms")],
    ["rename", (b) => b.patch(`/api/my-rooms/${id}`, { name: "New" })],
    ["delete", (b) => b.remove(`/api/my-rooms/${id}`)],
    ["leave", (b) => b.post(`/api/my-rooms/${id}/leave`, {})],
  ];

  it("refuses a visitor with no session and a guest, on every route, without touching a room", async () => {
    const owner = await signedIn();
    const room = await roomOf(owner.id, "Kept");
    const guest = await new Browser().asGuest();
    for (const [, call] of routes(room.id)) {
      const none = await call(new Browser());
      expect(none.status).toBe(401);
      expect(await none.json()).toEqual({ code: "unauthenticated" });
      expect(none.headers.get("cache-control")).toBe("no-store");
      const refused = await call(guest);
      expect(refused.status).toBe(403);
      expect(await refused.json()).toEqual({ code: "not_allowed" });
      expect(refused.headers.get("cache-control")).toBe("no-store");
    }
    expect(await nameIn(room.id)).toBe("Kept");
  });

  it("refuses a guest who owns the room too", async () => {
    const guest = await new Browser().asGuest();
    const room = await roomOf(guest.id, "A guest's");
    expect((await guest.remove(`/api/my-rooms/${room.id}`)).status).toBe(403);
    expect((await guest.patch(`/api/my-rooms/${room.id}`, { name: "No" })).status).toBe(403);
    expect(await nameIn(room.id)).toBe("A guest's");
  });

  it("refuses another site's page on every route, even with a cookie", async () => {
    const owner = await signedIn();
    const room = await roomOf(owner.id);
    const foreign = { origin: "https://evil.example", "content-type": "application/json" };
    for (const [path, method] of [
      ["/api/my-rooms", "GET"],
      [`/api/my-rooms/${room.id}`, "PATCH"],
      [`/api/my-rooms/${room.id}`, "DELETE"],
      [`/api/my-rooms/${room.id}/leave`, "POST"],
    ] as const) {
      const response = await owner.go(path, {
        method,
        headers: foreign,
        ...(method === "PATCH" && { body: JSON.stringify({ name: "x" }) }),
      });
      expect(response.status).toBe(403);
    }
    expect(await countOf("room", "id", room.id)).toBe(1);
  });

  it("takes only JSON, and nothing over 16 KB", async () => {
    const owner = await signedIn();
    const room = await roomOf(owner.id);
    const headers = { origin: ORIGIN, "content-type": "text/plain" };
    const rename = await owner.go(`/api/my-rooms/${room.id}`, {
      method: "PATCH",
      headers,
      body: '{"name":"x"}',
    });
    expect(rename.status).toBe(415);
    const leave = await owner.go(`/api/my-rooms/${room.id}/leave`, {
      method: "POST",
      headers,
      body: "{}",
    });
    expect(leave.status).toBe(415);
    const large = await owner.patch(`/api/my-rooms/${room.id}`, { name: "x".repeat(17_000) });
    expect(large.status).toBe(413);
    expect(await large.json()).toEqual({ code: "bad_payload" });
    const shape = await owner.patch(`/api/my-rooms/${room.id}`, { name: "x", extra: 1 });
    expect(shape.status).toBe(400);
  });

  it("answers a malformed id or cursor without a query that fails", async () => {
    const owner = await signedIn();
    expect((await owner.remove("/api/my-rooms/not-a-uuid")).status).toBe(404);
    expect((await owner.patch("/api/my-rooms/not-a-uuid", { name: "x" })).status).toBe(404);
    expect((await owner.post("/api/my-rooms/not-a-uuid/leave", {})).status).toBe(404);
    const unknown = "00000000-0000-4000-8000-000000000000";
    expect((await owner.remove(`/api/my-rooms/${unknown}`)).status).toBe(404);
    for (const after of ["x", "1_x", `99999999999999999_${unknown}`.replace("_", "9_")]) {
      const response = await owner.go(`/api/my-rooms?after=${after}`);
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ code: "bad_payload" });
    }
  });

  it("counts changes per person, the refusal in the usual shape", async () => {
    const owner = await signedIn();
    const room = await roomOf(owner.id);
    for (let n = 0; n < MY_ROOMS_CHANGE_LIMIT.max; n++) {
      expect((await owner.patch(`/api/my-rooms/${room.id}`, { name: `Name ${n}` })).status).toBe(
        200,
      );
    }
    const refused = await owner.patch(`/api/my-rooms/${room.id}`, { name: "One more" });
    expect(refused.status).toBe(429);
    expect(refused.headers.get("retry-after")).not.toBeNull();
    expect(await refused.json()).toEqual({ code: "rate_limited" });
  });
});

describe("the list", () => {
  it("shows the rooms a person owns or holds a seat in, and no one else's", async () => {
    const me = await signedIn();
    const other = await signedIn();
    const owned = await roomOf(me.id, "Mine");
    const seated = await roomOf(other.id, "Theirs, with my seat");
    const neither = await roomOf(other.id, "Not mine");
    await me.sit(seated.code);

    const { rooms, retentionDays } = await me.list();

    expect(rooms.map(({ id }) => id).sort()).toEqual([owned.id, seated.id].sort());
    expect(rooms.find(({ id }) => id === neither.id)).toBeUndefined();
    expect(rooms.find(({ id }) => id === owned.id)?.owned).toBe(true);
    expect(rooms.find(({ id }) => id === seated.id)?.owned).toBe(false);
    expect(retentionDays).toBe(config.roomTtlDays);
  });

  it("says nothing of anyone else, not a name, a count or a vote", async () => {
    const me = await signedIn();
    const other = await signedIn();
    const room = await roomOf(me.id, "Anonymous round");
    const po = await me.sit(room.code, "Name-Of-The-PO");
    const voter = await other.sit(room.code, "Name-Of-A-Voter");
    await po.cmd("updateSettings", { patch: { revealNames: false } });
    await po.cmd("startRound", { subject: { kind: "title", text: "Secret-Subject" }, round: 0 });
    await voter.cmd("castVote", { card: "13", round: 1 });

    const response = await me.go("/api/my-rooms");
    const text = await response.text();

    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(Object.keys(JSON.parse(text).rooms[0]).sort()).toEqual([
      "code",
      "id",
      "lastActiveAt",
      "name",
      "owned",
      "rounds",
    ]);
    for (const secret of ["Name-Of", "Secret-Subject", other.id, '"13"']) {
      expect(text).not.toContain(secret);
    }
  });

  it("drops a room when the person leaves it or is removed, even with a card on the table", async () => {
    const me = await signedIn();
    const other = await signedIn();
    const left = await roomOf(other.id, "Left");
    const removed = await roomOf(other.id, "Removed");
    for (const room of [left, removed]) {
      const po = await other.sit(room.code, "PO");
      const mine = await me.sit(room.code, "Me");
      await po.cmd("startRound", { subject: { kind: "none" }, round: 0 });
      await mine.cmd("castVote", { card: "5", round: 1 });
      await po.cmd("reveal");
      if (room === left) await mine.cmd("leave");
      else await po.cmd("kick", { who: me.id });
    }
    // The kept card still names the person: `ROOM_PEOPLE` finds the room, the list must not.
    const { rows } = await admin.query(
      `select count(*)::int as n from room where id = any($1::uuid[])
       and ((live -> 'participants') || coalesce(live #> '{round,votes}', '{}'::jsonb)) ? $2`,
      [[left.id, removed.id], me.id],
    );
    expect((rows[0] as { n: number }).n).toBeGreaterThan(0);
    expect((await me.list()).rooms).toEqual([]);
  });

  it("gives the rounds as a number the room holds, the last active first", async () => {
    const me = await signedIn();
    const quiet = await roomOf(me.id, "Quiet");
    const played = await roomOf(me.id, "Played");
    const po = await me.sit(played.code);
    await po.cmd("startRound", { subject: { kind: "none" }, round: 0 });
    await po.cmd("startRound", { subject: { kind: "none" }, round: 1 });

    const { rooms } = await me.list();

    expect(rooms.map(({ name }) => name)).toEqual(["Played", "Quiet"]);
    expect(rooms[0]?.rounds).toBe(2);
    expect(rooms[1]?.rounds).toBe(0);
    expect(Date.parse(rooms[0]?.lastActiveAt ?? "")).toBeGreaterThan(
      Date.parse(rooms[1]?.lastActiveAt ?? ""),
    );
    expect(await countOf("room", "id", quiet.id)).toBe(1);
  });

  it("pages through every room once, sharing an instant to the microsecond", async () => {
    const me = await signedIn();
    const total = MY_ROOMS_PAGE * 2 + 5;
    await admin.query(
      `insert into room (code, owner_user_id, live, version, last_active_at)
       select 'page' || n, $1::text, '{"round":null,"participants":{}}'::jsonb, 1,
         timestamptz '2026-10-01 12:00:00.123456+00' - (n / 7) * interval '1 microsecond'
       from generate_series(1, $2::int) n`,
      [me.id, total],
    );
    const seen: string[] = [];
    let after: string | undefined;
    let pages = 0;
    do {
      const page: ListAnswer = await me.list(after ? `?after=${after}` : "");
      expect(page.rooms.length).toBeLessThanOrEqual(MY_ROOMS_PAGE);
      seen.push(...page.rooms.map(({ id }) => id));
      after = page.next;
      pages += 1;
    } while (after);
    expect(pages).toBe(3);
    expect(seen).toHaveLength(total);
    expect(new Set(seen).size).toBe(total);
    await admin.query("delete from room where owner_user_id = $1", [me.id]);
  });
});

describe("a guest's move still pending", () => {
  /** A guest with a room, on the way to an account, the move not run yet. */
  async function pending() {
    const account = await signedIn();
    const guest = await new Browser().asGuest();
    const room = await roomOf(guest.id, "Moving");
    await createGuestLinkStore(setup.database.db).begin(guest.id, account.id);
    return { account, guest, room };
  }

  it("is finished before the list is read, so a person who enters no room sees the room", async () => {
    const { account, room } = await pending();
    const { rooms, moving } = await account.list();
    expect(rooms.map(({ id, owned }) => ({ id, owned }))).toEqual([{ id: room.id, owned: true }]);
    expect(moving).toBeUndefined();
  });

  it("fails without breaking the list, and says so", async () => {
    const { account, room } = await pending();
    const bystander = await roomOf(account.id, "Already mine");
    vi.spyOn(sync, "moveGuest").mockResolvedValue("failed");
    const { rooms, moving } = await account.list();
    expect(rooms.map(({ id }) => id)).toEqual([bystander.id]);
    expect(moving).toBe(true);
    vi.restoreAllMocks();
    expect((await account.list()).rooms.map(({ id }) => id)).toContain(room.id);
  });

  it("waits a small budget, and the move goes on", async () => {
    const { account, room } = await pending();
    let finish = () => {};
    const held = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const real = sync.moveGuest;
    vi.spyOn(sync, "moveGuest").mockImplementation(async (...args) => {
      await held;
      return real(...args);
    });
    const started = performance.now();
    const { moving } = await account.list();
    expect(moving).toBe(true);
    expect(performance.now() - started).toBeLessThan(MY_ROOMS_SETTLE_MS + 500);
    finish();
    await expect
      .poll(async () => (await account.list()).rooms.map(({ id }) => id))
      .toContain(room.id);
  });
});

describe("renaming", () => {
  it("changes the name for the people in the room, through the compare-and-set", async () => {
    const owner = await signedIn();
    const other = await signedIn();
    const room = await roomOf(owner.id, "Before");
    await owner.sit(room.code);
    const watcher = await other.sit(room.code);
    const before = watcher.latest()?.version ?? 0;

    const response = await owner.patch(`/api/my-rooms/${room.id}`, { name: `  ${A_ROOM_NAME}  ` });

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({ name: A_ROOM_NAME });
    const { snapshot } = await watcher.waitFor((s) => s.room.name === A_ROOM_NAME);
    expect(snapshot.version).toBe(before + 1);
    expect(snapshot.causes).toEqual([{ type: "roomRenamed" }]);
    expect(await nameIn(room.id)).toBe(A_ROOM_NAME);
    const header = await fetch(`${at}/api/rooms/${room.code}`);
    await expect(header.json()).resolves.toMatchObject({ name: A_ROOM_NAME });
    // The name stays in its column, and a later command keeps it.
    await owner.socket().enter(room.code);
    const { rows } = await admin.query("select live ? 'name' as stored from room where id = $1", [
      room.id,
    ]);
    expect((rows[0] as { stored: boolean }).stored).toBe(false);
    const seen = watcher.received.length;
    await watcher.cmd("setRole", { role: "observer" });
    const later = await watcher.waitFor((s) => s.version > before + 1, 2000, seen);
    expect(later.snapshot.room.name).toBe(A_ROOM_NAME);
    expect(await nameIn(room.id)).toBe(A_ROOM_NAME);
  });

  it("holds a new name to the rules of a room's creation", async () => {
    const owner = await signedIn();
    const room = await roomOf(owner.id, "Kept");
    for (const name of ["   ", "x".repeat(61), "a​b"]) {
      const response = await owner.patch(`/api/my-rooms/${room.id}`, { name });
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ code: "bad_room_name" });
    }
    expect(await nameIn(room.id)).toBe("Kept");
    expect((await owner.patch(`/api/my-rooms/${room.id}`, { name: "x".repeat(60) })).status).toBe(
      200,
    );
  });

  it("refuses someone else's room id", async () => {
    const owner = await signedIn();
    const stranger = await signedIn();
    const seated = await signedIn();
    const room = await roomOf(owner.id, "Kept");
    await seated.sit(room.code);
    for (const browser of [stranger, seated]) {
      const response = await browser.patch(`/api/my-rooms/${room.id}`, { name: "Taken" });
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ code: "not_owner" });
    }
    expect(await nameIn(room.id)).toBe("Kept");
  });

  it("refuses a PO who handed the role over, on the next try", async () => {
    const owner = await signedIn();
    const heir = await signedIn();
    const room = await roomOf(owner.id, "Kept");
    const po = await owner.sit(room.code);
    await heir.sit(room.code);
    await expect(po.cmd("transferOwner", { to: heir.id })).resolves.toMatchObject({ ok: true });

    expect((await owner.patch(`/api/my-rooms/${room.id}`, { name: "Old PO" })).status).toBe(403);
    expect((await heir.patch(`/api/my-rooms/${room.id}`, { name: "New PO" })).status).toBe(200);
    expect(await nameIn(room.id)).toBe("New PO");
  });
});

describe("deleting", () => {
  /** A room with all a room can hold: a round in history, a grant, a queue, a password. */
  async function fullRoom(owner: Browser, other: Browser) {
    const room = await roomOf(owner.id, "Full");
    const po = await owner.sit(room.code);
    const voter = await other.sit(room.code);
    await po.cmd("queueAdd", { items: [{ title: "Next thing" }] });
    await po.cmd("startRound", { subject: { kind: "none" }, round: 0 });
    await voter.cmd("castVote", { card: "5", round: 1 });
    await po.cmd("reveal");
    await po.cmd("startRound", { subject: { kind: "none" }, round: 1 });
    const set = await owner.go(`/api/rooms/${room.code}/password`, {
      method: "PUT",
      headers: { origin: ORIGIN, "content-type": "application/json" },
      body: JSON.stringify({ password: "a good password" }),
    });
    expect(set.status).toBe(204);
    expect(await countOf("round_history", "room_id", room.id)).toBeGreaterThan(0);
    expect(await countOf("room_access", "room_id", room.id)).toBeGreaterThan(0);
    return { room, po, voter };
  }

  it("removes the room and everything keyed to it", async () => {
    const owner = await signedIn();
    const other = await signedIn();
    const { room } = await fullRoom(owner, other);
    const bystander = await roomOf(owner.id, "Stays");

    const response = await owner.remove(`/api/my-rooms/${room.id}`);

    expect(response.status).toBe(204);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await countOf("room", "id", room.id)).toBe(0);
    expect(await countOf("round_history", "room_id", room.id)).toBe(0);
    expect(await countOf("room_access", "room_id", room.id)).toBe(0);
    // Whatever a later migration adds that points at a room has to go with it.
    const { rows } = await admin.query(`
      select conrelid::regclass::text as tab, confdeltype from pg_constraint
      where contype = 'f' and confrelid = 'room'::regclass`);
    expect(rows.map(({ tab, confdeltype }) => [tab, confdeltype]).sort()).toEqual([
      ["room_access", "c"],
      ["round_history", "c"],
    ]);
    expect(await countOf("room", "id", bystander.id)).toBe(1);
    expect((await owner.list()).rooms.map(({ id }) => id)).toEqual([bystander.id]);
    expect((await owner.remove(`/api/my-rooms/${room.id}`)).status).toBe(404);
  });

  it("tells a live room at once, its sockets stop, and its timer ends", async () => {
    const owner = await signedIn();
    const other = await signedIn();
    const room = await roomOf(owner.id, "Live");
    const po = await owner.sit(room.code);
    const voter = await other.sit(room.code);
    await po.cmd("updateSettings", { patch: { timer: { seconds: 600 } } });
    await po.cmd("startRound", { subject: { kind: "none" }, round: 0 });
    await voter.waitFor((s) => s.room.round?.deadlineAt !== undefined);
    expect(sync.deadlines.armed(room.id)).toBeDefined();
    const told = (client: TestClient) =>
      new Promise<string[]>((resolve) => {
        const events: string[] = [];
        client.socket.once("deleted", () => events.push("deleted"));
        client.socket.once("disconnect", (reason) => {
          events.push(reason);
          resolve(events);
        });
      });
    const [forPo, forVoter] = [told(po), told(voter)];
    const beforeDelete = voter.frames.length;

    expect((await owner.remove(`/api/my-rooms/${room.id}`)).status).toBe(204);

    await expect(forPo).resolves.toEqual(["deleted", "io server disconnect"]);
    await expect(forVoter).resolves.toEqual(["deleted", "io server disconnect"]);
    expect(sync.deadlines.armed(room.id)).toBeUndefined();
    expect(sync.presence.pending(room.id, other.id)).toBe(false);
    // Nothing but the word: no snapshot of a room that is gone.
    expect(snapshotsIn(voter.frames.slice(beforeDelete))).toEqual([]);
    await expect((await other.socket()).enter(room.code)).resolves.toEqual({
      ok: false,
      code: "room_not_found",
    });
    await expect(sync.occupiedRooms()).resolves.not.toContain(room.id);
  });

  it("refuses someone else's room id, and a PO who handed the role over", async () => {
    const owner = await signedIn();
    const heir = await signedIn();
    const stranger = await signedIn();
    const room = await roomOf(owner.id, "Kept");
    const po = await owner.sit(room.code);
    await heir.sit(room.code);

    const refused = await stranger.remove(`/api/my-rooms/${room.id}`);
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual({ code: "not_owner" });
    expect((await heir.remove(`/api/my-rooms/${room.id}`)).status).toBe(403);

    await po.cmd("transferOwner", { to: heir.id });
    expect((await owner.remove(`/api/my-rooms/${room.id}`)).status).toBe(403);
    expect(await countOf("room", "id", room.id)).toBe(1);
    expect((await heir.remove(`/api/my-rooms/${room.id}`)).status).toBe(204);
    expect(await countOf("room", "id", room.id)).toBe(0);
  });

  it("wins or loses cleanly against a command at the same moment", async () => {
    const owner = await signedIn();
    const other = await signedIn();
    for (let n = 0; n < 5; n++) {
      const room = await roomOf(owner.id);
      const po = await owner.sit(room.code);
      const voter = await other.sit(room.code);
      const [gone] = await Promise.all([
        owner.remove(`/api/my-rooms/${room.id}`),
        // A command may lose its socket before its answer: the room is gone either way.
        po.cmd("startRound", { subject: { kind: "none" }, round: 0 }).catch(() => null),
        voter.cmd("rename", { name: "Racing" }).catch(() => null),
      ]);
      expect(gone.status).toBe(204);
      expect(await countOf("room", "id", room.id)).toBe(0);
      expect(await countOf("round_history", "room_id", room.id)).toBe(0);
    }
  });
});

describe("leaving", () => {
  it("gives up the seat through the command, and the room's people hear it", async () => {
    const owner = await signedIn();
    const me = await signedIn();
    const room = await roomOf(owner.id, "Left");
    const po = await owner.sit(room.code);
    await me.sit(room.code);
    const seen = po.received.length;

    const response = await me.post(`/api/my-rooms/${room.id}/leave`, {});

    expect(response.status).toBe(204);
    const { snapshot } = await po.waitFor((s) => s.room.participants.length === 1, 2000, seen);
    expect(snapshot.causes).toContainEqual({ type: "left", who: me.id });
    expect((await me.list()).rooms).toEqual([]);
    const again = await me.post(`/api/my-rooms/${room.id}/leave`, {});
    expect(again.status).toBe(403);
    expect(await again.json()).toEqual({ code: "not_participant" });
  });
});

describe("retention (ADR-014)", () => {
  const LONG_AGO = "2020-01-01T00:00:00Z";
  const idle = (id: string) =>
    admin.query("update room set last_active_at = $2 where id = $1", [id, LONG_AGO]);

  it("keeps what a person owns, moved from a guest or not, and purges a room only joined", async () => {
    const me = await new Browser().asGuest();
    const guestId = me.id;
    const moved = await roomOf(guestId, "From the guest");
    const owner = await new Browser().asGuest();
    const joined = await roomOf(owner.id, "Only joined");
    const seat = await me.sit(joined.code);
    seat.close();
    await me.asAccount();
    expect(me.id).not.toBe(guestId);
    await expect.poll(async () => (await me.list()).rooms.length).toBe(2);
    const created = await roomOf(me.id, "Mine from the start");
    for (const { id } of [moved, joined, created]) await idle(id);

    await setup.retention.runNow();

    expect(await countOf("room", "id", moved.id)).toBe(1);
    expect(await countOf("room", "id", created.id)).toBe(1);
    expect(await countOf("room", "id", joined.id)).toBe(0);
    expect((await me.list()).rooms.map(({ name }) => name).sort()).toEqual([
      "From the guest",
      "Mine from the start",
    ]);
  });

  it("stops when the person hands the room to a guest: the owner is who the rule reads", async () => {
    const owner = await signedIn();
    const guest = await new Browser().asGuest();
    const room = await roomOf(owner.id, "Handed over");
    const po = await owner.sit(room.code);
    await guest.sit(room.code);
    await po.cmd("transferOwner", { to: guest.id });
    for (const client of open.splice(0)) client.close();
    await expect.poll(() => sync.occupiedRooms()).not.toContain(room.id);
    await idle(room.id);

    await setup.retention.runNow();

    expect(await countOf("room", "id", room.id)).toBe(0);
  });
});

describe("the query", () => {
  it("reads indexes, and answers within the 300 ms at 100 rooms among many", async () => {
    const me = await signedIn();
    const seats = (who: string, n: string) => `(select jsonb_object_agg(
      case when s = 1 then ${who} else 'person' || ${n} || '-' || s end,
      jsonb_build_object('name', 'A Person Name', 'role', 'voter', 'joinedAt', 1, 'connected', false))
      from generate_series(1, 16) s)`;
    const live = (who: string, n: string) => `jsonb_build_object(
      'ownerId', 'owner' || ${n},
      'participants', ${seats(who, n)},
      'round', jsonb_build_object('number', 12, 'votes', '{}'::jsonb))`;
    // Many rooms of other people, and this person's: half owned, half with a seat.
    await admin.query(`
      insert into room (code, owner_user_id, live, version)
      select 'bulk' || n, 'owner' || n, ${live("'seat' || n", "n")}, 1
      from generate_series(1, 20000) n`);
    await admin.query(
      `insert into room (code, owner_user_id, live, version)
       select 'mine' || n, case when n % 2 = 0 then $1::text else 'owner' || n end,
         ${live("$1::text", "n")}, 1
       from generate_series(1, 100) n`,
      [me.id],
    );
    await admin.query(
      `insert into round_history
         (room_id, number, subject, deck, votes, stats, started_at, revealed_at, finished_at)
       select r.id, g, '{}', '{}', '{"kind":"anonymous","cards":[]}', '{}', now(), now(), now()
       from room r, generate_series(1, 12) g where r.code like 'mine%'`,
    );
    await admin.query("analyze room");
    await admin.query("analyze round_history");

    const { rows } = await admin.query(
      `explain (analyze, buffers, format text)
       select id, code, name, owner_user_id = $1 as owned,
         coalesce((live #>> '{round,number}')::int, 0) as rounds, last_active_at
       from room
       where (owner_user_id = $1 or (
         ((live -> 'participants') || coalesce(live #> '{round,votes}', '{}'::jsonb)) ? $1
         and live -> 'participants' ? $1))
       order by last_active_at desc, id desc limit 101`,
      [me.id],
    );
    const plan = rows.map((row) => row["QUERY PLAN"]).join("\n");
    expect(plan).toContain("room_people_idx");
    expect(plan).toContain("room_owner_user_id_idx");
    expect(plan).not.toContain("Seq Scan");
    expect(plan).not.toContain("round_history");

    const timings: number[] = [];
    for (let n = 0; n < 7; n++) {
      const started = performance.now();
      const page = await me.list();
      timings.push(performance.now() - started);
      expect(page.rooms).toHaveLength(100);
      expect(page.next).toBeUndefined();
      expect(page.rooms.every(({ rounds }) => rounds === 12)).toBe(true);
    }
    const median = [...timings].sort((a, b) => a - b)[3] ?? Infinity;
    expect(median).toBeLessThan(300);
    await admin.query("delete from room where code like 'bulk%' or code like 'mine%'");
  }, 120_000);
});

describe("what the page's address gets", () => {
  it("logs the route, never an id's room code or the cursor's query", async () => {
    const me = await signedIn();
    const room = await roomOf(me.id, A_ROOM_NAME);
    await me.patch(`/api/my-rooms/${room.id}`, { name: "Another quiet name" });
    await me.list(`?after=1_${room.id}`);
    const lines = logs.lines.filter((line) => String(line.path).startsWith("/api/my-rooms"));
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines)
      expect(line.path).toMatch(/^\/api\/my-rooms(\/:(id|code)(\/leave)?)?$/);
  });
});

describe("the socket", () => {
  it("has no command for a room's name", async () => {
    const owner = await signedIn();
    const room = await roomOf(owner.id, "Kept");
    const po = await owner.sit(room.code);
    await expect(po.cmd("renameRoom", { name: "By socket" })).resolves.toMatchObject({
      ok: false,
      code: "bad_payload",
    });
    expect(await nameIn(room.id)).toBe("Kept");
  });
});
