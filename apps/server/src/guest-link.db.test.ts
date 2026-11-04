/**
 * A guest who signs in keeps everything (#48, ADR-025), over the real thing: Postgres, a real
 * sign-in against the stand-in provider (`fake-oidc.ts`), real sockets and their real frames.
 *
 * What it holds: a guest PO is still PO at the same seat, with the vote on the table and no
 * join form or password prompt; history is the same person; OQ-6; the merge with an account that
 * exists; that an anonymous round stays anonymous, on the frames; what fails how, and that the
 * move finishes; that no sign-in reads a whole table; presence; retention; and that nothing
 * about the account reaches a frame or a log.
 */
import { createRoom, type RoomState } from "@pp/domain";
import type { Snapshot } from "@pp/protocol";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Config } from "./config.ts";
import { DatabaseError } from "./db/errors.ts";
import { createGuestLinkStore, namesPerson } from "./db/guest-links.ts";
import { room } from "./db/schema.ts";
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
import type { GraceTimers } from "./sync/presence.ts";
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
  MICROSOFT_CLIENT_ID: "test-microsoft-client-id",
  MICROSOFT_CLIENT_SECRET: "test-microsoft-secret-do-not-log",
} as const;
const TENANT = "11111111-2222-3333-4444-555555555555";
const GRACE_MS = 200;

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

beforeAll(async () => {
  fake = await startFakeOidc();
  restoreFetch = routeProvidersTo(fake.origin);
  t = await createTestDatabase();
  admin = testClient(t.url);
  config = testConfig({ DATABASE_URL: t.url, TRUST_PROXY: "1", ...KEYS });
  setup = await setupServer(config, logs.logger, undefined, { presenceGraceMs: GRACE_MS });
  sync = setup.deps?.handlers as RoomSync;
  server = createServer(config, { ...setup.deps, logger: logs.logger });
  await server.listen();
  const bound = server.httpServer.address();
  if (!bound || typeof bound === "string") throw new Error("not listening");
  at = `http://localhost:${bound.port}`;
});

afterEach(async () => {
  vi.restoreAllMocks();
  for (const client of open.splice(0)) client.close();
  await admin.query("delete from guest_link");
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
  expect(everything).not.toContain(TENANT);
  for (const code of codes) expect(everything).not.toContain(code);
});

let addresses = 0;

