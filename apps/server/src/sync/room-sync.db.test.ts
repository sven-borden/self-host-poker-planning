/**
 * The room sync against Postgres with real guests (Better Auth sessions, the real
 * handshake): join latency (AC 1), a burst past the message limit (AC 3), secrecy on the
 * raw WebSocket frames, idempotent ids, a revoked session, and the deadline timeout on one
 * and on two server instances sharing the database. The restart (AC 2) is
 * `restart.db.test.ts`.
 */
import { performance } from "node:perf_hooks";
import { apply, type Command, createRoom, type RoomState } from "@pp/domain";
import { cardLeaks } from "@pp/protocol/leak-scan";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Config } from "../config.ts";
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
  withDeadline,
} from "./test-support.ts";

const ORIGIN = VALID_ENV.BASE_URL;
const logs = collectLogs("debug");

type Instance = Awaited<ReturnType<typeof setupServer>> & { server: PokerServer; base: string };

let t: TestDatabase;
let config: Config;
const instances: Instance[] = [];
const clients: TestClient[] = [];
let ada: Guest;
let bob: Guest;
let cy: Guest;

async function startInstance(): Promise<Instance> {
  const setup = await setupServer(config, logs.logger);
  const server = createServer(config, { ...setup.deps, logger: logs.logger });
  const { port } = await server.listen();
  const instance = { ...setup, server, base: `http://localhost:${port}` };
  instances.push(instance);
  return instance;
}

beforeAll(async () => {
  t = await createTestDatabase();
  config = testConfig({ DATABASE_URL: t.url });
  const first = await startInstance();
  [ada, bob, cy] = await Promise.all([
    signInGuest(first.base, ORIGIN),
    signInGuest(first.base, ORIGIN),
    signInGuest(first.base, ORIGIN),
  ]);
});

afterEach(() => {
  for (const client of clients.splice(0)) client.close();
});

afterAll(async () => {
  for (const instance of instances) {
    await instance.server.close();
    await instance.dispose?.();
  }
  await t?.drop();
});

function main(): Instance {
  const instance = instances[0];
  if (!instance) throw new Error("not started");
  return instance;
}

function client(guest: Guest, instance = main()): TestClient {
  const c = testClient(instance.base, { cookie: guest.cookie });
  clients.push(c);
  return c;
}

function step(state: RoomState, actor: string, command: Command, now = Date.now()): RoomState {
  const result = apply(state, command, { actor, now });
  if (!result.ok) throw new Error(`fixture refused: ${result.error}`);
  return result.state;
}

/** Ada (PO) and Bob vote, Cy observes; a voting round, named or anonymous. */
function votingRoom({ anonymous = false } = {}): RoomState {
  let s = createRoom({ ownerId: ada.id });
  s = step(s, ada.id, { type: "join", name: "Ada", role: "voter" });
  s = step(s, bob.id, { type: "join", name: "Bob", role: "voter" });
  s = step(s, cy.id, { type: "join", name: "Cy", role: "observer" });
  if (anonymous) s = step(s, ada.id, { type: "updateSettings", patch: { revealNames: false } });
  return step(s, ada.id, { type: "startRound", subject: { kind: "title", text: "Login" } });
}

async function insert(state: RoomState): Promise<string> {
  const code = roomCode();
  const room = await main().database.store.insertRoom({ code, name: null, state });
  if (!room) throw new Error("code taken");
  return code;
}

describe("join latency (AC 1)", () => {
  it("shows a join to the other client in under 200 ms", async () => {
    const latencies: number[] = [];
    for (let i = 0; i < 10; i++) {
      const code = await insert(createRoom({ ownerId: ada.id }));
      const a = client(ada);
      const b = client(bob);
      expect((await a.enter(code)).ok).toBe(true);
      expect((await b.enter(code)).ok).toBe(true);
      const from = a.received.length;
      const sent = performance.now();
      const ack = b.cmd("join", { name: "Bob", role: "voter" });
      const seen = await a.waitFor(
        (s) => s.room.participants.some((p) => p.id === bob.id),
        2000,
        from,
      );
      expect(await ack).toEqual({ ok: true, version: 2 });
      expect(seen.snapshot.causes).toEqual([{ type: "joined", who: bob.id }]);
      latencies.push(seen.at - sent);
      a.close();
      b.close();
    }
    latencies.sort((x, y) => x - y);
    const median = latencies[5] ?? Number.NaN;
    const max = latencies.at(-1) ?? Number.NaN;
    console.info(
      `join seen by the other client: median ${median.toFixed(1)} ms, max ${max.toFixed(1)} ms`,
    );
    expect(max).toBeLessThan(200);
  });
});

