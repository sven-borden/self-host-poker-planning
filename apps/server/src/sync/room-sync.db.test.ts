/**
 * The room sync against Postgres with real guests (Better Auth sessions, the real
 * handshake): join latency (AC 1), a burst past the message limit (AC 3), secrecy on the
 * raw WebSocket frames, the reveal (#19: a non-PO is refused, the last two votes sent
 * together reveal once), reveal modes (#28: a voter reveals under "anyone", an observer
 * never; the automatic reveal off and on again), the room settings (#25: the defaults, refusals on the wire, one
 * snapshot for everyone), idempotent ids, a revoked session, one session flooding a room
 * from many sockets, and the deadline timeout on one and on two server instances sharing
 * the database. The restart (AC 2) is `restart.db.test.ts`.
 */
import { performance } from "node:perf_hooks";
import {
  apply,
  type Command,
  computeResults,
  createRoom,
  DEFAULT_SETTINGS,
  type RoomState,
} from "@pp/domain";
import type { Snapshot } from "@pp/protocol";
import { cardLeaks } from "@pp/protocol/leak-scan";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Config } from "../config.ts";
import { createTestDatabase, testClient as dbClient, type TestDatabase } from "../db/test-db.ts";
import { createServer, type PokerServer } from "../server.ts";
import { type SetupTuning, setupServer } from "../setup.ts";
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

async function startInstance(tuning: SetupTuning = {}): Promise<Instance> {
  const setup = await setupServer(config, logs.logger, undefined, tuning);
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

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * A fixture clock that never repeats: two joins in one millisecond would tie on `joinedAt`,
 * and the snapshot would then order those people by id, which differs from room to room.
 */
let lastStep = 0;
function tick(): number {
  lastStep = Math.max(Date.now(), lastStep + 1);
  return lastStep;
}

function step(state: RoomState, actor: string, command: Command, now = tick()): RoomState {
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
      Array.from({ length: 200 }, (_, i) =>
        b.cmd("castVote", { card: i % 2 ? "5" : "3", round: 1, restart: 0 }),
      ),
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
    await sleep(300);
    expect((await b.cmd("retractVote", { round: 1, restart: 0 })).ok).toBe(true);
    // Bob's bucket is shared by all his sockets, later tests' too: let it fill up again.
    await sleep(2000);
  });
});

describe("secrecy on the real frames", () => {
  it("while Voting, the observer and the other voter never receive a card", async () => {
    const code = await insert(votingRoom());
    const a = client(ada);
    const b = client(bob);
    const c = client(cy);
    await Promise.all([a.enter(code), b.enter(code), c.enter(code)]);
    expect((await a.cmd("castVote", { card: "13", round: 1, restart: 0 })).ok).toBe(true);
    expect((await b.cmd("castVote", { card: "5", round: 1, restart: 0 })).ok).toBe(true);
    // Everyone voted: the room reveals by itself; wait for the last voting snapshot first.
    await c.waitFor((s) => s.room.round?.phase === "revealed");
    await b.waitFor((s) => s.room.round?.phase === "revealed");
    const votingFrames = (frames: string[]) =>
      frames.filter((frame) => !frame.includes('"phase":"revealed"'));
    const observer = votingFrames(c.frames);
    const voter = votingFrames(b.frames);
    // The enter's snapshot and Ada's vote; Bob's vote revealed the round.
    expect(snapshotsIn(observer)).toHaveLength(2);
    expect(snapshotsIn(voter)).toHaveLength(2);
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
      expect((await a.cmd("castVote", { card: cards[0], round: 1, restart: 0 })).ok).toBe(true);
      expect((await b.cmd("castVote", { card: cards[1], round: 1, restart: 0 })).ok).toBe(true);
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
    // The enter's snapshot, Ada's vote, and Bob's vote that revealed the round.
    expect(seen).toHaveLength(3);
    expect(normalise(swapped)).toStrictEqual(seen);
    const revealed = snapshotsIn(first.frames).at(-1);
    expect(revealed?.room.round).toMatchObject({ phase: "revealed", anonymous: true });
    expect(revealed?.room.round && "votes" in revealed.room.round).toBe(false);
    for (const frame of first.frames) expect(frame).not.toContain('"votes"');
  });
});

