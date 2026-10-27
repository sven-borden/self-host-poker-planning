/**
 * Presence against Postgres with real guests (#17): the grace timer marks a person away
 * once their last socket left, a reconnect inside the grace changes nothing, coming back
 * clears it, going away settles the round, the first socket after a restart starts the
 * timers the restart lost, a room's timers go with its last socket, and no log line names
 * a person or the room code. The graces are short here (`presenceGraceMs` and
 * `presenceRestartGraceMs`); the e2e test of AC 1 runs the real 15 s.
 */
import { apply, type Command, createRoom, type RoomState } from "@pp/domain";
import type { Snapshot } from "@pp/protocol";
import { cardLeaks } from "@pp/protocol/leak-scan";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "../db/test-db.ts";
import { createServer, type PokerServer } from "../server.ts";
import { setupServer } from "../setup.ts";
import { collectLogs, testConfig, VALID_ENV } from "../test-support.ts";
import {
  type Guest,
  roomCode,
  signInGuest,
  snapshotsIn,
  type TestClient,
  testClient,
} from "./test-support.ts";

const ORIGIN = VALID_ENV.BASE_URL;
const GRACE_MS = 400;
/** After a restart: longer than the normal grace (60 s against 15 s in production). */
const RESTART_GRACE_MS = 1200;
const logs = collectLogs("debug");
// Names no log line could contain by chance.
const NAMES = { ada: "Adelheidqz", bob: "Bobrikowsk", cy: "Cyrillavex" } as const;

let t: TestDatabase;
let setup: Awaited<ReturnType<typeof setupServer>>;
let server: PokerServer;
let base: string;
const clients: TestClient[] = [];
let ada: Guest;
let bob: Guest;
let cy: Guest;
const codes: string[] = [];

beforeAll(async () => {
  t = await createTestDatabase();
  const config = testConfig({ DATABASE_URL: t.url });
  setup = await setupServer(config, logs.logger, undefined, {
    presenceGraceMs: GRACE_MS,
    presenceRestartGraceMs: RESTART_GRACE_MS,
  });
  server = createServer(config, { ...setup.deps, logger: logs.logger });
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
});