describe("a burst past the message limit (AC 3)", () => {
  it("refuses the excess with rate_limited, keeps the room consistent and serves the others", async () => {
    const code = await insert(votingRoom());
    const a = client(ada);
    const b = client(bob);
    const c = client(cy);
    await Promise.all([a.enter(code), b.enter(code), c.enter(code)]);
    const burst = Promise.all(
      Array.from({ length: 200 }, (_, i) => b.cmd("castVote", { card: i % 2 ? "5" : "3" })),
    );
    const started = performance.now();
    const other = await a.cmd("startTimer", { seconds: 600 });
    const otherMs = performance.now() - started;
    const acks = await burst;
    const limited = acks.filter((ack) => !ack.ok && ack.code === "rate_limited").length;
    expect(limited).toBeGreaterThanOrEqual(150);
    expect(acks.filter((ack) => !ack.ok && ack.code !== "rate_limited")).toEqual([]);
    expect(other.ok).toBe(true);
    expect(otherMs).toBeLessThan(2000);
    expect(b.socket.connected).toBe(true);

    const stored = await main().database.store.loadRoom(code);
    const highest = Math.max(
      ...acks.map((ack) => (ack.ok ? ack.version : 0)),
      other.ok ? other.version : 0,
    );
    expect(stored?.version).toBe(highest);
    await c.waitFor((s) => s.version === highest);
    await b.waitFor((s) => s.version === highest);
    expect(b.latest()?.room.round?.yourVote).toBe(stored?.state.round?.votes[bob.id]?.card);
    // And the socket goes on working once the bucket refills.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect((await b.cmd("retractVote")).ok).toBe(true);
  });
});

describe("secrecy on the real frames", () => {
  it("while Voting, the observer and the other voter never receive a card", async () => {
    const code = await insert(votingRoom());
    const a = client(ada);
    const b = client(bob);
    const c = client(cy);
    await Promise.all([a.enter(code), b.enter(code), c.enter(code)]);
    expect((await a.cmd("castVote", { card: "13" })).ok).toBe(true);
    expect((await b.cmd("castVote", { card: "5" })).ok).toBe(true);
    // Everyone voted: the room reveals by itself; wait for the last voting snapshot first.
    await c.waitFor((s) => s.room.round?.phase === "revealed");
    await b.waitFor((s) => s.room.round?.phase === "revealed");
    const votingFrames = (frames: string[]) =>
      frames.filter((frame) => !frame.includes('"phase":"revealed"'));
    const observer = votingFrames(c.frames);
    const voter = votingFrames(b.frames);
    expect(snapshotsIn(observer).length).toBeGreaterThanOrEqual(3);
    for (const frame of observer) {
      expect(frame).not.toContain('"13"');
      expect(frame).not.toContain('"5"');
    }
    for (const frame of voter) expect(frame).not.toContain('"13"');
    for (const snapshot of snapshotsIn(observer)) {
      expect(cardLeaks(snapshot, ["13", "5"])).toEqual([]);
    }
    for (const snapshot of snapshotsIn(voter)) expect(cardLeaks(snapshot, ["13"])).toEqual([]);
  });

  it("in an anonymous round, no frame ties a person to a card, before or after reveal", async () => {
    /** The observer's frames for a round where Ada and Bob vote `cards`, until the reveal. */
    async function observe(cards: [string, string]) {
      const code = await insert(votingRoom({ anonymous: true }));
      const a = client(ada);
      const b = client(bob);
      const c = client(cy);
      await Promise.all([a.enter(code), b.enter(code), c.enter(code)]);
      // The second vote completes the round: "everyone voted" reveals it.
      expect((await a.cmd("castVote", { card: cards[0] })).ok).toBe(true);
      expect((await b.cmd("castVote", { card: cards[1] })).ok).toBe(true);
      await c.waitFor((s) => s.room.round?.phase === "revealed");
      return { code, frames: [...c.frames] };
    }
    const first = await observe(["13", "5"]);
    const swapped = await observe(["5", "13"]);
    const normalise = ({ code, frames }: { code: string; frames: string[] }) =>
      snapshotsIn(frames).map((snapshot) =>
        JSON.parse(
          JSON.stringify(snapshot, (key, value: unknown) =>
            key === "serverNow" || key === "startedAt" || key === "revealedAt"
              ? 0
              : value === code
                ? "CODE"
                : value,
          ),
        ),
      );
    const seen = normalise(first);
    expect(seen.length).toBeGreaterThanOrEqual(3);
    expect(normalise(swapped)).toStrictEqual(seen);
    const revealed = snapshotsIn(first.frames).at(-1);
    expect(revealed?.room.round).toMatchObject({ phase: "revealed", anonymous: true });
    expect(revealed?.room.round && "votes" in revealed.room.round).toBe(false);
    for (const frame of first.frames) expect(frame).not.toContain('"votes"');
  });
});

