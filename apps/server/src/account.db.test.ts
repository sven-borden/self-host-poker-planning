/**
 * Exporting and deleting an account (#51, ADR-029) over the real thing: Postgres, a real sign-in
 * against the stand-in provider, real sockets and their frames.
 *
 * What it holds: only an account reaches any of this, and a deletion takes a recent sign-in and the
 * typed word, on the server. The file is the person's own and holds no code, no token and nobody
 * else. After a deletion no table holds the person's id, name, address or provider ids, and a table
 * added later fails the test until it is seeded here. Each kind of room comes out as ADR-029 says,
 * its people see the ordinary paths, and a deletion that fails or dies halfway finishes later, and
 * says so.
 */
import { createRoom, type RoomState } from "@pp/domain";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  ACCOUNT_DELETE_LIMIT,
  ACCOUNT_EXPORT_LIMIT,
  MAX_ROOM_CHOICES,
  RECENT_SIGN_IN_MS,
} from "./account.ts";
import type { Config } from "./config.ts";
import { createAccountDeletionStore } from "./db/account-deletions.ts";
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
import { createServer, type PokerServer } from "./server.ts";
import { setupServer } from "./setup.ts";
import type { RoomSync } from "./sync/room-sync.ts";
import { roomCode, testClient as socketClient, type TestClient } from "./sync/test-support.ts";
import { collectLogs, testConfig, VALID_ENV } from "./test-support.ts";

const ORIGIN = VALID_ENV.BASE_URL;
const KEYS = {
  GOOGLE_CLIENT_ID: "test-google-client-id",
  GOOGLE_CLIENT_SECRET: "test-google-secret-do-not-log",
  MICROSOFT_CLIENT_ID: "test-microsoft-client-id",
  MICROSOFT_CLIENT_SECRET: "test-microsoft-secret-do-not-log",
} as const;
const TENANT = "0f0e0d0c-0b0a-4908-8706-050403020100";

/** Every table there is. A new one fails until it is seeded below and its rows are looked at. */
const TABLES = [
  "account",
  "account_deletion",
  "connector_token",
  "guest_link",
  "room",
  "room_access",
  "round_history",
  "session",
  "user",
  "verification",
];

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
const secrets: string[] = [];

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
  for (const secret of [...codes, ...secrets]) expect(everything).not.toContain(secret);
});

let addresses = 0;
let people = 0;

interface Person {
  id: string;
  email: string;
  name: string;
  emailVerified?: boolean;
  tenant?: string;
}

const newPerson = (): Person => {
  const n = ++people;
  const person = {
    id: `account-person-${n}-${Date.now()}`,
    email: `account-${n}-${Date.now()}@example.com`,
    name: `Qwxz Person ${n} ${Date.now() % 100000}`,
    emailVerified: true,
    tenant: TENANT,
  };
  secrets.push(person.name, person.id);
  return person;
};

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

  async whoAmI(): Promise<string> {
    const response = await this.go("/api/auth/get-session");
    const session = (await response.json()) as { user: { id: string } } | null;
    this.id = session?.user.id ?? "";
    if (this.id !== "") secrets.push(this.id);
    return this.id;
  }

  async asGuest(): Promise<this> {
    const response = await this.post("/api/auth/sign-in/anonymous", {});
    expect(response.status).toBe(200);
    await this.whoAmI();
    return this;
  }

  /** Goes through the provider, and answers where the callback sent this browser. */
  async signIn(person: Person, provider: "google" | "microsoft" = "google"): Promise<string> {
    const started = await this.post("/api/auth/sign-in/social", { provider, returnTo: "/account" });
    expect(started.status).toBe(200);
    const { url } = (await started.json()) as { url: string };
    const answer = await fetch(
      `${atFake(url, fake.origin)}&${FAKE_PERSON_PARAM}=${fakePersonParam(person)}`,
      { redirect: "manual" },
    );
    const back = new URL(answer.headers.get("location") ?? "");
    const landed = await this.go(`${back.pathname}${back.search}`);
    await this.whoAmI();
    return landed.headers.get("location") ?? "";
  }

  async asAccount(
    person = newPerson(),
    provider: "google" | "microsoft" = "google",
  ): Promise<this> {
    expect(await this.signIn(person, provider)).toBe(`${ORIGIN}/account`);
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

  /** Starts the deletion, with the word and the choices given. */
  remove(rooms: unknown[] = [], confirm = "DELETE"): Promise<Response> {
    return this.post("/api/account/delete", { confirm, rooms });
  }
}

const signedIn = (person = newPerson()) => new Browser().asAccount(person);

const store = () => createAccountDeletionStore(setup.database.db);

async function roomOf(
  ownerId: string,
  name: string | null = null,
  settings: Partial<RoomState["settings"]> = {},
) {
  const code = roomCode();
  codes.push(code);
  const state = createRoom({ ownerId });
  const stored = await setup.database.store.insertRoom({
    code,
    name,
    state: { ...state, settings: { ...state.settings, ...settings } },
  });
  if (!stored) throw new Error("code taken");
  return stored;
}

const liveOf = async (id: string) => {
  const { rows } = await admin.query("select live, owner_user_id from room where id = $1", [id]);
  return rows[0] as { live: RoomState; owner_user_id: string } | undefined;
};

const roundOf = async (roomId: string, number: number) => {
  const { rows } = await admin.query(
    "select votes, stats from round_history where room_id = $1 and number = $2",
    [roomId, number],
  );
  return rows[0] as
    | {
        votes: {
          kind: string;
          votes?: { who: string | null; name: string | null; card: string }[];
          cards?: string[];
        };
        stats: unknown;
      }
    | undefined;
};

/** Makes `who`'s seat away for longer than a claim needs. */
const awayLongEnough = (id: string, who: string) =>
  admin.query(
    `update room set live = jsonb_set(
       jsonb_set(live, array['participants', $2::text, 'awaySince'],
         to_jsonb((extract(epoch from now()) * 1000 - 130000)::bigint)),
       array['participants', $2::text, 'connected'], 'false')
     where id = $1`,
    [id, who],
  );

/** A round with these voters that ended, so it has its history row, and the next on the table. */
async function playRound(po: TestClient, voters: [TestClient, string][]) {
  await expect(
    po.cmd("startRound", { subject: { kind: "title", text: "A story" } }),
  ).resolves.toEqual(expect.objectContaining({ ok: true }));
  const number = po.latest()?.room.round?.number;
  for (const [client, card] of voters) {
    await expect(client.cmd("castVote", { card, round: number })).resolves.toMatchObject({
      ok: true,
    });
  }
  const round = po.latest()?.room.round;
  if (round?.phase !== "revealed") await po.cmd("reveal");
  await expect(po.cmd("startRound", { subject: { kind: "none" } })).resolves.toMatchObject({
    ok: true,
  });
}

/** Every table in every schema of ours, from the catalog: never a list in this file. */
async function allTables(): Promise<{ schema: string; table: string }[]> {
  const { rows } = await admin.query<{ schemaname: string; tablename: string }>(
    `select schemaname, tablename from pg_tables
     where schemaname not in ('pg_catalog', 'information_schema') order by 1, 2`,
  );
  return rows.map(({ schemaname, tablename }) => ({ schema: schemaname, table: tablename }));
}

/** Which tables hold `needle` anywhere in a row, JSON included. */
async function tablesHolding(needle: string): Promise<string[]> {
  const holding: string[] = [];
  for (const { schema, table } of await allTables()) {
    const { rows } = await admin.query(
      `select 1 from "${schema}"."${table}" t where position($1 in t::text) > 0 limit 1`,
      [needle],
    );
    if (rows.length > 0) holding.push(table);
  }
  return holding;
}