describe("the reveal (#19)", () => {
  it("refuses a reveal from someone who is not the PO, on the wire (AC 1)", async () => {
    const code = await insert(votingRoom());
    const b = client(bob);
    const c = client(cy);
    await Promise.all([b.enter(code), c.enter(code)]);
    expect(await b.cmd("reveal")).toEqual({ ok: false, code: "not_allowed" });
    expect(await c.cmd("reveal")).toEqual({ ok: false, code: "not_allowed" });
    // Nothing was stored or broadcast: the round still votes, at the inserted version.
    await sleep(100);
    expect(b.received).toHaveLength(1);
    expect(c.received).toHaveLength(1);
    const stored = await main().database.store.loadRoom(code);
    expect(stored?.version).toBe(1);
    expect(stored?.state.round?.phase).toBe("voting");
    // The PO may.
    const a = client(ada);
    await a.enter(code);
    expect(await a.cmd("reveal")).toEqual({ ok: true, version: 2 });
    const seen = await c.waitFor((s) => s.room.round?.phase === "revealed");
    expect(seen.snapshot.causes).toEqual([{ type: "revealed", by: "manual", who: ada.id }]);
  });

  /**
   * Ada and Bob send the round's last two votes at the same moment; Cy watches. Each
   * commit reaches the sockets of the instance that stored it, so Cy watches on every
   * instance in play, and the union of what Cy saw is every stored change.
   */
  async function lastTwoVotesTogether(instances: [Instance, Instance]) {
    const code = await insert(votingRoom());
    const a = client(ada, instances[0]);
    const b = client(bob, instances[1]);
    const watchers = [client(cy, instances[0]), client(cy, instances[1])];
    await Promise.all([a.enter(code), b.enter(code), ...watchers.map((w) => w.enter(code))]);
    const acks = await Promise.all([
      a.cmd("castVote", { card: "3", round: 1, restart: 0 }),
      b.cmd("castVote", { card: "8", round: 1, restart: 0 }),
    ]);
    expect(acks.map((ack) => ack.ok)).toEqual([true, true]);
    // Only the instance that stored the reveal broadcasts it.
    await Promise.any(
      watchers.map((w) => w.waitFor((s) => s.room.round?.phase === "revealed", 3000)),
    );
    // Let a losing compare-and-set finish its retry before counting.
    await sleep(200);
    const seen = new Map<number, Snapshot>();
    for (const w of watchers) {
      for (const { snapshot } of w.received.slice(1)) seen.set(snapshot.version, snapshot);
    }
    const reveals = [...seen.values()].flatMap((s) =>
      s.causes.filter((cause) => cause.type === "revealed"),
    );
    // A person holds at most 8 sockets: close this round's before the next one.
    for (const c of [a, b, ...watchers]) c.close();
    const stored = await main().database.store.loadRoom(code);
    return { reveals, versions: [...seen.keys()].sort((x, y) => x - y), stored };
  }

  it("reveals exactly once when the last two votes arrive together (AC 2)", async () => {
    for (let i = 0; i < 5; i++) {
      const { reveals, versions, stored } = await lastTwoVotesTogether([main(), main()]);
      expect(reveals).toEqual([{ type: "revealed", by: "everyoneVoted" }]);
      // One version per vote, the second one revealing.
      expect(versions).toEqual([2, 3]);
      expect(stored?.version).toBe(3);
      expect(stored?.state.round).toMatchObject({
        phase: "revealed",
        votes: { [ada.id]: { card: "3" }, [bob.id]: { card: "8" } },
      });
    }
  }, 30_000);

  it("reveals exactly once when the two votes reach two instances together (AC 2)", async () => {
    const second = instances[1] ?? (await startInstance());
    for (let i = 0; i < 5; i++) {
      const { reveals, versions, stored } = await lastTwoVotesTogether([main(), second]);
      expect(reveals).toEqual([{ type: "revealed", by: "everyoneVoted" }]);
      expect(versions).toEqual([2, 3]);
      expect(stored?.version).toBe(3);
      expect(stored?.state.round?.phase).toBe("revealed");
    }
  }, 30_000);
});

