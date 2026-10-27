/**
 * Presence races against Postgres (#17, review of PR #79), with the real runner and
 * session middleware around a store and a runner the tests can slow down or break:
 *
 * - an enter whose load read the room before an away run committed, and answers after
 *   it, still brings the person back (the back step runs in the room's queue);
 * - an away run that fails starts the grace again, at most `MAX_AWAY_RETRIES` times.
 */
import { apply, type Command, createRoom, type RoomState } from "@pp/domain";
import type { Snapshot } from "@pp/protocol";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { sessionChecker } from "../auth.ts";
import { DatabaseError } from "../db/errors.ts";
import type { CommandRunner } from "../db/runner.ts";
import { createTestDatabase, type TestDatabase } from "../db/test-db.ts";
import { createServer, type PokerServer } from "../server.ts";
import { setupServer } from "../setup.ts";
import { collectLogs, testConfig, VALID_ENV } from "../test-support.ts";
import { createRoomSync, MAX_AWAY_RETRIES, type RoomSync } from "./room-sync.ts";
import {
  type Guest,
  roomCode,
  signInGuest,
  snapshotsIn,
  type TestClient,
  testClient,
} from "./test-support.ts";

const ORIGIN = VALID_ENV.BASE_URL;
const GRACE_MS = 300;
const logs = collectLogs("debug");
const NAMES = { ada: "Adelheidqz", bob: "Bobrikowsk", cy: "Cyrillavex" } as const;

let t: TestDatabase;
let setup: Awaited<ReturnType<typeof setupServer>>;
let server: PokerServer;
let sync: RoomSync;
let base: string;
const clients: TestClient[] = [];
let ada: Guest;
let bob: Guest;
let cy: Guest;

/** When set, the next `loadRoom` of the sync reads at once and answers once released. */
let holdNextLoad: { release: Promise<void>; read: () => void } | null = null;
/** How the next runs of the sync fail, one entry per run; empty, they run. */
const failRuns: Array<"conflict" | "database"> = [];
let runs = 0;

beforeAll(async () => {
  t = await createTestDatabase();
  const config = testConfig({ DATABASE_URL: t.url });
  setup = await setupServer(config, logs.logger, undefined, { presenceGraceMs: GRACE_MS });
  const { runner, store, db } = setup.database;
  const slowStore = {
    loadRoom: async (code: string) => {
      const hold = holdNextLoad;
      holdNextLoad = null;
      const loaded = await store.loadRoom(code);
      if (hold) {
        hold.read();
        await hold.release;
      }
      return loaded;
    },
  };
  const brokenRunner: CommandRunner = {
    ...runner,
    run: (code, step) => {
      runs += 1;
      const failure = failRuns.shift();
      if (failure === "conflict") return Promise.resolve({ ok: false, error: "conflict" });
      if (failure === "database") return Promise.reject(new DatabaseError("commit", "57P01"));
      return runner.run(code, step);
    },
  };
  sync = createRoomSync({
    runner: brokenRunner,
    store: slowStore,
    logger: logs.logger,
    sessionAlive: sessionChecker(db),
    presenceGraceMs: GRACE_MS,
  });
  server = createServer(config, { ...setup.deps, handlers: sync, logger: logs.logger });
  const { port } = await server.listen();
  base = `http://localhost:${port}`;
  [ada, bob, cy] = await Promise.all([
    signInGuest(base, ORIGIN),
    signInGuest(base, ORIGIN),
    signInGuest(base, ORIGIN),
  ]);
});

afterEach(() => {
  for (const client of clients.splice(0)) client.close();
  failRuns.length = 0;
  holdNextLoad = null;
});

afterAll(async () => {
  await server?.close();
  sync?.close();
  await setup?.dispose?.();
  await t?.drop();
});