describe("who may ask", () => {
  it("refuses a guest and someone with no session, on every route", async () => {
    const guest = await new Browser().asGuest();
    expect((await guest.go("/api/account")).status).toBe(403);
    expect((await guest.go("/api/account/export")).status).toBe(403);
    expect((await guest.remove()).status).toBe(403);
    const nobody = new Browser();
    expect((await nobody.go("/api/account")).status).toBe(401);
    expect((await nobody.go("/api/account/export")).status).toBe(401);
    expect((await nobody.remove()).status).toBe(401);
  });

  it("refuses another site, and a body that is not JSON", async () => {
    const me = await signedIn();
    const foreign = await me.go("/api/account/delete", {
      method: "POST",
      headers: { origin: "https://evil.example", "content-type": "application/json" },
      body: JSON.stringify({ confirm: "DELETE", rooms: [] }),
    });
    expect(foreign.status).toBe(403);
    const form = await me.go("/api/account/delete", {
      method: "POST",
      headers: { origin: ORIGIN, "content-type": "application/x-www-form-urlencoded" },
      body: "confirm=DELETE",
    });
    expect(form.status).toBe(415);
    expect(await me.whoAmI()).not.toBe("");
  });

  it("refuses another site on the two reads as well", async () => {
    const me = await signedIn();
    const foreign = { headers: { origin: "https://evil.example" } };
    for (const path of ["/api/account", "/api/account/export"]) {
      const answer = await me.go(path, foreign);
      expect(answer.status).toBe(403);
      expect(answer.headers.get("cache-control")).toBe("no-store");
      expect(await answer.json()).toEqual({ code: "not_allowed" });
    }
  });

  it("takes the word in any of the three languages, and nothing else", async () => {
    const me = await signedIn();
    const wrong = await me.remove([], "delete it");
    expect(wrong.status).toBe(400);
    expect(await wrong.json()).toEqual({ code: "bad_confirmation" });
    expect((await me.post("/api/account/delete", { rooms: [] })).status).toBe(400);
    expect(await me.whoAmI()).not.toBe("");
    for (const word of ["supprimer", " LÖSCHEN "]) {
      const other = await signedIn();
      expect((await other.remove([], word)).status).toBe(200);
    }
  });

  it("refuses a session older than the limit, and a new sign-in opens it again", async () => {
    const person = newPerson();
    const me = await signedIn(person);
    await admin.query(
      "update session set created_at = now() - make_interval(secs => $2) where user_id = $1",
      [me.id, RECENT_SIGN_IN_MS / 1000 + 5],
    );
    const stale = await me.remove();
    expect(stale.status).toBe(403);
    expect(await stale.json()).toEqual({ code: "sign_in_again" });
    expect(await (await me.go("/api/account")).json()).toMatchObject({ recent: false });
    await me.asAccount(person);
    expect(await (await me.go("/api/account")).json()).toMatchObject({ recent: true });
    expect((await me.remove()).status).toBe(200);
  });

  it("limits requests per person, and an oversized list is refused before anything", async () => {
    const me = await signedIn();
    for (let i = 0; i < ACCOUNT_DELETE_LIMIT.max; i++) {
      expect((await me.remove([], "wrong")).status).toBe(400);
    }
    expect((await me.remove()).status).toBe(429);
    const other = await signedIn();
    const rooms = Array.from({ length: MAX_ROOM_CHOICES + 1 }, () => ({
      id: "00000000-0000-4000-8000-000000000000",
      delete: true,
    }));
    expect((await other.remove(rooms)).status).toBeGreaterThanOrEqual(400);
    expect(await other.whoAmI()).not.toBe("");
  });
});