afterAll(async () => {
  await server?.close();
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

/** Ada (PO) and Bob vote, Cy observes; a voting round unless `lobby`. */
function room({ lobby = false } = {}): RoomState {
  let s = createRoom({ ownerId: ada.id });
  s = step(s, ada.id, { type: "join", name: NAMES.ada, role: "voter" });
  s = step(s, bob.id, { type: "join", name: NAMES.bob, role: "voter" });
  s = step(s, cy.id, { type: "join", name: NAMES.cy, role: "observer" });
  if (lobby) return s;
  return step(s, ada.id, { type: "startRound", subject: { kind: "title", text: "Login" } });
}

async function insert(state: RoomState): Promise<string> {
  const code = roomCode();
  const stored = await setup.database.store.insertRoom({ code, name: null, state });
  if (!stored) throw new Error("code taken");
  codes.push(code);
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

describe("the grace period", () => {
  it("marks a person away once their last socket has been gone for the grace, and back on return", async () => {
    const code = await insert(room({ lobby: true }));
    const a = client(ada);
    const b = client(bob);
    const b2 = client(bob);
    await Promise.all([a.enter(code), b.enter(code), b2.enter(code), client(cy).enter(code)]);
    const before = (await stored(code)).version;

    // One of two tabs closes: Bob is still here.
    b2.close();
    await sleep(GRACE_MS + 200);
    expect((await stored(code)).version).toBe(before);

    // The last one closes: nothing during the grace, then away.
    const closedAt = Date.now();
    b.close();
    await sleep(GRACE_MS / 2);
    expect(person(a.latest() as Snapshot, bob.id)?.away).toBe(false);
    const away = await a.waitFor(isAway(bob.id), 3000);
    expect(Date.now() - closedAt).toBeGreaterThanOrEqual(GRACE_MS);
    expect(away.snapshot.causes).toStrictEqual([{ type: "away", who: bob.id }]);
    expect(person(away.snapshot, bob.id)).toMatchObject({ connected: false, away: true });
    const gone = await stored(code);
    expect(gone.version).toBe(before + 1);
    expect(gone.state.participants[bob.id]?.awaySince).toBeTypeOf("number");

    // Bob comes back: the others see it at once.
    const from = a.received.length;
    const again = client(bob);
    await again.enter(code);
    const back = await a.waitFor(isBack(bob.id), 3000, from);
    expect(back.snapshot.causes).toStrictEqual([{ type: "back", who: bob.id }]);
    expect(person(back.snapshot, bob.id)).toMatchObject({ connected: true, away: false });
    await again.waitFor(isBack(bob.id));
    expect((await stored(code)).state.participants[bob.id]).not.toHaveProperty("awaySince");
  });

  it("changes nothing when the person reloads inside the grace", async () => {
    const code = await insert(room({ lobby: true }));
    const a = client(ada);
    const b = client(bob);
    await Promise.all([a.enter(code), b.enter(code), client(cy).enter(code)]);
    const before = (await stored(code)).version;
    const seen = a.received.length;
    b.close();
    await sleep(GRACE_MS / 4);
    await client(bob).enter(code);
    await sleep(GRACE_MS + 300);
    expect((await stored(code)).version).toBe(before);
    expect(a.received).toHaveLength(seen);
  });

  it("settles the round: the last one thinking goes away after everyone else voted", async () => {
    const code = await insert(room());
    const a = client(ada);
    const b = client(bob);
    const c = client(cy);
    await Promise.all([a.enter(code), b.enter(code), c.enter(code)]);
    expect((await a.cmd("castVote", { card: "13", round: 1, restart: 0 })).ok).toBe(true);
    b.close();
    const revealed = await c.waitFor((s) => s.room.round?.phase === "revealed", 3000);
    expect(revealed.snapshot.causes).toStrictEqual([
      { type: "away", who: bob.id },
      { type: "revealed", by: "everyoneVoted" },
    ]);
  });

  it("drops a room's timers when its last socket leaves: nobody is marked away", async () => {
    const code = await insert(room({ lobby: true }));
    const a = client(ada);
    const b = client(bob);
    await Promise.all([a.enter(code), b.enter(code)]);
    const before = await stored(code);
    b.close();
    await sleep(GRACE_MS / 4);
    a.close();
    await sleep(GRACE_MS + 300);
    const after = await stored(code);
    expect(after.version).toBe(before.version);
    expect(after.state.participants[bob.id]?.connected).toBe(true);
  });

  it("ignores someone who left the room before their socket closed", async () => {
    const code = await insert(room({ lobby: true }));
    const a = client(ada);
    const b = client(bob);
    await Promise.all([a.enter(code), b.enter(code), client(cy).enter(code)]);
    expect((await b.cmd("leave")).ok).toBe(true);
    const before = (await stored(code)).version;
    b.close();
    await sleep(GRACE_MS + 300);
    expect((await stored(code)).version).toBe(before);
  });
});

describe("after a restart", () => {
  it("the room's first socket starts the restart grace of everyone shown connected without a socket here", async () => {
    // As a restart leaves it: everyone stored connected, no socket, no timer.
    const code = await insert(room({ lobby: true }));
    const a = client(ada);
    const enteredAt = Date.now();
    await a.enter(code);
    const before = (await stored(code)).version;
    // Cy comes back after the normal grace, inside the restart grace; Bob never does.
    await sleep(GRACE_MS + 200);
    expect((await stored(code)).version).toBe(before);
    await client(cy).enter(code);
    const away = await a.waitFor(isAway(bob.id), 3000);
    expect(Date.now() - enteredAt).toBeGreaterThanOrEqual(RESTART_GRACE_MS);
    expect(away.snapshot.causes).toStrictEqual([{ type: "away", who: bob.id }]);
    await sleep(GRACE_MS);
    const latest = a.latest() as Snapshot;
    expect(person(latest, cy.id)?.away).toBe(false);
    expect(person(latest, ada.id)?.away).toBe(false);
    expect((await stored(code)).state.participants[cy.id]?.connected).toBe(true);
  });

  it("brings back a person stored as away when their socket enters", async () => {
    let state = room({ lobby: true });
    const result = apply(
      state,
      { type: "presence", who: bob.id, connected: false },
      { actor: ":server", now: Date.now() },
    );
    if (!result.ok) throw new Error("fixture refused");
    state = result.state;
    const code = await insert(state);
    const a = client(ada);
    await a.enter(code);
    const from = a.received.length;
    await client(bob).enter(code);
    const back = await a.waitFor(isBack(bob.id), 3000, from);
    expect(back.snapshot.causes).toStrictEqual([{ type: "back", who: bob.id }]);
  });
});

describe("secrecy and logs", () => {
  it("presence and the voted state carry no card to the observer or the other voter", async () => {
    const code = await insert(room());
    const a = client(ada);
    const b = client(bob);
    const c = client(cy);
    await Promise.all([a.enter(code), b.enter(code), c.enter(code)]);
    expect((await b.cmd("castVote", { card: "13", round: 1, restart: 0 })).ok).toBe(true);
    // Cy, the observer, leaves for a while and comes back: away, then back.
    c.close();
    await a.waitFor(isAway(cy.id), 3000);
    const from = a.received.length;
    const c2 = client(cy);
    await c2.enter(code);
    await a.waitFor(isBack(cy.id), 3000, from);
    await c2.waitFor(isBack(cy.id), 3000);
    const voter = snapshotsIn(a.frames);
    const observer = snapshotsIn([...c.frames, ...c2.frames]);
    expect(voter.length).toBeGreaterThanOrEqual(4);
    for (const snapshot of [...voter, ...observer]) {
      expect(snapshot.room.round?.phase).toBe("voting");
      expect(cardLeaks(snapshot, ["13"])).toEqual([]);
    }
    for (const frame of [...a.frames, ...c.frames, ...c2.frames]) {
      expect(frame).not.toContain('"13"');
    }
    // Only that Bob voted travels.
    expect(voter.at(-1)?.room.round?.voted).toEqual([bob.id]);
    expect(observer.at(-1)?.room.round?.voted).toEqual([bob.id]);
    const causes = voter.flatMap((s) => s.causes.map((cause) => cause.type));
    expect(causes).toEqual(expect.arrayContaining(["voteCast", "away", "back"]));
  });

  it("no log line holds a person's name or a room code", () => {
    const messages = logs.messages();
    expect(messages).toContain("socket entered");
    expect(messages).toContain("presence: away");
    expect(messages).toContain("presence: back");
    const text = logs.raw.join("\n");
    for (const name of Object.values(NAMES)) expect(text).not.toContain(name);
    for (const code of codes) expect(text).not.toContain(code);
  });
});