describe("reveal modes (#28)", () => {
  /** Ada (PO) and Bob vote, Cy observes; a voting round under `settings`. */
  function roundWith(settings: Partial<RoomState["settings"]>): RoomState {
    let s = createRoom({ ownerId: ada.id });
    s = step(s, ada.id, { type: "join", name: "Ada", role: "voter" });
    s = step(s, bob.id, { type: "join", name: "Bob", role: "voter" });
    s = step(s, cy.id, { type: "join", name: "Cy", role: "observer" });
    s = step(s, ada.id, { type: "updateSettings", patch: settings });
    return step(s, ada.id, { type: "startRound", subject: { kind: "title", text: "Login" } });
  }

  it("under anyone who votes, refuses the observer and lets a voter reveal, named in the cause", async () => {
    const code = await insert(roundWith({ whoCanReveal: "anyone" }));
    const b = client(bob);
    const c = client(cy);
    await Promise.all([b.enter(code), c.enter(code)]);
    expect(await c.cmd("reveal")).toEqual({ ok: false, code: "not_allowed" });
    // Nothing was stored or broadcast: the round stays secret.
    await sleep(100);
    expect(b.received).toHaveLength(1);
    expect(c.received).toHaveLength(1);
    expect((await main().database.store.loadRoom(code))?.state.round?.phase).toBe("voting");
    expect(await b.cmd("reveal")).toEqual({ ok: true, version: 2 });
    const seen = await c.waitFor((s) => s.room.round?.phase === "revealed");
    expect(seen.snapshot.causes).toEqual([{ type: "revealed", by: "manual", who: bob.id }]);
  });

  it("with the automatic reveal off, the last vote leaves the round voting until the PO reveals", async () => {
    const code = await insert(roundWith({ revealWhenAllVoted: false }));
    const a = client(ada);
    const c = client(cy);
    await Promise.all([a.enter(code), c.enter(code)]);
    expect((await a.cmd("castVote", { card: "3", round: 1, restart: 0 })).ok).toBe(true);
    const b = client(bob);
    await b.enter(code);
    expect(await b.cmd("castVote", { card: "8", round: 1, restart: 0 })).toEqual({
      ok: true,
      version: 3,
    });
    const last = await c.waitFor((s) => s.version === 3);
    expect(last.snapshot.room.round).toMatchObject({ phase: "voting" });
    expect(last.snapshot.causes).toEqual([{ type: "voteCast", who: bob.id }]);
    expect(await a.cmd("reveal")).toEqual({ ok: true, version: 4 });
    const seen = await c.waitFor((s) => s.room.round?.phase === "revealed");
    expect(seen.snapshot.causes).toEqual([{ type: "revealed", by: "manual", who: ada.id }]);
  });

  it("turning the automatic reveal on once everyone voted reveals at once, in one snapshot", async () => {
    let state = roundWith({ revealWhenAllVoted: false });
    state = step(state, ada.id, { type: "castVote", card: "3" });
    state = step(state, bob.id, { type: "castVote", card: "8" });
    const code = await insert(state);
    const a = client(ada);
    const c = client(cy);
    await Promise.all([a.enter(code), c.enter(code)]);
    expect(c.latest()?.room.round?.phase).toBe("voting");
    expect(await a.cmd("updateSettings", { patch: { revealWhenAllVoted: true } })).toEqual({
      ok: true,
      version: 2,
    });
    const seen = await c.waitFor((s) => s.version === 2);
    expect(seen.snapshot.room.round?.phase).toBe("revealed");
    expect(seen.snapshot.causes).toEqual([
      { type: "settingsUpdated" },
      { type: "revealed", by: "everyoneVoted" },
    ]);
  });

  it("a voter's reveal of an anonymous round names the revealer and ties nobody to a card", async () => {
    /** The observer's frames for a round where Ada and Bob vote `cards` and Bob reveals. */
    async function observe(cards: [string, string]) {
      let state = roundWith({
        whoCanReveal: "anyone",
        revealNames: false,
        revealWhenAllVoted: false,
      });
      state = step(state, ada.id, { type: "castVote", card: cards[0] });
      const code = await insert(state);
      const b = client(bob);
      const c = client(cy);
      await Promise.all([b.enter(code), c.enter(code)]);
      expect((await b.cmd("castVote", { card: cards[1], round: 1, restart: 0 })).ok).toBe(true);
      expect((await b.cmd("reveal")).ok).toBe(true);
      await c.waitFor((s) => s.room.round?.phase === "revealed");
      for (const x of [b, c]) x.close();
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
    // The same frames whoever voted what: nothing maps a person to a value.
    expect(normalise(swapped)).toStrictEqual(normalise(first));
    const revealed = snapshotsIn(first.frames).at(-1);
    expect(revealed?.room.round).toMatchObject({ phase: "revealed", anonymous: true });
    expect(revealed?.causes).toEqual([{ type: "revealed", by: "manual", who: bob.id }]);
    for (const frame of first.frames) expect(frame).not.toContain('"votes"');
  });
});

describe("the room settings (#25)", () => {
  /** Ada (PO) and Bob vote, Cy observes, in the lobby of a new room. */
  function lobby(): RoomState {
    let s = createRoom({ ownerId: ada.id });
    s = step(s, ada.id, { type: "join", name: "Ada", role: "voter" });
    s = step(s, bob.id, { type: "join", name: "Bob", role: "voter" });
    return step(s, cy.id, { type: "join", name: "Cy", role: "observer" });
  }

  it("shows a new room's settings exactly as ADR-011 sets them (AC 3)", async () => {
    const code = await insert(lobby());
    const b = client(bob);
    await b.enter(code);
    expect(b.latest()?.room.settings).toEqual(DEFAULT_SETTINGS);
  });

  it("refuses a change from a voter and from an observer, on the wire (AC 2)", async () => {
    const code = await insert(lobby());
    const b = client(bob);
    const c = client(cy);
    await Promise.all([b.enter(code), c.enter(code)]);
    expect(await b.cmd("updateSettings", { patch: { revealNames: false } })).toEqual({
      ok: false,
      code: "not_owner",
    });
    expect(await c.cmd("updateSettings", { patch: { observersCount: false } })).toEqual({
      ok: false,
      code: "not_owner",
    });
    // Nothing was stored or broadcast.
    await sleep(100);
    expect(b.received).toHaveLength(1);
    expect(c.received).toHaveLength(1);
    const stored = await main().database.store.loadRoom(code);
    expect(stored?.version).toBe(1);
    expect(stored?.state.settings).toEqual(DEFAULT_SETTINGS);
  });

  it("brings the PO's change to every client in one snapshot (AC 1)", async () => {
    const code = await insert(lobby());
    const watchers = [client(ada), client(bob), client(cy)];
    await Promise.all(watchers.map((w) => w.enter(code)));
    const [a] = watchers;
    expect(
      await a?.cmd("updateSettings", { patch: { revealNames: false, poVotes: false } }),
    ).toEqual({ ok: true, version: 2 });
    for (const w of watchers) {
      const seen = await w.waitFor((s) => s.version === 2);
      expect(seen.snapshot.causes).toEqual([{ type: "settingsUpdated" }]);
      expect(seen.snapshot.room.settings).toEqual({
        ...DEFAULT_SETTINGS,
        revealNames: false,
        poVotes: false,
      });
    }
    await sleep(100);
    for (const w of watchers) expect(w.received.map((r) => r.snapshot.version)).toEqual([1, 2]);
  });
});

describe("the deck (#26)", () => {
  // These tests send Ada's commands in a burst; her session's bucket (20, 10 a second) is
  // shared with the tests after them, so let it refill.
  afterEach(() => sleep(2_000));

  it("refuses a deck change from a voter and an observer, and brings every custom-deck code to the PO", async () => {
    const code = await insert(votingRoom());
    const [a, b, c] = [client(ada), client(bob), client(cy)];
    await Promise.all([a.enter(code), b.enter(code), c.enter(code)]);
    const tshirt = { deck: { kind: "preset", id: "tshirt" } };
    expect(await b.cmd("updateSettings", { patch: tshirt })).toEqual({
      ok: false,
      code: "not_owner",
    });
    expect(await c.cmd("updateSettings", { patch: { specials: [] } })).toEqual({
      ok: false,
      code: "not_owner",
    });
    const refused: Array<[string, string[]]> = [
      ["deck_empty", []],
      ["deck_too_many_cards", Array.from({ length: 21 }, (_, i) => String(i))],
      ["card_empty", ["1", " "]],
      ["card_invalid", ["a\u{200b}b"]],
      ["card_too_long", ["Large"]],
      ["card_duplicate", ["1", "1.0"]],
      ["card_special", ["\u{2615}\u{fe0f}"]],
    ];
    for (const [expected, cards] of refused) {
      expect(await a.cmd("updateSettings", { patch: { deck: { kind: "custom", cards } } })).toEqual(
        { ok: false, code: expected },
      );
    }
    expect((await main().database.store.loadRoom(code))?.version).toBe(1);
  });

  it("restarts the round on a new deck: votes cleared, same subject and number, and a vote sent before it is refused", async () => {
    const code = await insert(votingRoom());
    const [a, b, c] = [client(ada), client(bob), client(cy)];
    await Promise.all([a.enter(code), b.enter(code), c.enter(code)]);
    expect((await b.cmd("castVote", { card: "5", round: 1, restart: 0 })).ok).toBe(true);
    const cards = ["0.5", "1", "1.5", "2.5", "5"];
    expect((await a.cmd("updateSettings", { patch: { deck: { kind: "custom", cards } } })).ok).toBe(
      true,
    );
    for (const watcher of [a, b, c]) {
      const seen = await watcher.waitFor((s) => s.room.round?.restarts === 1);
      expect(seen.snapshot.causes).toEqual([
        { type: "settingsUpdated" },
        { type: "roundStarted", number: 1, restarted: true },
      ]);
      expect(seen.snapshot.room.round).toMatchObject({
        number: 1,
        phase: "voting",
        subject: { kind: "title", text: "Login" },
        deck: { kind: "custom", cards },
        voted: [],
      });
      expect(seen.snapshot.room.round).not.toHaveProperty("yourVote");
    }
    // "5" is in both decks: a vote made for the round before its restart must not land.
    expect(await b.cmd("castVote", { card: "5", round: 1, restart: 0 })).toEqual({
      ok: false,
      code: "round_changed",
    });
    expect(await b.cmd("retractVote", { round: 1, restart: 0 })).toEqual({
      ok: false,
      code: "round_changed",
    });
    expect((await main().database.store.loadRoom(code))?.state.round?.votes).toEqual({});
    // Played on the new deck, the round reveals and goes to history with its deck.
    expect((await a.cmd("castVote", { card: "1.5", round: 1, restart: 1 })).ok).toBe(true);
    expect((await b.cmd("castVote", { card: "0.5", round: 1, restart: 1 })).ok).toBe(true);
    const revealed = await c.waitFor((s) => s.room.round?.phase === "revealed");
    expect(revealed.snapshot.room.round).toMatchObject({
      results: { average: 1, median: 1, consensus: false },
    });
    expect((await a.cmd("startRound", { subject: { kind: "none" } })).ok).toBe(true);
    await c.waitFor((s) => s.room.round?.number === 2);
    const stored = await main().database.store.loadRoom(code);
    // Round 2 plays with the custom deck too.
    expect(stored?.state.round?.deck).toEqual({ kind: "custom", cards });
    const sql = dbClient(t.url);
    try {
      const { rows } = await sql.query(
        "select number, deck, votes from round_history where room_id = $1 order by number",
        [stored?.id],
      );
      expect(rows).toEqual([
        {
          number: 1,
          deck: { spec: { kind: "custom", cards }, specials: ["?", "☕"] },
          votes: {
            kind: "named",
            votes: [
              { who: ada.id, name: "Ada", card: "1.5" },
              { who: bob.id, name: "Bob", card: "0.5" },
            ],
          },
        },
      ]);
    } finally {
      await sql.end();
    }
  });

  it("starts the round over on a restart, timer included: the room's timer anew, a timer by hand stops, a time up starts again", async () => {
    // One room without a timer setting, whose PO started a timer by hand; one with a 5 s
    // timer; one whose 5 s timer is up without a reveal. Both deadlines are close, and
    // every round holds a vote.
    let byHand = votingRoom();
    byHand = step(byHand, ada.id, { type: "startTimer", seconds: 60 });
    byHand = step(byHand, bob.id, { type: "castVote", card: "5" });
    let timed = votingRoom();
    timed = { ...timed, settings: { ...timed.settings, timer: { seconds: 5, revealAtEnd: true } } };
    timed = step(timed, bob.id, { type: "castVote", card: "5" });
    let up = votingRoom();
    up = { ...up, settings: { ...up.settings, timer: { seconds: 5, revealAtEnd: false } } };
    up = step(up, bob.id, { type: "castVote", card: "5" });
    up = step(withDeadline(up, tick()), ada.id, { type: "timeUp" });
    expect(up.round?.timeUpAt).toBeDefined();
    const codes = await Promise.all([
      insert(withDeadline(byHand, Date.now() + 700)),
      insert(withDeadline(timed, Date.now() + 700)),
      insert(up),
    ]);
    const [a1, c1, a2, c2, a3, c3] = [
      client(ada),
      client(cy),
      client(ada),
      client(cy),
      client(ada),
      client(cy),
    ];
    await Promise.all([
      a1.enter(codes[0]),
      c1.enter(codes[0]),
      a2.enter(codes[1]),
      c2.enter(codes[1]),
      a3.enter(codes[2]),
      c3.enter(codes[2]),
    ]);
    const tshirt = { deck: { kind: "preset", id: "tshirt" } };
    const before = Date.now();
    expect((await a1.cmd("updateSettings", { patch: tshirt })).ok).toBe(true);
    expect((await a2.cmd("updateSettings", { patch: tshirt })).ok).toBe(true);
    expect((await a3.cmd("updateSettings", { patch: tshirt })).ok).toBe(true);
    const stopped = await c1.waitFor((s) => s.room.round?.restarts === 1);
    expect(stopped.snapshot.room.round).not.toHaveProperty("deadlineAt");
    expect(stopped.snapshot.room.round).not.toHaveProperty("timerStartedAt");
    for (const watcher of [c2, c3]) {
      const anew = (await watcher.waitFor((s) => s.room.round?.restarts === 1)).snapshot.room.round;
      expect(anew?.timerStartedAt).toBeGreaterThanOrEqual(before);
      expect((anew?.deadlineAt ?? 0) - (anew?.timerStartedAt ?? 0)).toBe(5_000);
      expect(anew).not.toHaveProperty("timeUpAt");
    }
    // Past the old deadlines, every round still votes.
    await sleep(1_000);
    for (const code of codes) {
      expect((await main().database.store.loadRoom(code))?.state.round?.phase).toBe("voting");
    }
    // A client that sends no restart (one older than #26) votes in the round as it is now.
    expect((await a2.cmd("castVote", { card: "M", round: 1 })).ok).toBe(true);
    expect((await main().database.store.loadRoom(codes[1]))?.state.round?.votes[ada.id]).toEqual(
      expect.objectContaining({ card: "M" }),
    );
  });
});

describe("the next round (#21)", () => {
  async function historyOf(code: string) {
    const stored = await main().database.store.loadRoom(code);
    const sql = dbClient(t.url);
    try {
      const { rows } = await sql.query(
        `select number, subject, votes, stats, final, row_to_json(h)::text as text
        from round_history h where room_id = $1 order by number`,
        [stored?.id],
      );
      return rows;
    } finally {
      await sql.end();
    }
  }

  /** Ada and Bob vote 5 and 8, which reveals; then Ada starts the next round on the wire. */
  async function playThenNext(anonymous: boolean, subject: object) {
    const code = await insert(votingRoom({ anonymous }));
    const a = client(ada);
    const b = client(bob);
    const c = client(cy);
    await Promise.all([a.enter(code), b.enter(code), c.enter(code)]);
    expect((await a.cmd("castVote", { card: "5", round: 1, restart: 0 })).ok).toBe(true);
    expect((await b.cmd("castVote", { card: "8", round: 1, restart: 0 })).ok).toBe(true);
    await c.waitFor((s) => s.room.round?.phase === "revealed");
    // Before the next round, nothing is history yet.
    expect(await historyOf(code)).toEqual([]);
    // Bob is not the PO.
    expect(await b.cmd("startRound", { subject })).toEqual({ ok: false, code: "not_owner" });
    expect((await a.cmd("startRound", { subject })).ok).toBe(true);
    const seen = await c.waitFor((s) => s.room.round?.number === 2);
    return { code, round: seen.snapshot.room.round, causes: seen.snapshot.causes };
  }

  it("writes the finished named round to history with its subject, votes and stats (AC 2)", async () => {
    const url = "https://acme.atlassian.net/browse/PAY-482";
    const { code, round, causes } = await playThenNext(false, { kind: "link", url });
    // The votes are cleared, the number went up, and the server read the key.
    expect(round).toMatchObject({ number: 2, phase: "voting", voted: [] });
    expect(round?.subject).toEqual({ kind: "link", url, key: "PAY-482" });
    expect(causes).toEqual([{ type: "roundStarted", number: 2 }]);
    const rows = await historyOf(code);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      number: 1,
      subject: { kind: "title", text: "Login" },
      votes: {
        kind: "named",
        votes: [
          { who: ada.id, name: "Ada", card: "5" },
          { who: bob.id, name: "Bob", card: "8" },
        ],
      },
      stats: computeResults(["5", "8"], { kind: "preset", id: "fib" }),
      final: null,
    });
  });

  it("keeps only the cards of an anonymous round (AC 2)", async () => {
    const { code, round } = await playThenNext(true, { kind: "title", text: "Checkout" });
    expect(round).toMatchObject({ number: 2, subject: { kind: "title", text: "Checkout" } });
    const [row] = await historyOf(code);
    expect(row?.votes).toEqual({ kind: "anonymous", cards: ["5", "8"] });
    for (const leak of [ada.id, bob.id, "Ada", "Bob"]) expect(row?.text).not.toContain(leak);
  });

  it("refuses a subject over 200 characters and a link with credentials (AC 3)", async () => {
    const code = await insert(votingRoom());
    const a = client(ada);
    await a.enter(code);
    expect(await a.cmd("reveal")).toMatchObject({ ok: true });
    for (const subject of [
      { kind: "title", text: "x".repeat(201) },
      { kind: "link", url: "http://user:pass@acme.atlassian.net/browse/PAY-1" },
      { kind: "link", url: "javascript:alert(1)" },
    ]) {
      expect(await a.cmd("startRound", { subject })).toEqual({ ok: false, code: "bad_subject" });
    }
    expect((await main().database.store.loadRoom(code))?.state.round?.number).toBe(1);
  });
});