/** A browser's cookie jar over `fetch`, following nothing by itself, at an address of its own. */
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

  post(path: string, body: unknown): Promise<Response> {
    return this.go(path, {
      method: "POST",
      headers: { origin: ORIGIN, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  async session() {
    const response = await this.go("/api/auth/get-session");
    return (await response.json()) as {
      user: { id: string; name: string; email?: string; isAnonymous: boolean | null };
    } | null;
  }

  async guest(): Promise<string> {
    const response = await this.post("/api/auth/sign-in/anonymous", {});
    expect(response.status).toBe(200);
    return (await this.session())?.user.id ?? "";
  }

  /** A socket with this browser's cookie, followed until the test ends. */
  socket(): TestClient {
    const client = socketClient(at, { cookie: this.cookie });
    open.push(client);
    return client;
  }

  /** Enters and, by default, sits down as `name`. */
  async sit(code: string, name?: string): Promise<TestClient> {
    const client = this.socket();
    await expect(client.enter(code)).resolves.toMatchObject({ ok: true });
    if (name !== undefined) await must(client.cmd("join", { name, role: "voter" }));
    return client;
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

interface SignInWay {
  provider?: string;
  returnTo?: string;
}

/** A sign-in up to the provider's answer: the callback's path, for the browser to go to. */
async function atProvider(
  browser: Browser,
  who: FakePerson,
  { provider = "google", returnTo = "/" }: SignInWay = {},
): Promise<string> {
  const started = await browser.post("/api/auth/sign-in/social", { provider, returnTo });
  expect(started.status).toBe(200);
  const { url } = (await started.json()) as { url: string };
  const answer = await fetch(
    `${atFake(url, fake.origin)}&${FAKE_PERSON_PARAM}=${fakePersonParam(who)}`,
    { redirect: "manual" },
  );
  const back = new URL(answer.headers.get("location") ?? "");
  return `${back.pathname}${back.search}`;
}

/** A whole sign-in: where the callback sent the browser. */
async function signIn(browser: Browser, who: FakePerson, way: SignInWay = {}): Promise<string> {
  const response = await browser.go(await atProvider(browser, who, way));
  expect(response.status).toBe(302);
  return response.headers.get("location") ?? "";
}

const codes: string[] = [];

/** A room owned by `ownerId`, whose code the logs must never hold. */
async function roomOf(ownerId: string, settings: Partial<RoomState["settings"]> = {}) {
  const code = roomCode();
  codes.push(code);
  const state = createRoom({ ownerId });
  const stored = await setup.database.store.insertRoom({
    code,
    name: null,
    state: { ...state, settings: { ...state.settings, revealWhenAllVoted: false, ...settings } },
  });
  if (!stored) throw new Error("code taken");
  return stored;
}

const liveOf = async (code: string) => {
  const loaded = await setup.database.store.loadRoom(code);
  if (!loaded) throw new Error("no room");
  return loaded;
};

const rowOf = async (id: string) => {
  const { rows } = await admin.query<{ owner_user_id: string; last_active_at: Date }>(
    "select owner_user_id, last_active_at from room where id = $1",
    [id],
  );
  return rows[0];
};

const userExists = async (id: string) =>
  (await admin.query(`select 1 from "user" where id = $1`, [id])).rows.length === 1;

const pendingLinks = async () => (await admin.query("select * from guest_link")).rows;

const youAre = (snapshot: Snapshot | undefined) =>
  snapshot?.room.participants.find((p) => p.id === snapshot.room.you);

/** Runs a named round to its end, so it has a history row. */
async function playRound(po: TestClient, voters: readonly [TestClient, string][]) {
  await must(po.cmd("startRound", { subject: { kind: "none" } }));
  const number = po.latest()?.room.round?.number;
  for (const [client, card] of voters) {
    await client.waitFor(
      (s) => s.room.round?.number === number && s.room.round?.phase === "voting",
    );
    await must(client.cmd("castVote", { card, round: number }));
  }
  await must(po.cmd("reveal"));
}

const IN_ROOM = (code: string) => ({ returnTo: `/r/${code}` });

describe("a guest who signs in", () => {
  it("is still the PO, in the same seat, with the vote on the table and nobody told", async () => {
    const browser = new Browser();
    const guest = await browser.guest();
    const { id, code } = await roomOf(guest);
    const tab = await browser.sit(code, "Chosen Name");
    await must(tab.cmd("setAvatar", { avatar: "fox" }));
    const other = new Browser();
    await other.guest();
    const ben = await other.sit(code, "Ben");
    await must(tab.cmd("startRound", { subject: { kind: "none" } }));
    await must(tab.cmd("castVote", { card: "5", round: 1 }));
    const seat = (await liveOf(code)).state.participants[guest];
    tab.close();

    expect(await signIn(browser, person(), IN_ROOM(code))).toBe(`${ORIGIN}/r/${code}`);

    const account = (await browser.session())?.user.id ?? "";
    expect(account).not.toBe(guest);
    expect((await browser.session())?.user.isAnonymous).toBe(false);
    const back = await browser.sit(code);
    const snapshot = back.latest();
    expect(snapshot?.room.you).toBe(account);
    expect(snapshot?.room.ownerId).toBe(account);
    expect(youAre(snapshot)).toMatchObject({ name: "Chosen Name", avatar: "fox", isOwner: true });
    expect(snapshot?.room.round?.yourVote).toBe("5");
    expect(snapshot?.room.round?.voted).toEqual([account]);
    const { state } = await liveOf(code);
    expect(state.participants[account]?.joinedAt).toBe(seat?.joinedAt);
    expect(state.participants).not.toHaveProperty(guest);
    expect(state.ownerId).toBe(account);
    expect((await rowOf(id))?.owner_user_id).toBe(account);

    // The PO's powers are there, under the new id.
    await must(back.cmd("reveal"));

    // The other person heard a new snapshot, with no cause that says anything of it.
    const seen = await ben.waitFor((s) => s.room.ownerId === account);
    expect(seen.snapshot.causes).toEqual([]);
    expect(seen.snapshot.room.round?.phase).toBe("voting");

    expect(await userExists(guest)).toBe(false);
    expect(await pendingLinks()).toEqual([]);
  });

  it("enters a room with a password with no prompt, grant or seat alike", async () => {
    const browser = new Browser();
    const guest = await browser.guest();
    const po = new Browser();
    const poId = await po.guest();
    const seated = await roomOf(poId);
    const granted = await roomOf(poId);
    await must(sync.changePassword(seated.code, poId, "hash-a"));
    await must(sync.changePassword(granted.code, poId, "hash-b"));
    const { store } = setup.database;
    expect(await store.grantAccess(seated.id, guest, "hash-a")).toBe(true);
    expect(await store.grantAccess(granted.id, guest, "hash-b")).toBe(true);
    (await browser.sit(seated.code, "Ana")).close();

    await signIn(browser, person(), IN_ROOM(seated.code));
    const account = (await browser.session())?.user.id ?? "";

    expect((await browser.sit(seated.code)).latest()?.room.you).toBe(account);
    await expect(browser.socket().enter(granted.code)).resolves.toMatchObject({ ok: true });
    const { rows } = await admin.query(
      "select room_id, user_id from room_access where user_id = any($1) order by room_id",
      [[guest, account]],
    );
    expect(rows).toEqual(
      [seated.id, granted.id].sort().map((room_id) => ({ room_id, user_id: account })),
    );
  });

  it("moves a grant in the commit that moves the seat, so a kick cannot miss it", async () => {
    const browser = new Browser();
    const guest = await browser.guest();
    const signed = new Browser();
    await signIn(signed, person());
    const account = (await signed.session())?.user.id ?? "";
    const po = await new Browser().guest();
    const { id, code } = await roomOf(po);
    await must(sync.changePassword(code, po, "hash-d"));
    expect(await setup.database.store.grantAccess(id, guest, "hash-d")).toBe(true);
    (await browser.sit(code, "Ana")).close();
    await expect(sync.moveGuest({ id, code }, guest, account)).resolves.toBe("changed");
    const { rows } = await admin.query("select user_id from room_access where room_id = $1", [id]);
    expect(rows).toContainEqual({ user_id: account });
    expect(rows).not.toContainEqual({ user_id: guest });
  });

  it("does not need a password in a room the guest owns but left", async () => {
    const browser = new Browser();
    const guest = await browser.guest();
    const { id, code } = await roomOf(guest);
    await must(sync.changePassword(code, guest, "hash-c"));
    await signIn(browser, person());
    const account = (await browser.session())?.user.id ?? "";
    await expect(browser.socket().enter(code)).resolves.toMatchObject({ ok: true });
    expect((await rowOf(id))?.owner_user_id).toBe(account);
  });

  it("is one person in history, before and after, and an anonymous round names nobody", async () => {
    const browser = new Browser();
    const guest = await browser.guest();
    const { id, code } = await roomOf(guest);
    const tab = await browser.sit(code, "Chosen Name");
    const other = new Browser();
    const benId = await other.guest();
    const ben = await other.sit(code, "Ben");
    await playRound(tab, [
      [tab, "5"],
      [ben, "8"],
    ]);
    await must(tab.cmd("updateSettings", { patch: { revealNames: false } }));
    await playRound(tab, [
      [tab, "3"],
      [ben, "13"],
    ]);
    await must(tab.cmd("startRound", { subject: { kind: "none" } }));
    await tab.waitFor((s) => s.room.round?.number === 3);
    const before = await tab.history();
    const anonymous = await admin.query<{ votes: unknown }>(
      "select votes from round_history where room_id = $1 and number = 2",
      [id],
    );
    tab.close();

    await signIn(browser, person(), IN_ROOM(code));

    const account = (await browser.session())?.user.id ?? "";
    const after = await (await browser.sit(code)).history();
    expect(after).toEqual(before);
    const { rows } = await admin.query<{ number: number; votes: unknown }>(
      "select number, votes from round_history where room_id = $1 order by number",
      [id],
    );
    expect(rows[0]?.votes).toEqual({
      kind: "named",
      votes: [
        { who: account, name: "Chosen Name", card: "5" },
        { who: benId, name: "Ben", card: "8" },
      ],
    });
    // Not one byte of an anonymous round moved: there is nobody in it to move.
    expect(rows[1]?.votes).toEqual(anonymous.rows[0]?.votes);
    expect(JSON.stringify(rows[1])).not.toContain(account);
    expect(await userExists(guest)).toBe(false);
  });

  it("takes the named rounds of a room the guest left, seat or no seat", async () => {
    const po = new Browser();
    const poId = await po.guest();
    const { id, code } = await roomOf(poId);
    const poTab = await po.sit(code, "Pia");
    const browser = new Browser();
    const guest = await browser.guest();
    const tab = await browser.sit(code, "Gone Guest");
    await playRound(poTab, [[tab, "5"]]);
    await must(tab.cmd("leave"));
    await poTab.waitFor((s) => s.room.participants.length === 1);
    const onTable = (await liveOf(code)).state.round?.votes[guest];
    expect(onTable).toEqual({ card: "5", name: "Gone Guest" });
    tab.close();

    await signIn(browser, person());

    const account = (await browser.session())?.user.id ?? "";
    const { state } = await liveOf(code);
    // The card on the table, kept by the name it had: the next round's row names the account.
    expect(state.round?.votes[account]).toEqual(onTable);
    expect(state.round?.votes).not.toHaveProperty(guest);
    await must(poTab.cmd("startRound", { subject: { kind: "none" } }));
    await poTab.waitFor((s) => s.room.round?.number === 2);
    const { rows } = await admin.query("select votes from round_history where room_id = $1", [id]);
    expect(rows[0]?.votes).toEqual({
      kind: "named",
      votes: [{ who: account, name: "Gone Guest", card: "5" }],
    });
  });

  it("gives the account the guest's avatar and name when it has none", async () => {
    const browser = new Browser();
    const guest = await browser.guest();
    await browser.post("/api/me/name", { name: "Typed Name" });
    await browser.post("/api/me/avatar", { avatar: "owl" });
    await signIn(browser, person({ name: "\u0007" }));
    const session = await browser.session();
    expect(session?.user.name).toBe("Typed Name");
    expect(session?.user).toMatchObject({ avatar: "owl" });
    expect(await userExists(guest)).toBe(false);
  });

  it("does not rename the account with the guest's name, or take its avatar", async () => {
    const who = person({ name: "Kept Name" });
    const first = new Browser();
    await signIn(first, who);
    await first.post("/api/me/avatar", { avatar: "fox" });
    const browser = new Browser();
    await browser.guest();
    await browser.post("/api/me/name", { name: "Typed Name" });
    await browser.post("/api/me/avatar", { avatar: "owl" });
    await signIn(browser, who);
    expect((await browser.session())?.user).toMatchObject({ name: "Kept Name", avatar: "fox" });
  });
});

describe("OQ-6: `email_verified` at Microsoft", () => {
  it.each([
    ["true", true],
    ["false", false],
    ["absent", undefined],
  ])("links a guest whatever the claim says: %s", async (_, emailVerified) => {
    const browser = new Browser();
    const guest = await browser.guest();
    const { code } = await roomOf(guest);
    (await browser.sit(code, "Mia")).close();
    const location = await signIn(browser, person({ emailVerified }), {
      provider: "microsoft",
      ...IN_ROOM(code),
    });
    expect(location).toBe(`${ORIGIN}/r/${code}`);
    const account = (await browser.session())?.user.id ?? "";
    expect(account).not.toBe(guest);
    const { state } = await liveOf(code);
    expect(state.ownerId).toBe(account);
    expect(state.participants[account]?.name).toBe("Mia");
    expect(await userExists(guest)).toBe(false);
  });
});

describe("an account that exists", () => {
  /** A person signed in on one browser; the same person's guest on another. */
  async function twoBrowsers() {
    const who = person();
    const signed = new Browser();
    await signIn(signed, who);
    const account = (await signed.session())?.user.id ?? "";
    const browser = new Browser();
    const guest = await browser.guest();
    return { who, signed, account, browser, guest };
  }

  it("joins every guest room, and both in one room leave the account's seat", async () => {
    const { who, signed, account, browser, guest } = await twoBrowsers();
    const po = new Browser();
    const poId = await po.guest();
    const shared = await roomOf(poId);
    const own = await roomOf(guest);
    const poTab = await po.sit(shared.code, "Pia");
    const onSecond = await signed.sit(shared.code, "Name On Account");
    const onFirst = await browser.sit(shared.code, "Name As Guest");
    (await browser.sit(own.code, "Owner Guest")).close();
    await must(poTab.cmd("startRound", { subject: { kind: "none" } }));
    await must(onFirst.cmd("castVote", { card: "5", round: 1 }));
    await onSecond.waitFor((s) => s.room.round?.number === 1);
    await must(onSecond.cmd("castVote", { card: "8", round: 1 }));
    onFirst.close();
    const from = poTab.received.length;

    await signIn(browser, who, IN_ROOM(shared.code));

    expect((await browser.session())?.user.id).toBe(account);
    const { state } = await liveOf(shared.code);
    expect(Object.keys(state.participants).sort()).toEqual([poId, account].sort());
    expect(state.participants[account]?.name).toBe("Name On Account");
    expect(state.round?.votes[account]?.card).toBe("8");
    expect((await liveOf(own.code)).state.ownerId).toBe(account);
    expect(await userExists(guest)).toBe(false);
    const gone = (s: Snapshot) => s.room.participants.length === 2;
    const seen = await poTab.waitFor(gone, 2000, from);
    expect(seen.snapshot.room.round?.phase).toBe("voting");
  });

  it("keeps an anonymous round anonymous, on the frames, through a merge", async () => {
    const { who, signed, account, browser, guest } = await twoBrowsers();
    const po = new Browser();
    const poId = await po.guest();
    const { code } = await roomOf(poId, { revealNames: false });
    const poTab = await po.sit(code, "Pia");
    const second = await signed.sit(code, "Two");
    const first = await browser.sit(code, "One");
    await must(poTab.cmd("startRound", { subject: { kind: "none" } }));
    for (const [client, card] of [
      [first, "5"],
      [second, "8"],
      [poTab, "3"],
    ] as const) {
      await client.waitFor((s) => s.room.round?.number === 1);
      await must(client.cmd("castVote", { card, round: 1 }));
    }
    await must(poTab.cmd("reveal"));
    const shown = (await poTab.waitFor((s) => s.room.round?.phase === "revealed")).snapshot;
    const cards = shown.room.round;
    if (cards?.phase !== "revealed" || !cards.anonymous) throw new Error("not anonymous");
    expect(cards.cards).toEqual(["3", "5", "8"]);
    const framesBefore = poTab.frames.length;
    first.close();
    const from = poTab.received.length;

    await signIn(browser, who, IN_ROOM(code));

    const seen = await poTab.waitFor(
      (s) => !s.room.participants.some((p) => p.id === guest),
      2000,
      from,
    );
    const round = seen.snapshot.room.round;
    if (round?.phase !== "revealed" || !round.anonymous) throw new Error("not anonymous");
    // The same cards, or the card that left with the seat would say whose it was.
    expect(round.cards).toEqual(["3", "5", "8"]);
    const frames = poTab.frames.slice(framesBefore);
    expect(frames.length).toBeGreaterThan(0);
    for (const snapshot of snapshotsIn(frames)) {
      expect(snapshot.room.round).not.toHaveProperty("votes");
      expect(JSON.stringify(snapshot.room.participants)).not.toMatch(/"card"/);
    }
    expect(account).toBeTruthy();
    const { state } = await liveOf(code);
    expect(Object.keys(state.participants).sort()).toEqual([poId, account].sort());
  });

  it("moves history too: a round both played stays a record, and is one person's", async () => {
    const { who, signed, account, browser, guest } = await twoBrowsers();
    const { id, code } = await roomOf(guest);
    const first = await browser.sit(code, "One");
    const second = await signed.sit(code, "Two");
    await playRound(first, [
      [first, "5"],
      [second, "8"],
    ]);
    await must(first.cmd("startRound", { subject: { kind: "none" } }));
    await first.waitFor((s) => s.room.round?.number === 2);
    first.close();

    await signIn(browser, who);

    const { rows } = await admin.query<{ votes: { votes: { who: string; card: string }[] } }>(
      "select votes from round_history where room_id = $1",
      [id],
    );
    expect(rows[0]?.votes.votes.map((vote) => [vote.who, vote.card])).toEqual([
      [account, "5"],
      [account, "8"],
    ]);
  });
});

describe("what fails how", () => {
  it("ends the sign-in when the link cannot be written: the guest stays, whole", async () => {
    const browser = new Browser();
    const guest = await browser.guest();
    const { code } = await roomOf(guest);
    (await browser.sit(code, "Ana")).close();
    vi.spyOn(setup.links, "link").mockRejectedValueOnce(new DatabaseError("begin", "57P01"));
    const who = person();

    const location = await signIn(browser, who, IN_ROOM(code));

    expect(new URL(location).searchParams.get("sign_in_error")).toBe("failed");
    expect((await browser.session())?.user.id).toBe(guest);
    expect((await liveOf(code)).state.ownerId).toBe(guest);
    await expect(browser.socket().enter(code)).resolves.toMatchObject({ ok: true });

    // Trying again finds the account the first try made, and moves everything.
    expect(await signIn(browser, who, IN_ROOM(code))).toBe(`${ORIGIN}/r/${code}`);
    const account = (await browser.session())?.user.id ?? "";
    expect((await liveOf(code)).state.participants[account]?.name).toBe("Ana");
  });

  it("keeps what moved, stays signed in, and finishes at the next visit", async () => {
    const browser = new Browser();
    const guest = await browser.guest();
    const rooms = [await roomOf(guest), await roomOf(guest), await roomOf(guest)];
    for (const { code } of rooms) (await browser.sit(code, "Ana")).close();
    const { store } = setup.database;
    const stuck = rooms[1]?.id;
    const commit = store.commitRoom.bind(store);
    vi.spyOn(store, "commitRoom").mockImplementation(async (id, ...rest) => {
      if (id === stuck) throw new DatabaseError("commit room", "57P01");
      return commit(id, ...rest);
    });

    const location = await signIn(browser, person());

    expect(new URL(location).searchParams.get("sign_in_error")).toBe("still_moving");
    const account = (await browser.session())?.user.id ?? "";
    expect((await browser.session())?.user.isAnonymous).toBe(false);
    expect((await pendingLinks()).length).toBe(1);
    expect(await userExists(guest)).toBe(true);
    const owners = await Promise.all(rooms.map(async ({ id }) => (await rowOf(id))?.owner_user_id));
    expect(owners).toEqual([account, guest, account]);

    // No purge reaches the guest or the room the move has yet to reach.
    const far = new Date(Date.now() + 3650 * 24 * 60 * 60 * 1000);
    await setup.database.retention.purge({ ttlDays: 1, now: far, occupied: [rooms[0]?.id ?? ""] });
    expect(await userExists(guest)).toBe(true);
    expect(await rowOf(rooms[1]?.id ?? "")).toBeDefined();

    vi.restoreAllMocks();
    const client = browser.socket();
    await expect(client.enter(rooms[1]?.code ?? "")).resolves.toMatchObject({ ok: true });
    expect(client.latest()?.room.you).toBe(account);
    expect(await userExists(guest)).toBe(false);
    expect(await pendingLinks()).toEqual([]);
  });

  it("leaves a guest on its way alone, whatever the purge makes of it", async () => {
    const seatedOnly = new Browser();
    const guest = await seatedOnly.guest();
    const signed = new Browser();
    await signIn(signed, person());
    const account = (await signed.session())?.user.id ?? "";
    // Owns no room, and `begin` ended its sessions: by every other rule the purge would take it.
    await createGuestLinkStore(setup.database.db).begin(guest, account);
    const far = new Date(Date.now() + 3650 * 24 * 60 * 60 * 1000);
    await setup.database.retention.purge({ ttlDays: 1, now: far });
    expect(await userExists(guest)).toBe(true);
    await admin.query("delete from guest_link");
    await setup.database.retention.purge({ ttlDays: 1, now: far });
    expect(await userExists(guest)).toBe(false);
  });

  it("finishes a move whose process died, from the row it left", async () => {
    const browser = new Browser();
    const guest = await browser.guest();
    const { code } = await roomOf(guest);
    (await browser.sit(code, "Ana")).close();
    const signed = new Browser();
    await signIn(signed, person());
    const account = (await signed.session())?.user.id ?? "";

    await createGuestLinkStore(setup.database.db).begin(guest, account);
    expect((await browser.session())?.user).toBeUndefined();

    await setup.retention.runNow();
    expect((await liveOf(code)).state.ownerId).toBe(account);
    expect(await userExists(guest)).toBe(false);
    expect(await pendingLinks()).toEqual([]);
  });

  it("moves a guest to the first account it signed in to, when a second try comes", async () => {
    const store = createGuestLinkStore(setup.database.db);
    const guest = await new Browser().guest();
    const [one, two] = [new Browser(), new Browser()];
    await signIn(one, person());
    await signIn(two, person());
    const first = (await one.session())?.user.id ?? "";
    await store.begin(guest, first);
    await store.begin(guest, (await two.session())?.user.id ?? "");
    await expect(store.linkOf(guest)).resolves.toMatchObject({ account: first });
  });

  it("gives the rooms to the first of two sign-ins of one guest, and leaves both usable", async () => {
    const first = new Browser();
    const guest = await first.guest();
    const { code } = await roomOf(guest);
    (await first.sit(code, "Ana")).close();
    // One guest's cookie in two browsers, both at the provider.
    const second = new Browser();
    for (const [name, value] of first.jar) second.jar.set(name, value);
    const [one, two] = [person(), person()];
    const [callbackOne, callbackTwo] = [
      await atProvider(first, one, IN_ROOM(code)),
      await atProvider(second, two, IN_ROOM(code)),
    ];

    await first.go(callbackOne);
    const winner = (await first.session())?.user.id ?? "";
    expect((await liveOf(code)).state.ownerId).toBe(winner);
    expect(await userExists(guest)).toBe(false);

    // The second finds no session of the guest: nothing moves, and that browser ends signed out.
    const response = await second.go(callbackTwo);
    expect(response.headers.get("location")).toBe(`${ORIGIN}/r/${code}`);
    expect(await second.session()).toBeNull();
    expect((await liveOf(code)).state.ownerId).toBe(winner);
    expect(await pendingLinks()).toEqual([]);

    // Its account was made and works. As a new guest it signs in, and it has no way into a room
    // that is the first account's.
    await second.guest();
    await signIn(second, two);
    expect((await second.session())?.user).toMatchObject({ isAnonymous: false });
    expect((await second.session())?.user.id).not.toBe(winner);
    expect((await first.session())?.user.id).toBe(winner);
    expect((await liveOf(code)).state.ownerId).toBe(winner);
  });

  it("moves to one account when two sign-ins of one guest land together", async () => {
    const first = new Browser();
    const guest = await first.guest();
    const { code } = await roomOf(guest);
    (await first.sit(code, "Ana")).close();
    const second = new Browser();
    for (const [name, value] of first.jar) second.jar.set(name, value);
    const [callbackOne, callbackTwo] = [
      await atProvider(first, person(), IN_ROOM(code)),
      await atProvider(second, person(), IN_ROOM(code)),
    ];

    await Promise.all([first.go(callbackOne), second.go(callbackTwo)]);

    await vi.waitFor(async () => expect(await userExists(guest)).toBe(false));
    const { state } = await liveOf(code);
    expect(Object.keys(state.participants)).toEqual([state.ownerId]);
    expect(state.ownerId).not.toBe(guest);
  });

  it("does not copy a grant a new password in progress dropped", async () => {
    const browser = new Browser();
    const guest = await browser.guest();
    const signed = new Browser();
    await signIn(signed, person());
    const account = (await signed.session())?.user.id ?? "";
    const po = await new Browser().guest();
    const [changing, steady] = [await roomOf(po), await roomOf(po)];
    await must(sync.changePassword(changing.code, po, "hash-old"));
    await must(sync.changePassword(steady.code, po, "hash-steady"));
    const { store } = setup.database;
    expect(await store.grantAccess(changing.id, guest, "hash-old")).toBe(true);
    expect(await store.grantAccess(steady.id, guest, "hash-steady")).toBe(true);

    // What a new password's commit does, held open with the guest's grant gone.
    const change = await admin.connect();
    await change.query("begin");
    await change.query("update room set password_hash = 'hash-new' where id = $1", [changing.id]);
    await change.query("delete from room_access where room_id = $1", [changing.id]);
    const done = createGuestLinkStore(setup.database.db).complete(guest, account);
    await vi.waitFor(async () => {
      const { rows } = await admin.query(
        `select 1 from pg_stat_activity
         where datname = current_database() and wait_event_type = 'Lock'`,
      );
      expect(rows.length).toBeGreaterThan(0);
    });
    await change.query("commit");
    change.release();
    await done;

    const { rows } = await admin.query("select room_id from room_access where user_id = $1", [
      account,
    ]);
    expect(rows).toEqual([{ room_id: steady.id }]);
  });

  it("names a room it cannot move by its id, and stays until someone looks", async () => {
    const browser = new Browser();
    const guest = await browser.guest();
    const { id, code } = await roomOf(guest);
    await admin.query(`update room set live = '{"broken": "state"}' where id = $1`, [id]);
    const from = logs.lines.length;

    const location = await signIn(browser, person());

    expect(new URL(location).searchParams.get("sign_in_error")).toBe("still_moving");
    const lines = () => logs.lines.slice(from);
    expect(lines()).toContainEqual(
      expect.objectContaining({
        level: 40,
        room: id,
        class: "TypeError",
        msg: "guest link: a room did not move",
      }),
    );

    await admin.query("update guest_link set created_at = now() - interval '2 days'");
    const before = logs.lines.length;
    await setup.links.sweep();
    expect(logs.lines.slice(before)).toContainEqual(
      expect.objectContaining({ level: 50, room: id, class: "TypeError" }),
    );
    expect(await userExists(guest)).toBe(true);
    expect(JSON.stringify(lines())).not.toContain(code);
    expect(JSON.stringify(lines())).not.toContain("broken");

    // What an operator does: a room nobody could open goes, and the move finishes.
    await admin.query("delete from room where id = $1", [id]);
    await setup.links.sweep();
    expect(await userExists(guest)).toBe(false);
  });

  it("moves nothing for a callback the browser did not start", async () => {
    const victim = new Browser();
    const guest = await victim.guest();
    const { code } = await roomOf(guest);
    (await victim.sit(code, "Ana")).close();
    const attacker = new Browser();
    await attacker.guest();
    const started = await attacker.post("/api/auth/sign-in/social", {
      provider: "google",
      returnTo: "/",
    });
    const { url } = (await started.json()) as { url: string };
    const answer = await fetch(
      `${atFake(url, fake.origin)}&${FAKE_PERSON_PARAM}=${fakePersonParam(person())}`,
      { redirect: "manual" },
    );
    const back = new URL(answer.headers.get("location") ?? "");
    const response = await victim.go(`${back.pathname}${back.search}`);
    expect(response.headers.get("location")).toContain("sign_in_error=failed");
    expect((await victim.session())?.user.id).toBe(guest);
    expect((await liveOf(code)).state.ownerId).toBe(guest);
    expect(await pendingLinks()).toEqual([]);
  });

  it("is a no-op run again: same version, same rows", async () => {
    const browser = new Browser();
    const guest = await browser.guest();
    const { id, code } = await roomOf(guest);
    (await browser.sit(code, "Ana")).close();
    await signIn(browser, person());
    const account = (await browser.session())?.user.id ?? "";
    const { version } = await liveOf(code);
    await expect(sync.moveGuest({ id, code }, guest, account)).resolves.toBe("unchanged");
    await createGuestLinkStore(setup.database.db).complete(guest, account);
    expect((await liveOf(code)).version).toBe(version);
  });

  it("gives no link for an id that is no guest, and ends no account's sessions", async () => {
    const [one, two] = [new Browser(), new Browser()];
    await signIn(one, person());
    await signIn(two, person());
    const [first, second] = [
      (await one.session())?.user.id ?? "",
      (await two.session())?.user.id ?? "",
    ];
    await createGuestLinkStore(setup.database.db).begin(first, second);
    expect(await pendingLinks()).toEqual([]);
    expect((await one.session())?.user.id).toBe(first);
    const { rows } = await admin.query("select 1 from session where user_id = $1", [first]);
    expect(rows).toHaveLength(1);
  });
});

describe("a sign-in that dies half way", () => {
  it("leaves no user without an account: the next try signs in", async () => {
    await admin.query(`
      create function fail_account() returns trigger language plpgsql as $$
      begin raise exception 'the process died here'; end $$`);
    await admin.query(`
      create trigger fail_account before insert on account
      for each row execute function fail_account()`);
    const who = person({ email: `half-way-${people}@example.com` });
    const browser = new Browser();
    const guest = await browser.guest();
    const { rows: before } = await admin.query(`select count(*)::int as n from "user"`);
    try {
      const location = await signIn(browser, who, { provider: "microsoft" });
      expect(new URL(location).searchParams.get("sign_in_error")).toBe("failed");
    } finally {
      await admin.query("drop trigger fail_account on account");
      await admin.query("drop function fail_account");
    }
    const { rows: after } = await admin.query(`select count(*)::int as n from "user"`);
    expect(after).toEqual(before);
    expect((await browser.session())?.user.id).toBe(guest);

    expect(await signIn(browser, who, { provider: "microsoft" })).toBe(`${ORIGIN}/`);
    expect((await browser.session())?.user).toMatchObject({ isAnonymous: false });
    expect(await userExists(guest)).toBe(false);
  });
});

describe("the lookup", () => {
  it("reads indexes only, however many rooms and rounds the instance holds", async () => {
    const seats = `(select jsonb_object_agg('person' || n || '-' || s,
      jsonb_build_object('name', 'Person Name', 'role', 'voter', 'joinedAt', 1, 'connected', false))
      from generate_series(1, 8) s)`;
    const votes = `(select jsonb_object_agg('voter' || n || '-' || s, jsonb_build_object('card', '5'))
      from generate_series(1, 4) s)`;
    await admin.query(`
      insert into room (code, owner_user_id, live, version)
      select 'bulk' || n, 'owner' || n,
        jsonb_build_object(
          'ownerId', 'owner' || n,
          'participants', ${seats},
          'round', case when n % 2 = 0 then 'null'::jsonb
            else jsonb_build_object('votes', ${votes}) end)
          || case when n % 100 = 0
            then jsonb_build_object('removed', jsonb_build_object('gone' || n, 1))
            else '{}'::jsonb end,
        1
      from generate_series(1, 20000) n`);
    await admin.query(`
      insert into round_history
        (room_id, number, subject, deck, votes, stats, started_at, revealed_at, finished_at)
      select r.id, 1, '{}', '{}',
        jsonb_build_object('kind', 'named', 'votes', (
          select jsonb_agg(jsonb_build_object('who', r.owner_user_id || '-' || s,
            'name', 'Person Name', 'card', '5'))
          from generate_series(1, 8) s)),
        jsonb_build_object('distribution', (
          select jsonb_agg(jsonb_build_object('card', s::text, 'count', 1))
          from generate_series(1, 8) s)),
        now(), now(), now()
      from room r where r.code like 'bulk%'`);
    // VACUUM, not ANALYZE alone: rows a GIN index has not merged yet wait in its pending list,
    // which a manual ANALYZE leaves as it is and the planner charges in full to an index scan.
    // How long it is here depends on when autovacuum last emptied it, and a long one made the
    // planner choose a sequential scan (CI, 2026-11-03). VACUUM empties it, then statistics.
    await admin.query("vacuum analyze room");
    await admin.query("vacuum analyze round_history");
    const plan = async (query: string, values: string[]) => {
      const { rows } = await admin.query(`explain ${query}`, values);
      return rows.map((row) => row["QUERY PLAN"]).join("\n");
    };
    const rooms = await plan(
      `select code from room where owner_user_id = $1 or
       ((live -> 'participants') || coalesce(live #> '{round,votes}', '{}'::jsonb)) ? $1`,
      ["person77-3"],
    );
    expect(rooms).toContain("room_people_idx");
    expect(rooms).toContain("room_owner_user_id_idx");
    expect(rooms).not.toContain("Seq Scan");
    // The real predicate, with all four of its arms: a person's rooms are found by the owner,
    // seat, keeper-apart and removal indexes together. Without `room_removed_idx` the OR over
    // the whole predicate cannot use a bitmap and the planner falls back to a sequential scan.
    const real = setup.database.db
      .select({ id: room.id })
      .from(room)
      .where(namesPerson("gone700"))
      .toSQL();
    const everything = await plan(real.sql, real.params as string[]);
    expect(everything).toContain("room_removed_idx");
    expect(everything).toContain("room_keeper_apart_idx");
    expect(everything).toContain("room_people_idx");
    expect(everything).toContain("room_owner_user_id_idx");
    expect(everything).not.toContain("Seq Scan");
    const rounds = await plan("select id from round_history where votes @> $1::jsonb", [
      JSON.stringify({ kind: "named", votes: [{ who: "owner77-3" }] }),
    ]);
    expect(rounds).toContain("round_history_votes_idx");
    expect(rounds).not.toContain("Seq Scan");

    const store = createGuestLinkStore(setup.database.db);
    const codeIn = async (who: string) => (await store.roomsOf(who)).map((found) => found.code);
    await expect(codeIn("person77-3")).resolves.toEqual(["bulk77"]);
    await expect(codeIn("voter77-2")).resolves.toEqual(["bulk77"]);
    await expect(codeIn("gone700")).resolves.toEqual(["bulk700"]);
    await expect(codeIn("owner78")).resolves.toEqual(["bulk78"]);
    await expect(store.roomsOf("nobody")).resolves.toEqual([]);
    await admin.query("delete from room where code like 'bulk%'");
  }, 60_000);
});

describe("live sockets", () => {
  it("tells another tab of the guest, and closes it", async () => {
    const browser = new Browser();
    const guest = await browser.guest();
    const { code } = await roomOf(guest);
    const tab = await browser.sit(code, "Ana");
    const told = new Promise<void>((resolve) => tab.socket.once("signedIn", resolve));
    const closed = new Promise<void>((resolve) => tab.socket.once("disconnect", () => resolve()));

    await signIn(browser, person(), IN_ROOM(code));

    await told;
    await closed;
    // Its snapshots stopped at the guest: it never saw a room without itself.
    expect(tab.latest()?.room.you).toBe(guest);
    const account = (await browser.session())?.user.id ?? "";
    expect((await browser.sit(code)).latest()?.room.you).toBe(account);
  });

  it("refuses the guest's old cookie once it signed in", async () => {
    const browser = new Browser();
    await browser.guest();
    const cookie = browser.cookie;
    await signIn(browser, person());
    const old = socketClient(at, { cookie });
    open.push(old);
    await new Promise<void>((resolve) => old.socket.once("connect_error", () => resolve()));
    expect(old.socket.connected).toBe(false);
  });

  it("lets no grace of the guest touch the account, and the account's own runs", async () => {
    const browser = new Browser();
    const guest = await browser.guest();
    const { id, code } = await roomOf(guest);
    const tab = await browser.sit(code, "Ana");
    const other = new Browser();
    await other.guest();
    const ben = await other.sit(code, "Ben");
    // A grace that outlasts the test: a sign-in may take any time, and nothing here races it.
    const graces = sync.presence as GraceTimers;
    const start = graces.start.bind(graces);
    vi.spyOn(graces, "start").mockImplementation((room, who) => start(room, who, 600_000));
    tab.close();
    await vi.waitFor(() => expect(sync.presence.pending(id, guest)).toBe(true));

    await signIn(browser, person(), IN_ROOM(code));

    const account = (await browser.session())?.user.id ?? "";
    expect(sync.presence.pending(id, guest)).toBe(false);
    expect(sync.presence.pending(id, account)).toBe(true);
    // Back in time: the seat never goes away.
    const back = await browser.sit(code);
    expect(sync.presence.pending(id, account)).toBe(false);
    const { state } = await liveOf(code);
    expect(state.participants[account]).toMatchObject({ connected: true, name: "Ana" });
    expect(state.participants[account]).not.toHaveProperty("awaySince");
    expect(back.socket.connected).toBe(true);
    expect(ben.socket.connected).toBe(true);
  });

  it("lets the guest's timer find nobody, if it fires before the seat moved", async () => {
    const browser = new Browser();
    const guest = await browser.guest();
    const { id, code } = await roomOf(guest);
    const tab = await browser.sit(code, "Ana");
    const other = new Browser();
    await other.guest();
    const ben = await other.sit(code, "Ben");
    const seen = ben.received.length;
    tab.close();
    // The away lands first: the seat moves as it is, away, and no grace of the account runs.
    await ben.waitFor((s) => s.room.participants.some((p) => p.id === guest && p.away), 3000, seen);

    await signIn(browser, person(), IN_ROOM(code));

    const account = (await browser.session())?.user.id ?? "";
    expect(sync.presence.pending(id, guest)).toBe(false);
    expect(sync.presence.pending(id, account)).toBe(false);
    expect((await liveOf(code)).state.participants[account]).toMatchObject({ connected: false });
  });

  it("refuses a join from a socket `dropGuest` missed, so no seat names a user that is gone", async () => {
    const browser = new Browser();
    const guest = await browser.guest();
    const owner = await new Browser().guest();
    const { code } = await roomOf(owner);
    const stale = await browser.sit(code);
    vi.spyOn(sync, "dropGuest").mockImplementation(() => {});

    await signIn(browser, person());

    expect(await userExists(guest)).toBe(false);
    await expect(stale.cmd("join", { name: "Ghost", role: "voter" })).resolves.toEqual({
      ok: false,
      code: "unauthenticated",
    });
    expect((await liveOf(code)).state.participants).toEqual({});
  });

  it("marks a seat away when the person never comes back, and evicts nobody", async () => {
    const browser = new Browser();
    const guest = await browser.guest();
    const { code } = await roomOf(guest);
    const tab = await browser.sit(code, "Ana");
    const other = new Browser();
    await other.guest();
    const ben = await other.sit(code, "Ben");
    tab.close();

    await signIn(browser, person(), IN_ROOM(code));

    const account = (await browser.session())?.user.id ?? "";
    const seen = await ben.waitFor((s) => {
      const seat = s.room.participants.find((p) => p.id === account);
      return seat?.away === true;
    }, 3000);
    expect(seen.snapshot.room.ownerId).toBe(account);
    expect(seen.snapshot.room.participants.map((p) => p.name).sort()).toEqual(["Ana", "Ben"]);
  });
});

describe("a countdown to the next item (#52)", () => {
  /** A guest PO's room with a queue, and a final recorded by `po`: the countdown runs. */
  async function counting(po: TestClient, code: string) {
    await must(po.cmd("updateSettings", { patch: { autoAdvance: true } }));
    await must(po.cmd("queueAdd", { items: [{ key: "PP-1", title: "The next one" }] }));
    await must(po.cmd("startRound", { subject: { kind: "none" } }));
    await must(po.cmd("castVote", { card: "5", round: 1 }));
    await must(po.cmd("reveal"));
    await must(po.cmd("setFinal", { card: "5" }));
    const { state } = await liveOf(code);
    expect(state.round?.advanceAt).toBeDefined();
    return state.round?.advanceAt;
  }

  it("ends when the PO's last socket closes with the sign-in, and starts nothing", async () => {
    const browser = new Browser();
    const guest = await browser.guest();
    const { id, code } = await roomOf(guest);
    const tab = await browser.sit(code, "Ana");
    const other = new Browser();
    await other.guest();
    const ben = await other.sit(code, "Ben");
    await counting(tab, code);

    await signIn(browser, person());

    const account = (await browser.session())?.user.id ?? "";
    const { state } = await vi.waitFor(async () => {
      const loaded = await liveOf(code);
      expect(loaded.state.round).not.toHaveProperty("advanceAt");
      return loaded;
    });
    expect(state.ownerId).toBe(account);
    expect(state.round).toMatchObject({ number: 1, phase: "revealed" });
    expect(sync.deadlines.armed(id)).toBeUndefined();
    const told = await ben.waitFor((s) => s.room.ownerId === account);
    expect(told.snapshot.room.round).not.toHaveProperty("advanceAt");

    // A press of "Next item" brings it back, as after a reload.
    const back = await browser.sit(code);
    await must(back.cmd("startNext", { id: 1 }));
    expect((await liveOf(code)).state.round).toMatchObject({ number: 2, phase: "voting" });
  });

  it("ends after the move too, for a socket of the guest that closed late or never", async () => {
    const browser = new Browser();
    const guest = await browser.guest();
    const { code } = await roomOf(guest);
    const tab = await browser.sit(code, "Ana");
    await counting(tab, code);
    // On another instance the move can land first: this close then finds no PO to end it for.
    vi.spyOn(sync, "dropGuest").mockImplementation(() => {});
    // As long as in production against a countdown: the seat's own grace must not do this.
    const graces = sync.presence as GraceTimers;
    const start = graces.start.bind(graces);
    vi.spyOn(graces, "start").mockImplementation((room, who) => start(room, who, 600_000));

    await signIn(browser, person());

    await vi.waitFor(async () =>
      expect((await liveOf(code)).state.round).not.toHaveProperty("advanceAt"),
    );
    expect((await liveOf(code)).state.round).toMatchObject({ number: 1, phase: "revealed" });
  });

  it("goes on when the account that becomes PO is at the table", async () => {
    const signed = new Browser();
    const who = person();
    await signIn(signed, who);
    const account = (await signed.session())?.user.id ?? "";
    const browser = new Browser();
    const guest = await browser.guest();
    const { id, code } = await roomOf(guest);
    const tab = await browser.sit(code, "Ana");
    const seated = await signed.sit(code, "Same Person");
    const advanceAt = await counting(tab, code);

    await signIn(browser, who);

    const { state } = await liveOf(code);
    expect(state.ownerId).toBe(account);
    expect(state.round?.advanceAt).toBe(advanceAt);
    expect(sync.deadlines.armed(id)).toBe(advanceAt);
    // Nothing ended it after the move either.
    await must(seated.cmd("rename", { name: "Still Here" }));
    expect((await liveOf(code)).state.round?.advanceAt).toBe(advanceAt);
  });

  it("writes the round a move ended, and its activity, when it lands as a countdown runs out", async () => {
    const browser = new Browser();
    const guest = await browser.guest();
    const { id, code } = await roomOf(guest);
    const tab = await browser.sit(code, "Ana");
    await counting(tab, code);
    tab.close();
    await vi.waitFor(async () =>
      expect((await liveOf(code)).state.round).not.toHaveProperty("advanceAt"),
    );
    // As the state stands with nobody here to end it: the deadline passed, unresolved.
    const { state, version } = await liveOf(code);
    const past = Date.now() - 1000;
    const round = { ...state.round, advanceAt: past };
    const live = { ...state, round };
    await admin.query(`update room set live = $1, version = $2 + 1 where id = $3`, [
      JSON.stringify(Object.fromEntries(Object.entries(live).filter(([key]) => key !== "queue"))),
      version,
      id,
    ]);
    await admin.query(`update room set last_active_at = now() - interval '3 days' where id = $1`, [
      id,
    ]);
    await admin.query("delete from round_history where room_id = $1", [id]);
    const idle = (await rowOf(id))?.last_active_at.getTime() ?? 0;

    await signIn(browser, person());

    const account = (await browser.session())?.user.id ?? "";
    const after = (await liveOf(code)).state;
    expect(after.ownerId).toBe(account);
    expect(after.round).toMatchObject({ number: 2, phase: "voting" });
    expect(after.queue?.items).toEqual([]);
    expect((await rowOf(id))?.last_active_at.getTime()).toBeGreaterThan(idle);
    const { rows } = await admin.query<{ votes: { votes: { who: string }[] } }>(
      "select votes from round_history where room_id = $1",
      [id],
    );
    expect(rows.map((row) => row.votes.votes.map((vote) => vote.who))).toEqual([[account]]);
  });
});

describe("retention", () => {
  it("does not touch `last_active_at`, and the room is a signed-in owner's from then on", async () => {
    const browser = new Browser();
    const guest = await browser.guest();
    const { id, code } = await roomOf(guest);
    (await browser.sit(code, "Ana")).close();
    await admin.query(
      `update room set last_active_at = now() - interval '200 days' where id = $1`,
      [id],
    );
    const before = (await rowOf(id))?.last_active_at;

    await signIn(browser, person());

    expect((await rowOf(id))?.last_active_at).toEqual(before);
    expect((await liveOf(code)).state.ownerId).toBe((await browser.session())?.user.id);
    await setup.database.retention.purge({ ttlDays: 90, now: new Date() });
    expect(await rowOf(id)).toBeDefined();
  });

  it("still purges an idle room whose guest owner is on no way to an account", async () => {
    const guest = await new Browser().guest();
    const { id } = await roomOf(guest);
    await admin.query(
      `update room set last_active_at = now() - interval '200 days' where id = $1`,
      [id],
    );
    await setup.database.retention.purge({ ttlDays: 90, now: new Date() });
    expect(await rowOf(id)).toBeUndefined();
  });
});

describe("privacy", () => {
  it("puts nothing about the account in a frame, a snapshot or the history", async () => {
    const who = person({ email: "private.person@example.com", name: "Provider Private" });
    const browser = new Browser();
    const guest = await browser.guest();
    const { code } = await roomOf(guest);
    const tab = await browser.sit(code, "Ana");
    const other = new Browser();
    await other.guest();
    const ben = await other.sit(code, "Ben");
    await playRound(tab, [[tab, "5"]]);
    await must(tab.cmd("startRound", { subject: { kind: "none" } }));
    await tab.waitFor((s) => s.room.round?.number === 2);
    tab.close();

    await signIn(browser, who, { provider: "microsoft", ...IN_ROOM(code) });

    const back = await browser.sit(code);
    await back.history();
    const account = (await browser.session())?.user.id ?? "";
    await ben.waitFor((s) => s.room.ownerId === account);
    const heard = [...ben.frames, ...back.frames].join("\n");
    for (const secret of ["private.person", "Provider Private", TENANT, "microsoft", "@"]) {
      expect(heard).not.toContain(secret);
    }
    const { rows } = await admin.query("select live from room where code = $1", [code]);
    expect(JSON.stringify(rows[0])).not.toContain("private.person");
    expect((await browser.session())?.user.email).toBe("private.person@example.com");
  });
});