describe("the export", () => {
  it("holds the person's own data, and no code, token or other person", async () => {
    const person = { ...newPerson(), emailVerified: false };
    const me = await new Browser().asAccount(person, "microsoft");
    const friend = await new Browser().asGuest();
    const friendName = `Vbnk Friend ${Date.now() % 100000}`;
    await me.post("/api/me/avatar", { avatar: "koala" });

    const kept = await roomOf(me.id, "Kept Room");
    const po = await me.sit(kept.code, "Me At Table");
    const other = await friend.sit(kept.code, friendName);
    await playRound(po, [
      [po, "21"],
      [other, "8"],
    ]);

    const hidden = await roomOf(friend.id, null, { revealNames: false });
    const friendHere = await friend.sit(hidden.code, friendName);
    const meHere = await me.sit(hidden.code, "Me Hidden");
    await playRound(friendHere, [
      [friendHere, "2"],
      [meHere, "13"],
    ]);

    await admin.query(
      `insert into connector_token (user_id, connector, sealed_token)
       values ($1, 'jira', 'v1.key.iv.sealed-value-never-exported')`,
      [me.id],
    );
    await admin.query("update account set hosted_domain = 'team.example' where user_id = $1", [
      me.id,
    ]);
    const answer = await me.go("/api/account/export");
    expect(answer.status).toBe(200);
    expect(answer.headers.get("cache-control")).toBe("no-store");
    expect(answer.headers.get("content-disposition")).toMatch(/^attachment; filename="/);
    const text = await answer.text();
    const file = JSON.parse(text) as Record<string, unknown>;
    expect(file).toMatchObject({
      format: "poker-planning-account",
      version: 1,
      profile: { name: person.name, email: person.email, avatar: "koala" },
      signIns: [
        { provider: "microsoft", claimedEmail: person.email, hostedDomain: "team.example" },
      ],
      connections: ["jira"],
    });
    const rooms = file.rooms as { id: string; keeper: boolean; seat: { name: string } | null }[];
    expect(rooms.find((room) => room.id === kept.id)).toMatchObject({
      name: "Kept Room",
      keeper: true,
      productOwner: true,
      seat: { name: "Me At Table" },
    });
    expect(rooms.find((room) => room.id === hidden.id)).toMatchObject({ keeper: false });
    expect(file.votes).toMatchObject([
      {
        room: { id: kept.id, name: "Kept Room" },
        round: 1,
        subject: { kind: "title", text: "A story" },
        card: "21",
        name: "Me At Table",
      },
    ]);
    const { rows } = await admin.query(
      "select account_id, tenant_id from account where user_id = $1",
      [me.id],
    );
    const stored = rows[0] as { account_id: string; tenant_id: string };
    for (const absent of [
      kept.code,
      hidden.code,
      friendName,
      friend.id,
      stored.account_id,
      stored.tenant_id,
      "microsoft.invalid",
      "sealed-value",
      '"8"',
      '"2"',
      '"13"',
    ]) {
      expect(text).not.toContain(absent);
    }
  });

  it("holds every room that names the person, and the grants, with no code", async () => {
    const me = await signedIn();
    const other = await new Browser().asGuest();

    // The PO role alone: claimed, and left, while someone else keeps the room.
    const onlyRole = await roomOf(me.id, "Only The Role");
    await admin.query(
      `update room set live = jsonb_set(live, '{keeperId}', to_jsonb($2::text)) where id = $1`,
      [onlyRole.id, other.id],
    );

    // A card alone: it stayed on the table after the person left.
    const onlyCard = await roomOf(other.id, "Only A Card", { revealWhenAllVoted: false });
    const po = await other.sit(onlyCard.code);
    const seat = await me.sit(onlyCard.code);
    await po.cmd("startRound", { subject: { kind: "none" } });
    await seat.cmd("castVote", { card: "13", round: 1 });
    await po.cmd("reveal");
    await seat.cmd("leave");

    // A password let the person in, and they never sat down.
    const entered = await roomOf(other.id, "Let In");
    await admin.query("insert into room_access (room_id, user_id) values ($1, $2)", [
      entered.id,
      me.id,
    ]);

    const text = await (await me.go("/api/account/export")).text();
    const file = JSON.parse(text) as {
      rooms: { id: string; seat: unknown; cardOnTable: boolean }[];
      grants: { room: { id: string; name: string } }[];
    };
    const inFile = (id: string) => file.rooms.find((room) => room.id === id);
    expect(inFile(onlyRole.id)).toMatchObject({
      name: "Only The Role",
      productOwner: true,
      keeper: false,
      seat: null,
      cardOnTable: false,
    });
    expect(inFile(onlyCard.id)).toMatchObject({
      name: "Only A Card",
      productOwner: false,
      keeper: false,
      seat: null,
      cardOnTable: true,
    });
    expect(file.grants).toMatchObject([{ room: { id: entered.id, name: "Let In" } }]);
    for (const absent of [onlyRole.code, onlyCard.code, entered.code, other.id, '"13"']) {
      expect(text).not.toContain(absent);
    }
  });

  it("says so in the file when a guest's move has not landed", async () => {
    const me = await signedIn();
    vi.spyOn(setup.links, "settle").mockResolvedValue(false);
    const file = (await (await me.go("/api/account/export")).json()) as { incomplete?: true };
    expect(file.incomplete).toBe(true);
  });

  it("has a limit of its own", async () => {
    const me = await signedIn();
    for (let i = 0; i < ACCOUNT_EXPORT_LIMIT.max; i++) {
      expect((await me.go("/api/account/export")).status).toBe(200);
    }
    expect((await me.go("/api/account/export")).status).toBe(429);
  });

  it("finishes a guest's move first, so it misses nothing", async () => {
    const guest = await new Browser().asGuest();
    const room = await roomOf(guest.id, "From Guest Days");
    await guest.sit(room.code);
    await guest.signIn(newPerson());
    const answer = await guest.go("/api/account/export");
    const file = (await answer.json()) as { rooms: { id: string }[]; incomplete?: true };
    expect(file.incomplete).toBeUndefined();
    expect(file.rooms.map(({ id }) => id)).toContain(room.id);
  });
});

describe("the page's overview", () => {
  it("says what would go, and lists the rooms that need a choice, the longest seated first", async () => {
    const me = await signedIn();
    const first = await new Browser().asGuest();
    const second = await new Browser().asGuest();
    await roomOf(me.id, "Alone");
    const shared = await roomOf(me.id, "Shared");
    await me.sit(shared.code);
    await first.sit(shared.code, "First Seated");
    await second.sit(shared.code, "Second Seated");
    const theirs = await roomOf(first.id, "Theirs");
    await me.sit(theirs.code);
    const answer = (await (await me.go("/api/account")).json()) as {
      alone: number;
      seats: number;
      shared: { id: string; name: string; seats: { id: string; name: string }[] }[];
    };
    expect(answer.alone).toBe(1);
    expect(answer.seats).toBe(1);
    expect(answer.shared).toMatchObject([
      {
        id: shared.id,
        name: "Shared",
        seats: [
          { id: first.id, name: "First Seated" },
          { id: second.id, name: "Second Seated" },
        ],
      },
    ]);
    expect(JSON.stringify(answer)).not.toContain(shared.code);
  });
});

describe("the default on the page", () => {
  it("says whoever runs the room, and that is who takes it", async () => {
    const me = await signedIn();
    const first = await new Browser().asGuest();
    const second = await new Browser().asGuest();
    const room = await roomOf(me.id, "Claimed From Me");
    const seat = await me.sit(room.code);
    await first.sit(room.code, "Seated First");
    const runner = await second.sit(room.code, "Runs It");
    await awayLongEnough(room.id, me.id);
    await expect(runner.cmd("claimOwner")).resolves.toMatchObject({ ok: true });
    await seat.cmd("leave");

    const overview = (await (await me.go("/api/account")).json()) as {
      shared: { why: string; seats: { id: string }[] }[];
    };
    expect(overview.shared[0]?.why).toBe("runsTheRoom");
    expect(overview.shared[0]?.seats.map(({ id }) => id)).toEqual([second.id, first.id]);

    expect((await me.remove()).status).toBe(200);
    const stored = await liveOf(room.id);
    expect(stored?.owner_user_id).toBe(second.id);
    expect(stored?.live.keeperId).toBe(second.id);
  });

  it("puts someone here before someone who sat longer and is away, and says why", async () => {
    const me = await signedIn();
    const first = await new Browser().asGuest();
    const second = await new Browser().asGuest();
    const room = await roomOf(me.id, "Partly Away");
    await me.sit(room.code);
    await first.sit(room.code);
    await second.sit(room.code);
    await awayLongEnough(room.id, first.id);

    const overview = (await (await me.go("/api/account")).json()) as {
      shared: { why: string; seats: { id: string }[] }[];
    };
    expect(overview.shared[0]?.why).toBe("here");
    expect(overview.shared[0]?.seats.map(({ id }) => id)).toEqual([second.id, first.id]);

    expect((await me.remove()).status).toBe(200);
    expect((await liveOf(room.id))?.live.keeperId).toBe(second.id);
  });

  it("says when nobody is here", async () => {
    const me = await signedIn();
    const first = await new Browser().asGuest();
    const room = await roomOf(me.id, "All Away");
    await first.sit(room.code);
    await awayLongEnough(room.id, first.id);
    const overview = (await (await me.go("/api/account")).json()) as { shared: { why: string }[] };
    expect(overview.shared[0]?.why).toBe("away");
  });
});

describe("after a deletion", () => {
  it("no table holds the person's id, name, address or provider ids", async () => {
    expect(
      (await allTables()).filter(({ schema }) => schema === "public").map((row) => row.table),
    ).toEqual(TABLES);

    const person = { ...newPerson(), emailVerified: false };
    const me = await new Browser().asAccount(person, "microsoft");
    await me.post("/api/me/avatar", { avatar: "koala" });
    const { rows: ids } = await admin.query(
      `select a.account_id, a.tenant_id, u.email from account a join "user" u on u.id = a.user_id
       where a.user_id = $1`,
      [me.id],
    );
    const stored = ids[0] as { account_id: string; tenant_id: string; email: string };
    const oid = stored.account_id.split(":")[1] ?? stored.account_id;
    const hosted = `hosted-${Date.now()}.example`;
    await admin.query("update account set hosted_domain = $2 where user_id = $1", [me.id, hosted]);
    const needles = [
      me.id,
      person.name,
      person.email,
      stored.email,
      stored.account_id,
      oid,
      hosted,
    ];

    const other = await new Browser().asGuest();

    // A room the person keeps alone, with a round, and a queue.
    const alone = await roomOf(me.id, "Alone");
    const aloneSeat = await me.sit(alone.code, person.name);
    await playRound(aloneSeat, [[aloneSeat, "5"]]);
    await aloneSeat.cmd("queueAdd", { items: [{ title: "A ticket" }] });

    // A room the person keeps with someone else, and a named round both played.
    const shared = await roomOf(me.id, "Shared");
    const po = await me.sit(shared.code, person.name);
    const otherSeat = await other.sit(shared.code, "Other Person");
    await playRound(po, [
      [po, "21"],
      [otherSeat, "13"],
    ]);

    // Someone else's room: a named round, and the person's card revealed on the table.
    const theirs = await roomOf(other.id, "Theirs");
    const theirPo = await other.sit(theirs.code, "Other Person");
    const meThere = await me.sit(theirs.code, person.name);
    await playRound(theirPo, [
      [meThere, "8"],
      [theirPo, "3"],
    ]);
    await theirPo.cmd("startRound", { subject: { kind: "none" } });
    await meThere.cmd("castVote", { card: "13", round: 3 });
    await theirPo.cmd("castVote", { card: "2", round: 3 });

    // Someone else's anonymous room, the card revealed.
    const hidden = await roomOf(other.id, "Hidden", { revealNames: false });
    const hiddenPo = await other.sit(hidden.code, "Other Person");
    const meHidden = await me.sit(hidden.code, person.name);
    await hiddenPo.cmd("startRound", { subject: { kind: "none" } });
    await meHidden.cmd("castVote", { card: "21", round: 1 });
    await hiddenPo.cmd("castVote", { card: "1", round: 1 });

    // A room where the person took the role from someone away.
    const claimed = await roomOf(other.id, "Claimed");
    await other.sit(claimed.code, "Other Person");
    const claimer = await me.sit(claimed.code, person.name);
    await awayLongEnough(claimed.id, other.id);
    await expect(claimer.cmd("claimOwner")).resolves.toMatchObject({ ok: true });

    // What sits beside the rooms.
    await admin.query("insert into room_access (room_id, user_id) values ($1, $2)", [
      theirs.id,
      me.id,
    ]);
    await admin.query(
      `insert into connector_token (user_id, connector, sealed_token)
       values ($1, 'jira', 'v1.key.iv.sealed')`,
      [me.id],
    );
    await admin.query(
      `insert into verification (id, identifier, value, expires_at)
       values ('seeded-sign-in', 'seeded-state', $1, now() + interval '10 minutes')`,
      [JSON.stringify({ userId: me.id, email: person.email })],
    );

    // A guest of the person's, stuck on the way here, whose seat the deletion deals with.
    const before = await new Browser().asGuest();
    const guestName = `Hjkl Guest ${Date.now() % 100000}`;
    secrets.push(guestName);
    const guestRoom = await roomOf(other.id, "Guest Seat");
    await other.sit(guestRoom.code, "Other Person");
    await before.sit(guestRoom.code, guestName);
    await admin.query('update "user" set name = $2 where id = $1', [before.id, guestName]);
    await admin.query("insert into guest_link (guest_user_id, account_user_id) values ($1, $2)", [
      before.id,
      me.id,
    ]);
    vi.spyOn(sync, "moveGuest").mockResolvedValue("failed");
    needles.push(before.id, guestName);

    // Every table is seeded: a table that holds nothing of the person here proves nothing below.
    const seeded = new Set<string>();
    for (const needle of needles)
      for (const table of await tablesHolding(needle)) seeded.add(table);
    expect([...seeded].sort()).toEqual(TABLES.filter((table) => table !== "account_deletion"));

    const answer = await me.remove();
    expect(answer.status).toBe(200);
    expect(await answer.json()).toEqual({ finished: true });

    for (const needle of needles) {
      expect(await tablesHolding(needle), needle).toEqual([]);
    }
    // Every card stands, as does what was worked out from them.
    expect(await roundOf(alone.id, 1)).toBeUndefined();
    const named = await roundOf(shared.id, 1);
    expect(named?.votes.votes).toEqual([
      { who: other.id, name: "Other Person", card: "13" },
      { who: null, name: null, card: "21" },
    ]);
    expect((await liveOf(shared.id))?.owner_user_id).toBe(other.id);
    const table = await liveOf(hidden.id);
    expect(
      Object.values(table?.live.round?.votes ?? {})
        .map(({ card }) => card)
        .sort(),
    ).toEqual(["1", "21"]);
  });

  it("every foreign key to a user cascades, so no row can hold a deleted person back", async () => {
    const { rows } = await admin.query<{ conname: string; confdeltype: string }>(
      `select conname, confdeltype from pg_constraint
       where contype = 'f' and confrelid = '"user"'::regclass`,
    );
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(row.confdeltype, row.conname).toBe("c");
  });

  it("the browser is a fresh guest, and a later sign-in is a new person with nothing", async () => {
    const person = newPerson();
    const me = await signedIn(person);
    const old = me.id;
    const room = await roomOf(me.id, "Gone With It");
    expect((await me.remove()).status).toBe(200);
    expect(await me.whoAmI()).toBe("");
    const guest = await me.asGuest();
    expect(guest.id).not.toBe(old);

    const again = await signedIn(person);
    expect(again.id).not.toBe(old);
    expect(await liveOf(room.id)).toBeUndefined();
    const overview = await (await again.go("/api/account")).json();
    expect(overview).toMatchObject({ alone: 0, seats: 0, shared: [] });
  });
});

describe("each kind of room", () => {
  it("deletes a room with nobody else, with its history, and its sockets hear it", async () => {
    const me = await signedIn();
    const room = await roomOf(me.id);
    const seat = await me.sit(room.code);
    await playRound(seat, [[seat, "5"]]);
    expect((await me.remove()).status).toBe(200);
    expect(await liveOf(room.id)).toBeUndefined();
    expect(await roundOf(room.id, 1)).toBeUndefined();
  });

  it("hands a room to the person seated longest when nothing was chosen", async () => {
    const me = await signedIn();
    const first = await new Browser().asGuest();
    const second = await new Browser().asGuest();
    const room = await roomOf(me.id);
    const po = await me.sit(room.code);
    const watcher = await first.sit(room.code);
    await second.sit(room.code);
    const seen = watcher.received.length;
    expect((await me.remove()).status).toBe(200);
    const { snapshot } = await watcher.waitFor(
      (s) => s.causes.some(({ type }) => type === "left"),
      3000,
      seen,
    );
    expect(snapshot.room.ownerId).toBe(first.id);
    expect(snapshot.causes.map(({ type }) => type)).toEqual(["ownerChanged", "left"]);
    const stored = await liveOf(room.id);
    expect(stored?.owner_user_id).toBe(first.id);
    expect(stored?.live.keeperId).toBe(first.id);
    expect(po.socket.connected).toBe(false);
  });

  it("hands it to the person chosen, or falls back when that person has gone", async () => {
    const me = await signedIn();
    const first = await new Browser().asGuest();
    const second = await new Browser().asGuest();
    const chosen = await roomOf(me.id);
    const stale = await roomOf(me.id);
    for (const room of [chosen, stale]) {
      await me.sit(room.code);
      await first.sit(room.code);
      await second.sit(room.code);
    }
    const rooms = [
      { id: chosen.id, to: second.id },
      { id: stale.id, to: "somebody-who-left" },
    ];
    expect((await me.remove(rooms)).status).toBe(200);
    expect((await liveOf(chosen.id))?.live.keeperId).toBe(second.id);
    expect((await liveOf(stale.id))?.live.keeperId).toBe(first.id);
  });

  it("deletes a room under other people only when the person chose that", async () => {
    const me = await signedIn();
    const other = await new Browser().asGuest();
    const room = await roomOf(me.id);
    await me.sit(room.code);
    const seat = await other.sit(room.code);
    const hears = new Promise<string>((resolve) => {
      seat.socket.once("deleted", () => resolve("deleted"));
    });
    expect((await me.remove([{ id: room.id, delete: true }])).status).toBe(200);
    await expect(hears).resolves.toBe("deleted");
    expect(await liveOf(room.id)).toBeUndefined();
  });

  it("takes only the seat from someone else's room, a kept right untouched", async () => {
    const me = await signedIn();
    const other = await signedIn();
    const room = await roomOf(other.id);
    await other.sit(room.code);
    await me.sit(room.code);
    expect((await me.remove([{ id: room.id, delete: true }])).status).toBe(200);
    const stored = await liveOf(room.id);
    expect(stored?.live.keeperId).toBe(other.id);
    expect(Object.keys(stored?.live.participants ?? {})).toEqual([other.id]);
  });

  it("gives a claimed role back, and leaves the keeper's right where it was", async () => {
    const me = await signedIn();
    const keeper = await signedIn();
    const someone = await new Browser().asGuest();
    const room = await roomOf(keeper.id);
    const keeperSeat = await keeper.sit(room.code);
    await someone.sit(room.code);
    const claimer = await me.sit(room.code);
    await awayLongEnough(room.id, keeper.id);
    await expect(claimer.cmd("claimOwner")).resolves.toMatchObject({ ok: true });
    await keeperSeat.cmd("leave");
    expect((await me.remove()).status).toBe(200);
    const stored = await liveOf(room.id);
    expect(stored?.owner_user_id).toBe(keeper.id);
    expect(stored?.live.keeperId).toBe(keeper.id);
    const after = await someone.sit(room.code).catch(() => null);
    expect(after).toBeNull();
    const seat = someone.socket();
    await seat.enter(room.code);
    await expect(seat.cmd("claimOwner")).resolves.toMatchObject({ ok: true });
    expect((await liveOf(room.id))?.live.keeperId).toBe(keeper.id);
  });

  it("deletes a room the person keeps with nobody seated, whoever holds the role", async () => {
    const me = await signedIn();
    const other = await new Browser().asGuest();
    const room = await roomOf(me.id);
    const seat = await me.sit(room.code);
    const otherSeat = await other.sit(room.code);
    await awayLongEnough(room.id, me.id);
    await expect(otherSeat.cmd("claimOwner")).resolves.toMatchObject({ ok: true });
    await otherSeat.cmd("leave");
    await seat.cmd("leave");
    expect((await me.remove()).status).toBe(200);
    expect(await liveOf(room.id)).toBeUndefined();
  });

  it("does not destroy a room whose keeper has no seat when a seated person goes", async () => {
    const me = await signedIn();
    const keeper = await signedIn();
    const room = await roomOf(keeper.id, "Keeper Away");
    await me.sit(room.code);
    expect((await me.remove()).status).toBe(200);
    const stored = await liveOf(room.id);
    expect(stored?.live.keeperId).toBe(keeper.id);
    expect(stored?.live.participants).toEqual({});
  });

  it("a room nobody may take holds no id of the person, follows the period, and can be claimed", async () => {
    const me = await signedIn();
    const other = await new Browser().asGuest();
    const room = await roomOf(me.id);
    const stays = await other.sit(room.code);
    const vacant = "b".repeat(32);
    await expect(
      sync.removeAccount(room, { who: me.id, ghost: "a".repeat(32), vacant, mayTake: [] }),
    ).resolves.toBe("changed");
    const stored = await liveOf(room.id);
    expect(stored?.owner_user_id).toBe(vacant);
    expect(stored?.live.keeperId).toBe(vacant);
    expect(JSON.stringify(stored)).not.toContain(me.id);
    await expect(store().roomsOf(me.id)).resolves.toEqual([]);

    const seen = stays.received.length;
    await expect(stays.cmd("claimOwner")).resolves.toMatchObject({ ok: true });
    await stays.waitFor((s) => s.room.ownerId === other.id, 3000, seen);
    expect((await liveOf(room.id))?.live.keeperId).toBe(vacant);

    await admin.query(
      "update room set last_active_at = now() - interval '200 days' where id = $1",
      [room.id],
    );
    await setup.database.retention.purge({ ttlDays: 90 });
    expect(await liveOf(room.id)).toBeUndefined();
    await setup.deletions.sweep();
  });

  it("a guest who takes a room gets the whole period, and no exemption", async () => {
    const me = await signedIn();
    const other = await new Browser().asGuest();
    const room = await roomOf(me.id);
    await me.sit(room.code);
    await other.sit(room.code);
    await admin.query(
      "update room set last_active_at = now() - interval '200 days' where id = $1",
      [room.id],
    );
    expect((await me.remove()).status).toBe(200);
    const { rows } = await admin.query(
      "select last_active_at > now() - interval '1 minute' as fresh from room where id = $1",
      [room.id],
    );
    expect(rows[0]).toEqual({ fresh: true });

    // That period is all it has: idle past it, a real purge takes the room a guest keeps.
    await admin.query(
      "update room set last_active_at = now() - interval '200 days' where id = $1",
      [room.id],
    );
    await setup.database.retention.purge({ ttlDays: 90 });
    expect(await liveOf(room.id)).toBeUndefined();
  });

  it("someone signed in who takes a room holds the exemption from then on", async () => {
    const me = await signedIn();
    const other = await signedIn();
    const room = await roomOf(me.id);
    await me.sit(room.code);
    await other.sit(room.code);
    expect((await me.remove()).status).toBe(200);
    await admin.query(
      "update room set last_active_at = now() - interval '200 days' where id = $1",
      [room.id],
    );
    await setup.database.retention.purge({ ttlDays: 90 });
    expect((await liveOf(room.id))?.live.keeperId).toBe(other.id);
  });

  it("a seat that goes fakes no activity", async () => {
    const me = await signedIn();
    const other = await new Browser().asGuest();
    const room = await roomOf(other.id);
    await other.sit(room.code);
    await me.sit(room.code);
    await admin.query("update room set last_active_at = now() - interval '20 days' where id = $1", [
      room.id,
    ]);
    expect((await me.remove()).status).toBe(200);
    const { rows } = await admin.query(
      "select last_active_at < now() - interval '19 days' as idle from room where id = $1",
      [room.id],
    );
    expect(rows[0]).toEqual({ idle: true });
  });
});

describe("the people in a live room", () => {
  it("see a leave while a round votes, and the card goes as a leaver's does", async () => {
    const me = await signedIn();
    const other = await signedIn();
    const third = await new Browser().asGuest();
    const room = await roomOf(other.id, null, { revealWhenAllVoted: false });
    const po = await other.sit(room.code);
    await third.sit(room.code);
    const seat = await me.sit(room.code);
    await po.cmd("startRound", { subject: { kind: "none" } });
    await seat.cmd("castVote", { card: "13", round: 1 });
    const seen = po.received.length;
    expect((await me.remove()).status).toBe(200);
    const { snapshot } = await po.waitFor(
      (s) => s.causes.some(({ type }) => type === "left"),
      3000,
      seen,
    );
    expect(snapshot.room.round?.phase).toBe("voting");
    expect(snapshot.room.round?.voted).toEqual([]);
  });

  it("keeps a named card with no name, and says nothing of whose it was in any frame after", async () => {
    const person = newPerson();
    const me = await signedIn(person);
    const other = await signedIn();
    const room = await roomOf(other.id, null, { revealWhenAllVoted: false });
    const po = await other.sit(room.code);
    const seat = await me.sit(room.code, person.name);
    await po.cmd("startRound", { subject: { kind: "none" } });
    await seat.cmd("castVote", { card: "13", round: 1 });
    await po.cmd("castVote", { card: "3", round: 1 });
    await po.cmd("reveal");
    const seen = po.frames.length;
    expect((await me.remove()).status).toBe(200);
    await po.waitFor((s) => s.room.participants.length === 1);
    const later = po.frames.slice(seen);
    const last = po.latest()?.room.round;
    expect(
      last?.phase === "revealed" && !last.anonymous && last.votes.map((v) => v.card).sort(),
    ).toEqual(["13", "3"]);
    const after = later.at(-1) ?? "";
    expect(after).not.toContain(person.name);
    expect(JSON.stringify(po.latest()?.room.participants)).not.toContain(me.id);
    expect(JSON.stringify(last)).not.toContain(me.id);
  });

  it("closes every socket of the person, on hearing why", async () => {
    const me = await signedIn();
    const room = await roomOf(me.id);
    const seat = await me.sit(room.code);
    const hears = new Promise<string[]>((resolve) => {
      const events: string[] = [];
      seat.socket.once("accountDeleted", () => events.push("accountDeleted"));
      seat.socket.once("disconnect", (reason) => resolve([...events, reason]));
    });
    expect((await me.remove()).status).toBe(200);
    await expect(hears).resolves.toEqual(["accountDeleted", "io server disconnect"]);
  });

  it("a person mid-deletion cannot come back through an open socket or a stale cookie", async () => {
    const me = await signedIn();
    const other = await new Browser().asGuest();
    const room = await roomOf(other.id);
    await other.sit(room.code);
    const seat = await me.sit(room.code);
    vi.spyOn(sync, "removeAccount").mockResolvedValue("failed");
    const stale = me.cookie;
    expect(await (await me.remove()).json()).toEqual({ finished: false });
    expect(await me.whoAmI()).toBe("");
    expect(seat.socket.connected).toBe(false);
    const again = socketClient(at, { cookie: stale });
    open.push(again);
    const refused = new Promise<string>((resolve) => {
      again.socket.once("connect_error", (error) => resolve(error.message));
    });
    await expect(refused).resolves.toBe("unauthenticated");
    vi.restoreAllMocks();
    await setup.deletions.sweep();
  });
});

describe("a room's rule", () => {
  const RULE = { domains: ["allowed.example"], tenants: [] };

  /** Someone the rule passes. */
  const admitted = () => {
    const person = newPerson();
    const email = `member-${people}-${Date.now()}@allowed.example`;
    secrets.push(email);
    return signedIn({ ...person, email });
  };

  const setRule = (id: string) =>
    admin.query(
      `update room set live = jsonb_set(live, '{settings,restriction}', $2::jsonb) where id = $1`,
      [id, JSON.stringify(RULE)],
    );

  const setKeeper = (id: string, keeper: string) =>
    admin.query(
      `update room set live = jsonb_set(live, '{keeperId}', to_jsonb($2::text)) where id = $1`,
      [id, keeper],
    );

  const overviewOf = async (me: Browser) =>
    (await (await me.go("/api/account")).json()) as {
      alone: number;
      seats: number;
      held: number;
      shared: { id: string; why: string; seats: { id: string; name: string }[] }[];
    };

  const idle = (id: string) =>
    admin.query("update room set last_active_at = now() - interval '200 days' where id = $1", [id]);

  const userGone = async (id: string) => {
    const { rows } = await admin.query('select 1 from "user" where id = $1', [id]);
    expect(rows).toHaveLength(0);
  };

  /** Someone who keeps a room with a guest and an outsider seated before its rule, and a member. */
  async function ruledRoom() {
    const me = await admitted();
    const guest = await new Browser().asGuest();
    const outsider = await signedIn();
    const member = await admitted();
    const room = await roomOf(me.id, "With A Rule");
    await me.sit(room.code);
    await guest.sit(room.code, "Seated Guest");
    await outsider.sit(room.code, "Seated Outsider");
    await member.sit(room.code, "Seated Member");
    await setRule(room.id);
    return { me, guest, outsider, member, room };
  }

  it("offers only who may take it, and that default is what the server does", async () => {
    const { me, member, room } = await ruledRoom();
    const overview = await overviewOf(me);
    expect(overview.shared).toMatchObject([
      { id: room.id, why: "here", seats: [{ id: member.id, name: "Seated Member" }] },
    ]);
    expect(JSON.stringify(overview)).not.toContain("Outsider");
    expect(JSON.stringify(overview)).not.toContain("Guest");
    expect((await me.remove()).status).toBe(200);
    const stored = await liveOf(room.id);
    expect(stored?.owner_user_id).toBe(member.id);
    expect(stored?.live.keeperId).toBe(member.id);
  });

  it("judges at the step: a choice the rule refuses since the page was read takes nothing", async () => {
    const me = await admitted();
    const outsider = await signedIn();
    const member = await admitted();
    const room = await roomOf(me.id);
    await me.sit(room.code);
    await outsider.sit(room.code);
    await member.sit(room.code);
    const before = await overviewOf(me);
    expect(before.shared[0]?.seats.map(({ id }) => id)).toEqual([outsider.id, member.id]);
    await setRule(room.id);
    expect((await me.remove([{ id: room.id, to: outsider.id }])).status).toBe(200);
    expect((await liveOf(room.id))?.live.keeperId).toBe(member.id);
  });

  it("leaves it with nobody when nobody seated passes, and the page says so", async () => {
    const me = await admitted();
    const outsider = await signedIn();
    const room = await roomOf(me.id);
    await me.sit(room.code);
    const seat = await outsider.sit(room.code, "Seated Outsider");
    await setRule(room.id);
    const overview = await overviewOf(me);
    expect(overview).toMatchObject({ alone: 0, shared: [{ why: "nobody", seats: [] }] });
    const id = me.id;
    expect(await (await me.remove()).json()).toEqual({ finished: true });
    await userGone(id);
    const stored = await liveOf(room.id);
    expect(stored?.live.keeperId).toMatch(/^[0-9a-f]{32}$/);
    expect(stored?.owner_user_id).toBe(stored?.live.keeperId);
    expect(Object.keys(stored?.live.participants ?? {})).toEqual([outsider.id]);
    expect(seat.socket.connected).toBe(true);
    await idle(room.id);
    await setup.database.retention.purge({ ttlDays: 90 });
    expect(await liveOf(room.id)).toBeUndefined();
  });

  it("asks what the door asks: no live session, or a sign-in too old, takes nothing", async () => {
    for (const age of ["gone", "old"]) {
      const me = await admitted();
      const member = await admitted();
      const room = await roomOf(me.id);
      await me.sit(room.code);
      await member.sit(room.code);
      await setRule(room.id);
      await admin.query(
        age === "gone"
          ? "delete from session where user_id = $1"
          : "update session set created_at = now() - interval '31 days' where user_id = $1",
        [member.id],
      );
      expect((await overviewOf(me)).shared[0]?.why).toBe("nobody");
      expect((await me.remove()).status).toBe(200);
      expect((await liveOf(room.id))?.live.keeperId).not.toBe(member.id);
    }
  });

  it("reads nobody for a room with no rule, and each person once for many with one", async () => {
    const me = await admitted();
    const member = await admitted();
    const plain = await roomOf(me.id);
    await me.sit(plain.code);
    await member.sit(plain.code);
    const candidates = vi.spyOn(setup.rules, "candidateOf");
    const identities = vi.spyOn(setup.rules, "identitiesOf");
    await overviewOf(me);
    expect(candidates).not.toHaveBeenCalled();

    const ruled = [await roomOf(me.id), await roomOf(me.id)];
    for (const room of ruled) {
      await me.sit(room.code);
      await member.sit(room.code);
      await setRule(room.id);
    }
    candidates.mockClear();
    await overviewOf(me);
    expect(candidates.mock.calls.filter(([id]) => id === member.id)).toHaveLength(1);

    await admin.query("delete from room where id = any($1)", [ruled.map(({ id }) => id)]);
    candidates.mockClear();
    identities.mockClear();
    expect((await me.remove()).status).toBe(200);
    expect(candidates).not.toHaveBeenCalled();
    expect(identities).not.toHaveBeenCalled();
    expect((await liveOf(plain.id))?.live.keeperId).toBe(member.id);
  });

  /** `owner` runs a room `me` keeps, whose rule refuses `me`. */
  async function shutOut(me: Browser, owner: Browser, settings = {}) {
    const room = await roomOf(owner.id, "Not For You", settings);
    const seat = await owner.sit(room.code, "Runs It");
    await setKeeper(room.id, me.id);
    await setRule(room.id);
    return { room, seat };
  }

  it("a keeper the rule refuses reads nothing of the room, on the page or in the file", async () => {
    const me = await signedIn();
    const owner = await admitted();
    const room = await roomOf(owner.id, "Not For You");
    const po = await owner.sit(room.code, "Runs It");
    const seat = await me.sit(room.code, "Going");
    await playRound(po, [
      [seat, "5"],
      [po, "3"],
    ]);
    await seat.cmd("leave");
    await setKeeper(room.id, me.id);
    await setRule(room.id);
    await admin.query("insert into room_access (room_id, user_id) values ($1, $2)", [
      room.id,
      me.id,
    ]);

    const overview = await overviewOf(me);
    expect(overview).toMatchObject({ alone: 0, held: 1, shared: [] });
    const page = JSON.stringify(overview);
    for (const absent of ["Not For You", "Runs It", owner.id, room.id]) {
      expect(page).not.toContain(absent);
    }

    const text = await (await me.go("/api/account/export")).text();
    const file = JSON.parse(text) as Record<string, unknown>;
    expect(file.rooms).toEqual([{ id: room.id, withheld: true }]);
    expect(file.grants).toMatchObject([{ room: { id: room.id, name: null } }]);
    expect(file.votes).toMatchObject([
      { room: { id: room.id, name: null }, subject: null, card: "5" },
    ]);
    for (const absent of ["Not For You", "Runs It", "A story", owner.id, room.code]) {
      expect(text).not.toContain(absent);
    }
  });

  it("a keeper the rule refuses destroys nothing, whatever a request says", async () => {
    const me = await signedIn();
    const owner = await admitted();
    const { room } = await shutOut(me, owner);
    const id = me.id;
    expect(await (await me.remove([{ id: room.id, delete: true }])).json()).toEqual({
      finished: true,
    });
    await userGone(id);
    const stored = await liveOf(room.id);
    expect(stored?.live.keeperId).toBe(owner.id);
    expect(stored?.owner_user_id).toBe(owner.id);
    expect(JSON.stringify(stored)).not.toContain(id);
  });

  it("with nobody else seated it stays under no keeper, follows the period, and the id goes", async () => {
    const me = await signedIn();
    const owner = await admitted();
    const { room, seat } = await shutOut(me, owner);
    await seat.cmd("leave");
    await vi.waitFor(async () =>
      expect(Object.keys((await liveOf(room.id))?.live.participants ?? {})).toEqual([]),
    );
    const id = me.id;
    expect(await (await me.remove([{ id: room.id, delete: true }])).json()).toEqual({
      finished: true,
    });
    await userGone(id);
    const stored = await liveOf(room.id);
    expect(stored?.live.keeperId).toMatch(/^[0-9a-f]{32}$/);
    expect(stored?.owner_user_id).toBe(owner.id);
    expect(JSON.stringify(stored)).not.toContain(id);
    await idle(room.id);
    await setup.database.retention.purge({ ttlDays: 90 });
    expect(await liveOf(room.id)).toBeUndefined();
  });

  it("a choice of heir from a keeper the rule refuses is no choice", async () => {
    const me = await signedIn();
    const owner = await admitted();
    const member = await admitted();
    const { room } = await shutOut(me, owner);
    await member.sit(room.code);
    expect((await me.remove([{ id: room.id, to: member.id }])).status).toBe(200);
    expect((await liveOf(room.id))?.live.keeperId).toBe(owner.id);
  });

  it("a keeper the rule passes still chooses, though the deletion ended their sessions", async () => {
    const me = await admitted();
    const owner = await admitted();
    const member = await admitted();
    const { room } = await shutOut(me, owner);
    await member.sit(room.code);
    expect((await me.remove([{ id: room.id, to: member.id }])).status).toBe(200);
    expect((await liveOf(room.id))?.live.keeperId).toBe(member.id);
  });

  it("a keeper the rule passes, and a PO it does not, may still delete", async () => {
    const passes = await admitted();
    const owner = await admitted();
    const first = await shutOut(passes, owner);
    await first.seat.cmd("leave");
    await vi.waitFor(async () =>
      expect(Object.keys((await liveOf(first.room.id))?.live.participants ?? {})).toEqual([]),
    );
    expect((await overviewOf(passes)).alone).toBe(1);
    expect((await passes.remove()).status).toBe(200);
    expect(await liveOf(first.room.id)).toBeUndefined();

    const po = await signedIn();
    const room = await roomOf(po.id);
    await setRule(room.id);
    expect((await overviewOf(po)).alone).toBe(1);
    expect((await po.remove()).status).toBe(200);
    expect(await liveOf(room.id)).toBeUndefined();
  });

  it("a rule set after the keeper was judged keeps the room from both statements", async () => {
    const me = await admitted();
    const room = await roomOf(me.id);
    const seen = { ...room, ownerId: me.id, rule: null };
    await setRule(room.id);
    await expect(store().deleteAlone(seen, me.id)).resolves.toBe(false);
    await expect(store().deleteKept(seen, me.id)).resolves.toBe(false);
    const claimed = { ...seen, ownerId: "someone-before", rule: RULE };
    await expect(store().deleteKept(claimed, me.id)).resolves.toBe(false);
    await expect(store().deleteKept({ ...claimed, ownerId: me.id }, me.id)).resolves.toBe(true);
  });
});

describe("a join against the end of a deletion", () => {
  it("a join that passed its session check cannot commit once the row has gone", async () => {
    const me = await signedIn();
    const other = await new Browser().asGuest();
    const room = await roomOf(other.id);
    await other.sit(room.code);
    const seat = me.socket();
    await expect(seat.enter(room.code)).resolves.toMatchObject({ ok: true });
    const client = await admin.connect();
    await client.query("begin");
    await client.query("select 1 from room where id = $1 for update", [room.id]);
    const join = seat.cmd("join", { name: "Late", role: "voter" });
    await new Promise((resolve) => setTimeout(resolve, 150));
    await expect(store().finish(me.id)).resolves.toBe(true);
    await client.query("commit");
    client.release();
    await expect(join).resolves.toMatchObject({ ok: false });
    expect(JSON.stringify(await liveOf(room.id))).not.toContain(me.id);
  });

  it("a guest's join needs no account, and an account's lands as before", async () => {
    const me = await signedIn();
    const guest = await new Browser().asGuest();
    const room = await roomOf(guest.id);
    await guest.sit(room.code);
    await me.sit(room.code);
    expect(Object.keys((await liveOf(room.id))?.live.participants ?? {}).sort()).toEqual(
      [me.id, guest.id].sort(),
    );
  });
});

describe("named history", () => {
  it("keeps every card and the results, and a place in the list says nothing", async () => {
    const first = await signedIn();
    const second = await signedIn();
    const other = await new Browser().asGuest();
    const room = await roomOf(other.id);
    const po = await other.sit(room.code, "Stays");
    const a = await first.sit(room.code, "First Going");
    const b = await second.sit(room.code, "Second Going");
    await playRound(po, [
      [a, "13"],
      [po, "3"],
      [b, "5"],
    ]);
    const before = await roundOf(room.id, 1);
    expect((await second.remove()).status).toBe(200);
    expect((await first.remove()).status).toBe(200);
    const after = await roundOf(room.id, 1);
    expect(after?.stats).toEqual(before?.stats);
    expect(after?.votes.votes).toEqual([
      { who: other.id, name: "Stays", card: "3" },
      { who: null, name: null, card: "13" },
      { who: null, name: null, card: "5" },
    ]);
  });

  it("drops the mark of a changed card with the name", async () => {
    const me = await signedIn();
    const other = await signedIn();
    const room = await roomOf(other.id, null, { allowChangeAfterReveal: true });
    const po = await other.sit(room.code, "Stays");
    const seat = await me.sit(room.code, "Going");
    await po.cmd("startRound", { subject: { kind: "none" } });
    await seat.cmd("castVote", { card: "5", round: 1 });
    await po.cmd("castVote", { card: "3", round: 1 });
    await seat.cmd("castVote", { card: "8", round: 1 });
    await po.cmd("startRound", { subject: { kind: "none" } });
    expect((await roundOf(room.id, 1))?.votes.votes?.[1]).toMatchObject({
      changedAfterReveal: true,
    });
    expect((await me.remove()).status).toBe(200);
    expect((await roundOf(room.id, 1))?.votes.votes?.[1]).toEqual({
      who: null,
      name: null,
      card: "8",
    });
  });

  it("a round with one voter keeps the card and names nobody", async () => {
    const me = await signedIn();
    const other = await signedIn();
    const room = await roomOf(other.id);
    const po = await other.sit(room.code, "Stays");
    await po.cmd("setRole", { role: "observer" });
    const seat = await me.sit(room.code, "Going");
    await playRound(po, [[seat, "8"]]);
    expect((await me.remove()).status).toBe(200);
    expect((await roundOf(room.id, 1))?.votes.votes).toEqual([
      { who: null, name: null, card: "8" },
    ]);
    const reader = other.socket();
    await reader.enter(room.code);
    const page = await reader.history();
    expect(page).toMatchObject({
      ok: true,
      rounds: [{ votes: { kind: "named", votes: [{ name: null, card: "8" }] } }],
    });
  });

  it("leaves an anonymous round byte for byte", async () => {
    const me = await signedIn();
    const other = await signedIn();
    const room = await roomOf(other.id, null, { revealNames: false });
    const po = await other.sit(room.code);
    const seat = await me.sit(room.code);
    await playRound(po, [
      [seat, "5"],
      [po, "3"],
    ]);
    const before = await roundOf(room.id, 1);
    expect((await me.remove()).status).toBe(200);
    expect(await roundOf(room.id, 1)).toEqual(before);
  });

  it("a round rewritten after the deletion names nobody either", async () => {
    const me = await signedIn();
    const other = await signedIn();
    const room = await roomOf(other.id, null, { revealWhenAllVoted: false });
    const po = await other.sit(room.code, "Stays");
    const seat = await me.sit(room.code, "Going");
    await po.cmd("startRound", { subject: { kind: "none" } });
    await seat.cmd("castVote", { card: "5", round: 1 });
    await po.cmd("castVote", { card: "3", round: 1 });
    await po.cmd("reveal");
    await po.cmd("setFinal", { card: "5" });
    expect((await me.remove()).status).toBe(200);
    await po.cmd("startRound", { subject: { kind: "none" } });
    const row = await roundOf(room.id, 1);
    expect(JSON.stringify(row)).not.toContain(me.id);
    expect(JSON.stringify(row)).not.toContain("Going");
    expect(row?.votes.votes?.map(({ card }) => card).sort()).toEqual(["3", "5"]);
  });
});

describe("what fails, and how it comes out", () => {
  it("nothing changes when the first step fails, and the person is told", async () => {
    const me = await signedIn();
    const room = await roomOf(me.id);
    vi.spyOn(setup.deletions, "start");
    await admin.query("alter table account_deletion rename to account_deletion_held");
    try {
      const answer = await me.remove();
      expect(answer.status).toBe(500);
      expect(await answer.json()).toEqual({ code: "internal" });
    } finally {
      await admin.query("alter table account_deletion_held rename to account_deletion");
    }
    expect(await me.whoAmI()).not.toBe("");
    expect((await liveOf(room.id))?.owner_user_id).toBe(me.id);
  });

  it("one room nobody can read stops the last step alone, and a repair lets it finish", async () => {
    const me = await signedIn();
    const other = await new Browser().asGuest();
    const guest = await new Browser().asGuest();

    const broken = await roomOf(me.id, "Broken");
    await me.sit(broken.code);
    await other.sit(broken.code);
    const handed = await roomOf(me.id, "Handed Over");
    await me.sit(handed.code);
    await other.sit(handed.code);
    const theirs = await roomOf(other.id, "Theirs");
    const po = await other.sit(theirs.code, "Stays");
    const seat = await me.sit(theirs.code, "Going");
    await playRound(po, [
      [seat, "5"],
      [po, "3"],
    ]);
    const guestsRoom = await roomOf(other.id, "Guest Seat");
    await other.sit(guestsRoom.code);
    await guest.sit(guestsRoom.code);
    await admin.query("insert into guest_link (guest_user_id, account_user_id) values ($1, $2)", [
      guest.id,
      me.id,
    ]);
    vi.spyOn(sync, "moveGuest").mockResolvedValue("failed");
    await admin.query(
      `insert into connector_token (user_id, connector, sealed_token)
       values ($1, 'jira', 'v1.key.iv.sealed')`,
      [me.id],
    );
    const intact = (await liveOf(broken.id))?.live;
    await admin.query(
      `update room set live = jsonb_set(live, '{round}', '"not a round"') where id = $1`,
      [broken.id],
    );

    expect(await (await me.remove()).json()).toEqual({ finished: false });

    expect((await liveOf(handed.id))?.live.keeperId).toBe(other.id);
    expect(JSON.stringify(await liveOf(handed.id))).not.toContain(me.id);
    expect(JSON.stringify(await liveOf(theirs.id))).not.toContain(me.id);
    expect(JSON.stringify(await liveOf(guestsRoom.id))).not.toContain(guest.id);
    const round = await roundOf(theirs.id, 1);
    expect(JSON.stringify(round)).not.toContain(me.id);
    expect(JSON.stringify(round)).not.toContain("Going");
    expect(round?.votes.votes?.map(({ card }) => card).sort()).toEqual(["3", "5"]);
    const { rows: tokens } = await admin.query("select 1 from connector_token where user_id = $1", [
      me.id,
    ]);
    expect(tokens).toHaveLength(0);
    // Only what `finish` does is left: the row, the marker, the guest.
    const { rows: marker } = await admin.query(
      "select 1 from account_deletion where user_id = $1",
      [me.id],
    );
    expect(marker).toHaveLength(1);
    const { rows: users } = await admin.query('select 1 from "user" where id = any($1)', [
      [me.id, guest.id],
    ]);
    expect(users).toHaveLength(2);
    expect(JSON.stringify((await liveOf(broken.id))?.live)).toContain(me.id);

    await admin.query("update room set live = $2 where id = $1", [broken.id, intact]);
    await setup.deletions.sweep();
    expect((await liveOf(broken.id))?.live.keeperId).toBe(other.id);
    const { rows: gone } = await admin.query('select 1 from "user" where id = any($1)', [
      [me.id, guest.id],
    ]);
    expect(gone).toHaveLength(0);
  });

  it("says `finished: false`, keeps the marker, and finishes at the next sweep", async () => {
    const me = await signedIn();
    const other = await new Browser().asGuest();
    const stuck = await roomOf(me.id);
    await me.sit(stuck.code);
    await other.sit(stuck.code);
    const fine = await roomOf(me.id);
    const failing = vi.spyOn(sync, "removeAccount").mockRejectedValue(new Error("in the room"));
    const answer = await me.remove([{ id: stuck.id, to: other.id }]);
    const id = me.id;
    expect(await answer.json()).toEqual({ finished: false });
    expect(await me.whoAmI()).toBe("");
    expect(await liveOf(fine.id)).toBeUndefined();
    expect((await liveOf(stuck.id))?.owner_user_id).toBe(id);
    const { rows } = await admin.query("select 1 from account_deletion where user_id = $1", [id]);
    expect(rows).toHaveLength(1);
    const { rows: users } = await admin.query('select 1 from "user" where id = $1', [id]);
    expect(users).toHaveLength(1);
    failing.mockRestore();

    await setup.deletions.sweep();
    expect((await liveOf(stuck.id))?.live.keeperId).toBe(other.id);
    const { rows: gone } = await admin.query('select 1 from "user" where id = $1', [id]);
    expect(gone).toHaveLength(0);
  });

  it("a purge starts what nobody finished", async () => {
    const me = await signedIn();
    const other = await new Browser().asGuest();
    const room = await roomOf(me.id);
    await me.sit(room.code);
    await other.sit(room.code);
    const failing = vi.spyOn(sync, "removeAccount").mockResolvedValue("failed");
    expect(await (await me.remove()).json()).toEqual({ finished: false });
    failing.mockRestore();
    await setup.retention.runNow();
    const { rows } = await admin.query('select 1 from "user" where id = $1', [me.id]);
    expect(rows).toHaveLength(0);
  });

  it("refuses a sign-in during it, says why, and that sign-in starts it again", async () => {
    const person = newPerson();
    const me = await signedIn(person);
    const other = await new Browser().asGuest();
    const room = await roomOf(me.id);
    await me.sit(room.code);
    await other.sit(room.code);
    const failing = vi.spyOn(sync, "removeAccount").mockResolvedValue("failed");
    expect(await (await me.remove()).json()).toEqual({ finished: false });

    const later = new Browser();
    const location = await later.signIn(person);
    expect(location).toBe(`${ORIGIN}/?sign_in_error=account_going`);
    expect(await later.whoAmI()).toBe("");
    const { rows: sessions } = await admin.query("select 1 from session where user_id = $1", [
      me.id,
    ]);
    expect(sessions).toHaveLength(0);

    failing.mockRestore();
    const after = new Browser();
    await vi.waitFor(async () => {
      const landed = await after.signIn(person);
      expect(landed).toBe(`${ORIGIN}/account`);
    });
    expect(after.id).not.toBe(me.id);
    expect(after.id).not.toBe("");
  });

  it("`enter` of a session that slipped in finishes it", async () => {
    const me = await signedIn();
    const other = await new Browser().asGuest();
    const room = await roomOf(other.id);
    await other.sit(room.code);
    const held = vi.spyOn(sync, "removeAccount").mockResolvedValue("failed");
    await me.sit(room.code);
    const copy = new Browser();
    for (const [name, value] of me.jar) copy.jar.set(name, value);
    const { rows } = await admin.query("select * from session where user_id = $1", [me.id]);
    const session = rows[0] as { id: string; token: string; expires_at: Date };
    expect((await me.remove()).status).toBe(200);
    await admin.query(
      `insert into session (id, token, user_id, expires_at, created_at, updated_at)
       values ($1, $2, $3, $4, now(), now())`,
      [session.id, session.token, me.id, session.expires_at],
    );
    held.mockRestore();
    const seat = copy.socket();
    await seat.enter(room.code);
    await vi.waitFor(async () => {
      const { rows: left } = await admin.query('select 1 from "user" where id = $1', [me.id]);
      expect(left).toHaveLength(0);
    });
  });

  it("two requests at once come to one deletion, and both are told the truth", async () => {
    const me = await signedIn();
    const other = await new Browser().asGuest();
    const room = await roomOf(me.id);
    await me.sit(room.code);
    await other.sit(room.code);
    const answers = await Promise.all([
      me.remove([{ id: room.id, to: other.id }]),
      me.remove([{ id: room.id, delete: true }]),
    ]);
    for (const answer of answers) {
      expect([200, 401]).toContain(answer.status);
      if (answer.status === 200) expect(await answer.json()).toEqual({ finished: true });
    }
    const { rows } = await admin.query('select 1 from "user" where id = $1', [me.id]);
    expect(rows).toHaveLength(0);
  });

  it("a second request after the first hears no session, and changes nothing", async () => {
    const me = await signedIn();
    expect((await me.remove()).status).toBe(200);
    const second = await me.remove();
    expect(second.status).toBe(401);
  });

  it("a room deleted meanwhile, and a run on it, are no failure", async () => {
    const me = await signedIn();
    const other = await new Browser().asGuest();
    const room = await roomOf(me.id);
    await me.sit(room.code);
    await other.sit(room.code);
    const real = sync.removeAccount;
    vi.spyOn(sync, "removeAccount").mockImplementation(async (found, removal) => {
      await admin.query("delete from room where id = $1", [found.id]);
      return real(found, removal);
    });
    expect(await (await me.remove()).json()).toEqual({ finished: true });
  });

  it("hands over a room the person keeps from outside it", async () => {
    const me = await signedIn();
    const other = await new Browser().asGuest();
    const room = await roomOf(me.id);
    await other.sit(room.code);
    expect((await me.remove()).status).toBe(200);
    expect((await liveOf(room.id))?.live.keeperId).toBe(other.id);
  });

  it("a join that commits while a room is about to go keeps it", async () => {
    const me = await signedIn();
    const room = await roomOf(me.id);
    const client = await admin.connect();
    await client.query("begin");
    await client.query(
      `update room set live = jsonb_set(live, '{participants,late}',
         '{"name":"Late","role":"voter","joinedAt":1,"connected":true}') where id = $1`,
      [room.id],
    );
    const seen = { ...room, ownerId: me.id, rule: null };
    const attempt = store().deleteAlone(seen, me.id);
    await new Promise((resolve) => setTimeout(resolve, 100));
    await client.query("commit");
    client.release();
    await expect(attempt).resolves.toBe(false);
    expect(await liveOf(room.id)).toBeDefined();
  });

  it("the last step changes nothing while a room or a round still names the person", async () => {
    const me = await signedIn();
    const other = await signedIn();
    const room = await roomOf(other.id);
    const po = await other.sit(room.code);
    const seat = await me.sit(room.code);
    await playRound(po, [
      [seat, "5"],
      [po, "3"],
    ]);
    expect(await store().finish(me.id)).toBe(false);
    await seat.cmd("leave");
    await vi.waitFor(async () => {
      const stored = await liveOf(room.id);
      expect(Object.keys(stored?.live.participants ?? {})).toEqual([other.id]);
    });
    expect(await store().finish(me.id)).toBe(false);
    await store().anonymiseRounds(me.id);
    expect(await store().finish(me.id)).toBe(true);
    expect(await store().finish(me.id)).toBe(true);
    const { rows } = await admin.query('select 1 from "user" where id = $1', [me.id]);
    expect(rows).toHaveLength(0);
  });

  it("a guest's move in flight is stopped, and its seat goes with the person", async () => {
    const me = await signedIn();
    const guest = await new Browser().asGuest();
    const other = await new Browser().asGuest();
    const room = await roomOf(guest.id, "Guest Kept");
    await guest.sit(room.code, "Guest Seat");
    await other.sit(room.code);
    await admin.query("insert into guest_link (guest_user_id, account_user_id) values ($1, $2)", [
      guest.id,
      me.id,
    ]);
    await admin.query("delete from session where user_id = $1", [guest.id]);
    const move = vi.spyOn(sync, "moveGuest").mockResolvedValue("failed");
    expect(await (await me.remove()).json()).toEqual({ finished: true });
    const stored = await liveOf(room.id);
    expect(JSON.stringify(stored)).not.toContain(guest.id);
    expect(stored?.live.keeperId).toBe(other.id);
    const { rows } = await admin.query('select 1 from "user" where id = $1', [guest.id]);
    expect(rows).toHaveLength(0);
    move.mockRestore();
    await setup.links.sweep();
  });

  it("gives a guest's move its moment before the marker stops it", async () => {
    const me = await signedIn();
    const guest = await new Browser().asGuest();
    const room = await roomOf(guest.id, "Still Moving");
    await admin.query("insert into guest_link (guest_user_id, account_user_id) values ($1, $2)", [
      guest.id,
      me.id,
    ]);
    const move = vi.spyOn(sync, "moveGuest");
    expect(await (await me.remove()).json()).toEqual({ finished: true });
    expect(move).toHaveBeenCalled();
    expect(await liveOf(room.id)).toBeUndefined();
  });

  it("the page says when a guest's rooms are still moving", async () => {
    const me = await signedIn();
    const guest = await new Browser().asGuest();
    const room = await roomOf(guest.id);
    await admin.query("insert into guest_link (guest_user_id, account_user_id) values ($1, $2)", [
      guest.id,
      me.id,
    ]);
    const move = vi.spyOn(sync, "moveGuest").mockResolvedValue("failed");
    expect(await (await me.go("/api/account")).json()).toMatchObject({ moving: true });
    move.mockRestore();
    await setup.links.sweep();
    const settled = await (await me.go("/api/account")).json();
    expect(settled).not.toHaveProperty("moving");
    expect((await liveOf(room.id))?.live.keeperId).toBe(me.id);
  });

  it("the last step sees a seat that committed while it waited for the row", async () => {
    const me = await signedIn();
    const other = await signedIn();
    const room = await roomOf(other.id);
    const client = await admin.connect();
    await client.query("begin");
    await client.query('select 1 from "user" where id = $1 for share', [me.id]);
    await client.query(
      `update room set live = jsonb_set(live, array['participants', $2::text],
         '{"name":"Late","role":"voter","joinedAt":1,"connected":true}') where id = $1`,
      [room.id, me.id],
    );
    const attempt = store().finish(me.id);
    await new Promise((resolve) => setTimeout(resolve, 100));
    await client.query("commit");
    client.release();
    await expect(attempt).resolves.toBe(false);
    const { rows } = await admin.query('select 1 from "user" where id = $1', [me.id]);
    expect(rows).toHaveLength(1);
    await admin.query("delete from room where id = $1", [room.id]);
  });

  it("the last step sees a guest's link that committed while it waited for the row", async () => {
    const me = await signedIn();
    const guest = await new Browser().asGuest();
    const other = await new Browser().asGuest();
    const room = await roomOf(other.id);
    await other.sit(room.code);
    await guest.sit(room.code);
    const client = await admin.connect();
    await client.query("begin");
    await client.query("insert into guest_link (guest_user_id, account_user_id) values ($1, $2)", [
      guest.id,
      me.id,
    ]);
    const attempt = store().finish(me.id);
    await new Promise((resolve) => setTimeout(resolve, 100));
    await client.query("commit");
    client.release();
    await expect(attempt).resolves.toBe(false);
    const { rows } = await admin.query("select 1 from guest_link where account_user_id = $1", [
      me.id,
    ]);
    expect(rows).toHaveLength(1);
    await store().begin(me.id, {});
    await setup.deletions.sweep();
    const { rows: gone } = await admin.query('select 1 from "user" where id = any($1)', [
      [me.id, guest.id],
    ]);
    expect(gone).toHaveLength(0);
    expect(JSON.stringify(await liveOf(room.id))).not.toContain(guest.id);
  });

  it("the first step ends the sessions with the marker, and leaves a guest alone", async () => {
    const me = await signedIn();
    const guest = await new Browser().asGuest();
    await admin.query(
      `insert into connector_token (user_id, connector, sealed_token)
       values ($1, 'jira', 'v1.key.iv.sealed')`,
      [me.id],
    );
    await store().begin(me.id, {});
    await store().begin(guest.id, {});
    const { rows: tokens } = await admin.query("select 1 from connector_token where user_id = $1", [
      me.id,
    ]);
    expect(tokens).toHaveLength(0);
    const { rows: sessions } = await admin.query(
      "select user_id from session where user_id = any($1)",
      [[me.id, guest.id]],
    );
    expect(sessions).toEqual([{ user_id: guest.id }]);
    const { rows: markers } = await admin.query(
      "select user_id from account_deletion where user_id = any($1)",
      [[me.id, guest.id]],
    );
    expect(markers).toEqual([{ user_id: me.id }]);
    await setup.deletions.sweep();
  });

  it("a guest moves no further once the account has its marker", async () => {
    const me = await signedIn();
    const guest = await new Browser().asGuest();
    const room = await roomOf(guest.id);
    await admin.query("insert into guest_link (guest_user_id, account_user_id) values ($1, $2)", [
      guest.id,
      me.id,
    ]);
    await store().begin(me.id, {});
    await expect(createGuestLinkStore(setup.database.db).linkOf(guest.id)).resolves.toBeNull();
    const move = vi.spyOn(sync, "moveGuest");
    await expect(setup.links.settle(me.id)).resolves.toBe(true);
    expect(move).not.toHaveBeenCalled();
    move.mockRestore();
    await setup.deletions.sweep();
    expect(await liveOf(room.id)).toBeUndefined();
  });

  it("a move that lands on a deleted account writes nothing", async () => {
    const guest = await new Browser().asGuest();
    const room = await roomOf(guest.id);
    await guest.sit(room.code);
    await expect(sync.moveGuest(room, guest.id, "an-account-now-gone")).resolves.toBe("unchanged");
    expect(JSON.stringify(await liveOf(room.id))).not.toContain("an-account-now-gone");
  });

  it("a keeper who holds a retention exemption keeps it until the deletion deals with the room", async () => {
    const me = await signedIn();
    const other = await new Browser().asGuest();
    const room = await roomOf(me.id);
    await me.sit(room.code);
    await other.sit(room.code);
    await admin.query(
      "update room set last_active_at = now() - interval '400 days' where id = $1",
      [room.id],
    );
    const failing = vi.spyOn(sync, "removeAccount").mockResolvedValue("failed");
    expect(await (await me.remove()).json()).toEqual({ finished: false });
    await setup.database.retention.purge({ ttlDays: 90 });
    expect(await liveOf(room.id)).toBeDefined();
    failing.mockRestore();
    await setup.deletions.sweep();
    expect((await liveOf(room.id))?.live.keeperId).toBe(other.id);
  });
});