describe("commands", () => {
  it("applies a command id once on Postgres too", async () => {
    const code = await insert(votingRoom());
    const b = client(bob);
    await b.enter(code);
    const [x, y] = await Promise.all([
      b.cmd("castVote", { card: "8", round: 1, restart: 0 }, "twice"),
      b.cmd("castVote", { card: "8", round: 1, restart: 0 }, "twice"),
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

describe("one session flooding a room from many sockets", () => {
  it("gets at most 8 sockets and one bucket, and honest commands keep their latency", async () => {
    const mallory = await signInGuest(main().base, ORIGIN);
    const code = await insert(votingRoom());
    const honest = client(bob);
    await honest.enter(code);

    /** Bob's votes, one after the other: each one's latency, and every ack. */
    async function vote(times: number, label: string) {
      const ms: number[] = [];
      const acks = [];
      for (let i = 0; i < times; i++) {
        const sent = performance.now();
        acks.push(
          await honest.cmd(
            "castVote",
            { card: i % 2 ? "3" : "5", round: 1, restart: 0 },
            `${label}-${i}`,
          ),
        );
        ms.push(performance.now() - sent);
        await sleep(50);
      }
      return { max: Math.max(...ms), acks };
    }
    const quiet = await vote(5, "quiet");

    // Mallory tries 40 sockets: 8 connect, the rest are refused at the handshake.
    const attempts = Array.from({ length: 40 }, () => client(mallory));
    const outcomes = await Promise.all(
      attempts.map(
        (c) =>
          new Promise<string>((resolve) => {
            c.socket.once("connect", () => resolve("connected"));
            c.socket.once("connect_error", (error) => resolve(error.message));
          }),
      ),
    );
    expect(outcomes.filter((o) => o === "connected")).toHaveLength(8);
    expect(outcomes.filter((o) => o === "rate_limited")).toHaveLength(32);
    const flood = attempts.filter((c) => c.socket.connected);
    await Promise.all(flood.map((c) => c.enter(code)));

    // Each socket sends timeUp (open to anyone) at what a socket's own bucket used to allow.
    let stop = false;
    let accepted = 0;
    const pending: Promise<unknown>[] = [];
    const send = (c: TestClient) =>
      pending.push(
        c.cmd("timeUp").then(
          (ack) => {
            if (ack.ok) accepted += 1;
          },
          () => {},
        ),
      );
    const pumps = flood.map(async (c) => {
      for (let i = 0; i < 20; i++) send(c);
      while (!stop) {
        await sleep(100);
        send(c);
      }
    });
    await sleep(500);
    const loaded = await vote(10, "flood");
    stop = true;
    await Promise.all(pumps);
    const drainStarted = performance.now();
    await Promise.all(pending);
    const drained = performance.now() - drainStarted;
    console.info(
      `flood: honest max ${quiet.max.toFixed(1)} ms quiet, ${loaded.max.toFixed(1)} ms flooded; ` +
        `${accepted} of ${pending.length} timeUp accepted; backlog answered ${drained.toFixed(0)} ms after`,
    );
    expect([...quiet.acks, ...loaded.acks].every((ack) => ack.ok)).toBe(true);
    expect(loaded.max).toBeLessThan(500);
    expect(drained).toBeLessThan(1000);
    // One bucket for all 8: a burst of 20 and 10 a second, not 8 times that.
    expect(accepted).toBeLessThan(20 + 10 * 3);
    // Bob's first vote is still remembered: sent again, it is answered, not applied again.
    const before = (await main().database.store.loadRoom(code))?.version;
    expect(await honest.cmd("castVote", { card: "5", round: 1, restart: 0 }, "quiet-0")).toEqual(
      quiet.acks[0],
    );
    expect((await main().database.store.loadRoom(code))?.version).toBe(before);
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

  it("reveals once on the clients' timeUp pings when no timeout runs, and a ping with nothing to do stores and sends nothing", async () => {
    // An instance without its own timeout: only the pings resolve the deadline.
    const quiet = await startInstance({ deadlineTimeouts: false });
    let state = votingRoom();
    state = step(state, bob.id, { type: "castVote", card: "5" });
    const code = await insert(withDeadline(state, Date.now() + 1_500));
    const pages = [client(ada, quiet), client(bob, quiet), client(cy, quiet), client(ada, quiet)];
    await Promise.all(pages.map((page) => page.enter(code)));
    const stored = async () => (await main().database.store.loadRoom(code))?.version;
    const frames = () => pages.reduce((n, page) => n + page.received.length, 0);
    // Before the deadline a ping finds nothing to do.
    const quietFrames = frames();
    expect(await pages[0]?.cmd("timeUp")).toEqual({ ok: true, version: 1 });
    await sleep(1_600);
    expect(await stored()).toBe(1);
    expect(frames()).toBe(quietFrames);
    // Past it, four pages ping at once: one reveal, one write.
    const acks = await Promise.all(pages.map((page) => page.cmd("timeUp")));
    expect(acks.every((ack) => ack.ok)).toBe(true);
    await Promise.all(
      pages.map((page) => page.waitFor((s) => s.room.round?.phase === "revealed", 3000)),
    );
    await sleep(200);
    const reveals = pages.flatMap((page) =>
      page.received.flatMap(({ snapshot }) => snapshot.causes),
    );
    expect(reveals).toEqual(Array(4).fill({ type: "revealed", by: "timer" }));
    expect(await stored()).toBe(2);
    // A late ping finds the round revealed: nothing stored, nothing sent.
    const after = frames();
    expect(await pages[1]?.cmd("timeUp")).toEqual({ ok: true, version: 2 });
    await sleep(100);
    expect(await stored()).toBe(2);
    expect(frames()).toBe(after);
  });
});