describe("commands", () => {
  it("applies a command id once on Postgres too", async () => {
    const code = await insert(votingRoom());
    const b = client(bob);
    await b.enter(code);
    const [x, y] = await Promise.all([
      b.cmd("castVote", { card: "8" }, "twice"),
      b.cmd("castVote", { card: "8" }, "twice"),
    ]);
    expect(x).toEqual({ ok: true, version: 2 });
    expect(y).toEqual(x);
    expect((await main().database.store.loadRoom(code))?.version).toBe(2);
  });

  it("answers enter with unauthenticated once the guest signed out, on the same socket", async () => {
    const dee = await signInGuest(main().base, ORIGIN);
    const code = await insert(createRoom({ ownerId: ada.id }));
    const d = client(dee);
    expect((await d.enter(code)).ok).toBe(true);
    const out = await fetch(`${main().base}/api/auth/sign-out`, {
      method: "POST",
      headers: { origin: ORIGIN, cookie: dee.cookie, "content-type": "application/json" },
      body: "{}",
    });
    expect(out.ok).toBe(true);
    expect(d.socket.connected).toBe(true);
    expect(await d.enter(code)).toEqual({ ok: false, code: "unauthenticated" });
  });
});

describe("the deadline timeout", () => {
  it("reveals at the deadline with no client action", async () => {
    let state = votingRoom();
    state = step(state, bob.id, { type: "castVote", card: "5" });
    const code = await insert(withDeadline(state, Date.now() + 400));
    const c = client(cy);
    await c.enter(code);
    const seen = await c.waitFor((s) => s.room.round?.phase === "revealed", 3000);
    expect(seen.snapshot.causes).toEqual([{ type: "revealed", by: "timer" }]);
    expect((await main().database.store.loadRoom(code))?.version).toBe(2);
  });

  it("reveals once with two server instances on one database", async () => {
    const second = instances[1] ?? (await startInstance());
    let state = votingRoom();
    state = step(state, bob.id, { type: "castVote", card: "5" });
    const code = await insert(withDeadline(state, Date.now() + 500));
    const one = client(cy);
    const two = client(ada, second);
    await Promise.all([one.enter(code), two.enter(code)]);
    await Promise.all([
      one.waitFor((s) => s.room.round?.phase === "revealed", 3000),
      two.waitFor((s) => s.room.round?.phase === "revealed", 3000),
    ]);
    // Let the losing instance finish its own run before counting.
    await new Promise((resolve) => setTimeout(resolve, 200));
    const reveals = [...one.received, ...two.received].flatMap(({ snapshot }) =>
      snapshot.causes.filter((cause) => cause.type === "revealed"),
    );
    expect(reveals).toEqual([{ type: "revealed", by: "timer" }]);
    expect((await main().database.store.loadRoom(code))?.version).toBe(2);
  });
});