function client(guest: Guest): TestClient {
  const c = testClient(base, { cookie: guest.cookie });
  clients.push(c);
  return c;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function step(state: RoomState, actor: string, command: Command): RoomState {
  const result = apply(state, command, { actor, now: Date.now() });
  if (!result.ok) throw new Error(`fixture refused: ${result.error}`);
  return result.state;
}

/** Ada (PO) and Bob vote, Cy observes; the lobby. */
function room(): RoomState {
  let s = createRoom({ ownerId: ada.id });
  s = step(s, ada.id, { type: "join", name: NAMES.ada, role: "voter" });
  s = step(s, bob.id, { type: "join", name: NAMES.bob, role: "voter" });
  return step(s, cy.id, { type: "join", name: NAMES.cy, role: "observer" });
}

async function insert(state: RoomState): Promise<string> {
  const code = roomCode();
  const stored = await setup.database.store.insertRoom({ code, name: null, state });
  if (!stored) throw new Error("code taken");
  return code;
}

async function stored(code: string) {
  const loaded = await setup.database.store.loadRoom(code);
  if (!loaded) throw new Error("room gone");
  return loaded;
}

const person = (s: Snapshot, id: string) => s.room.participants.find((p) => p.id === id);
const isAway = (id: string) => (s: Snapshot) => person(s, id)?.away === true;
const isBack = (id: string) => (s: Snapshot) => person(s, id)?.away === false;

/** Ada, Bob and Cy in a stored room, every socket entered. */
async function everyoneIn() {
  const code = await insert(room());
  const a = client(ada);
  const b = client(bob);
  await Promise.all([a.enter(code), b.enter(code), client(cy).enter(code)]);
  // Let the back steps of the enters (no change, nothing stored) run out.
  await sleep(50);
  return { code, a, b, before: (await stored(code)).version };
}

describe("an enter racing the away run", () => {
  it("brings the person back when the enter's load read the room before the away commit", async () => {
    const { code, a, b, before } = await everyoneIn();
    b.close();
    await sleep(GRACE_MS - 120);
    let release!: () => void;
    let read!: () => void;
    const loadRead = new Promise<void>((resolve) => {
      read = resolve;
    });
    holdNextLoad = { release: new Promise<void>((resolve) => (release = resolve)), read };
    const b2 = client(bob);
    const entering = b2.enter(code);
    // Bob's enter has read the room (Bob connected) and waits; the grace runs out.
    await loadRead;
    await a.waitFor(isAway(bob.id), 3000);
    const from = a.received.length;
    release();
    const entered = await entering;
    expect(entered.ok && person(entered.snapshot, bob.id)?.away).toBe(false);
    const back = await a.waitFor(isBack(bob.id), 3000, from);
    expect(back.snapshot.causes).toStrictEqual([{ type: "back", who: bob.id }]);
    await b2.waitFor(isBack(bob.id), 3000);
    await sleep(GRACE_MS + 100);
    const after = await stored(code);
    expect(after.version).toBe(before + 2);
    expect(after.state.participants[bob.id]).toMatchObject({ connected: true });
    expect(after.state.participants[bob.id]).not.toHaveProperty("awaySince");
  });

  it("sends a socket still entering no copy of the version its answer carries", async () => {
    const { code } = await everyoneIn();
    let release!: () => void;
    let read!: () => void;
    const loadRead = new Promise<void>((resolve) => {
      read = resolve;
    });
    holdNextLoad = { release: new Promise<void>((resolve) => (release = resolve)), read };
    // Cy's second tab joins the room's channel, then waits in its load.
    const c2 = client(cy);
    const entering = c2.enter(code);
    await loadRead;
    // Meanwhile Ada's second tab enters: its back step changes nothing.
    await client(ada).enter(code);
    await sleep(100);
    release();
    expect((await entering).ok).toBe(true);
    await sleep(100);
    // The enter's answer only: the unchanged run sent the entering socket nothing.
    expect(snapshotsIn(c2.frames)).toHaveLength(1);
  });

  it("stores nothing for an enter of someone shown connected", async () => {
    const { code, before } = await everyoneIn();
    const again = client(bob);
    await again.enter(code);
    await sleep(GRACE_MS + 100);
    expect((await stored(code)).version).toBe(before);
  });
});

describe("a failed away run", () => {
  it("starts the grace again, and the next run marks the person away", async () => {
    const { code, a, b, before } = await everyoneIn();
    failRuns.push("database");
    const closedAt = Date.now();
    b.close();
    const away = await a.waitFor(isAway(bob.id), 3000);
    expect(Date.now() - closedAt).toBeGreaterThanOrEqual(2 * GRACE_MS);
    expect(away.snapshot.causes).toStrictEqual([{ type: "away", who: bob.id }]);
    expect((await stored(code)).version).toBe(before + 1);
    expect(logs.messages()).toContain("presence: away failed");
  });

  it(`gives up after ${MAX_AWAY_RETRIES} retries, and a return ends the series`, async () => {
    const { code, b, before } = await everyoneIn();
    for (let i = 0; i < 10; i++) failRuns.push("conflict");
    const from = runs;
    b.close();
    await sleep((MAX_AWAY_RETRIES + 2) * GRACE_MS + 300);
    expect(runs - from).toBe(MAX_AWAY_RETRIES + 1);
    expect(logs.messages()).toContain("presence: away given up");
    expect(sync.presence.pending((await stored(code)).id, bob.id)).toBe(false);
    expect((await stored(code)).version).toBe(before);
    failRuns.length = 0;

    // A return between two failed runs stops the retries: nothing runs after the back step.
    const second = client(bob);
    await second.enter(code);
    await sleep(50);
    failRuns.push("conflict");
    const beforeClose = runs;
    second.close();
    await sleep(GRACE_MS + 100);
    expect(runs - beforeClose).toBe(1);
    const third = client(bob);
    await third.enter(code);
    await sleep(2 * GRACE_MS);
    // The back step only: no retry fired after the return.
    expect(runs - beforeClose).toBe(2);
    expect((await stored(code)).version).toBe(before);
  });
});
