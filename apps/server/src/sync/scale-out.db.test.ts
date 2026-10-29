/**
 * Two server instances on one Postgres and one Redis (#39): one room served from both,
 * with real guests and the real handshake. Joins, votes and the reveal reach everyone once,
 * with their causes; the secrecy scans run on the frames of people on the other instance
 * than the voter; a kick and a new password close sockets on the other instance; a
 * deadline reveals once; presence holds while a person still has a socket on either
 * instance; a command id resent to the other instance runs once; and retention sees a room
 * in use on the other instance. Nothing on Redis carries a room code or a card. Signals
 * that come late, or never, are covered too: a late kick or lockout, a lost change (the
 * next one goes out after every visitor's grant is read again), a newer state a server
 * run found, a claim still running elsewhere, and every Redis connection dropped mid-run.
 *
 * Needs `TEST_REDIS_URL` (a throwaway Redis: `docker run --rm -p 6379:6379 redis:7-alpine`,
 * CI's `db-tests` job has one). Without it the file is skipped locally and fails in CI.
 * Not `REDIS_URL`: the other db tests read their config from defaults, never from Redis.
 */
import { performance } from "node:perf_hooks";
import { type ApplyResult, apply, type Command, createRoom, type RoomState } from "@pp/domain";
import type { Snapshot } from "@pp/protocol";
import { cardLeaks } from "@pp/protocol/leak-scan";
import { createClient } from "@redis/client";
import type pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Config } from "../config.ts";
import type { AccessWrite } from "../db/rooms.ts";
import {
  createTestDatabase,
  testClient as databaseClient,
  type TestDatabase,
} from "../db/test-db.ts";
import { createServer, type PokerServer } from "../server.ts";
import { type SetupTuning, setupServer } from "../setup.ts";
import { collectLogs, testConfig, VALID_ENV } from "../test-support.ts";
import type { RoomSync } from "./room-sync.ts";
import {
  type Guest,
  roomCode,
  signInGuest,
  snapshotsIn,
  type TestClient,
  testClient,
  withDeadline,
} from "./test-support.ts";

const REDIS_URL = process.env.TEST_REDIS_URL;
if (!REDIS_URL && process.env.CI) throw new Error("TEST_REDIS_URL is not set in CI");

const ORIGIN = VALID_ENV.BASE_URL;
const logs = collectLogs("debug");
const GRACE_MS = 300;

type Instance = Awaited<ReturnType<typeof setupServer>> & { server: PokerServer; base: string };

let t: TestDatabase;
let admin: pg.Pool;
let config: Config;
const instances: Instance[] = [];
const clients: TestClient[] = [];
const newRedis = () => createClient({ url: REDIS_URL ?? "", RESP: 2 });
type Redis = ReturnType<typeof newRedis>;
const redisClients: Redis[] = [];

/** A client of the test's Redis, as a stranger to the instances (a spy, or another instance). */
async function redisClient(): Promise<Redis> {
  const redis = newRedis();
  redis.on("error", () => {});
  await redis.connect();
  redisClients.push(redis);
  return redis;
}

/** The adapter's request channel: where `serverSideEmit` publishes (`scale-out.ts`). */
const REQUESTS = "pp-request#/#";
/** Publishes a room change as a third instance would (the adapter's SERVER_SIDE_EMIT). */
let publisher: Redis | undefined;
async function signal(payload: Record<string, unknown>) {
  publisher ??= await redisClient();
  const redis = publisher;
  const request = { uid: "another-instance", type: 6, data: ["roomChanged", payload] };
  await redis.publish(REQUESTS, JSON.stringify(request));
}
let ada: Guest;
let bob: Guest;
let cy: Guest;
let dee: Guest;

async function startInstance(tuning: SetupTuning = {}): Promise<Instance> {
  const setup = await setupServer(config, logs.logger, undefined, tuning);
  const server = createServer(config, { ...setup.deps, logger: logs.logger });
  const { port } = await server.listen();
  const instance = { ...setup, server, base: `http://localhost:${port}` };
  instances.push(instance);
  return instance;
}

const one = () => instances[0] as Instance;
/** The room sync an instance runs (`setupServer`'s `handlers`). */
function syncOf(instance: Instance): RoomSync {
  const sync = instance.deps?.handlers;
  if (!sync) throw new Error("no room sync");
  return sync as RoomSync;
}
const two = () => instances[1] as Instance;
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

describe.skipIf(!REDIS_URL)("two instances on one room (Redis)", () => {
  beforeAll(async () => {
    t = await createTestDatabase();
    admin = databaseClient(t.url);
    config = testConfig({ DATABASE_URL: t.url, REDIS_URL: REDIS_URL ?? "" });
    const tuning = {
      presenceGraceMs: GRACE_MS,
      presenceRestartGraceMs: GRACE_MS,
      presenceSweepMs: 200,
    };
    await startInstance(tuning);
    await startInstance(tuning);
  });

  /** New guests for each block: a person's message bucket is shared by their sockets. */
  async function freshGuests() {
    [ada, bob, cy, dee] = await Promise.all([
      signInGuest(one().base, ORIGIN),
      signInGuest(two().base, ORIGIN),
      signInGuest(one().base, ORIGIN),
      signInGuest(two().base, ORIGIN),
    ]);
  }

  afterEach(() => {
    for (const client of clients.splice(0)) client.close();
  });

  afterAll(async () => {
    for (const instance of instances) {
      await instance.server.close();
      await instance.dispose?.();
    }
    for (const redis of redisClients.splice(0)) redis.destroy();
    await admin?.end();
    await t?.drop();
  });

  function client(guest: Guest, instance: Instance): TestClient {
    const c = testClient(instance.base, { cookie: guest.cookie });
    clients.push(c);
    return c;
  }

  let lastStep = 0;
  function step(state: RoomState, actor: string, command: Command): RoomState {
    lastStep = Math.max(Date.now(), lastStep + 1);
    const result = apply(state, command, { actor, now: lastStep });
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
    const room = await one().database.store.insertRoom({ code, name: null, state });
    if (!room) throw new Error("code taken");
    return code;
  }

  const stored = async (code: string) => one().database.store.loadRoom(code);
  async function idOf(code: string): Promise<string> {
    const id = (await stored(code))?.id;
    if (!id) throw new Error("no room");
    return id;
  }

  /** Stores a step through the first instance's runner alone: no broadcast, no signal. */
  async function silently(
    code: string,
    step: (state: RoomState) => ApplyResult & { access?: AccessWrite },
  ): Promise<number> {
    const outcome = await one().database.runner.run(code, step);
    if (!outcome.ok || !outcome.changed) throw new Error("the silent step stored nothing");
    return outcome.version;
  }

  /** A REST call of the room API, as a guest. */
  const api = (base: string, guest: Guest, path: string, method: string, body?: unknown) =>
    fetch(`${base}/api/rooms/${path}`, {
      method,
      headers: { origin: ORIGIN, cookie: guest.cookie, "content-type": "application/json" },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
  const PASSWORD = "correct horse";
  /** How often a client heard `locked`. */
  function lockedCount(c: TestClient) {
    const count = { value: 0 };
    c.socket.on("locked", () => {
      count.value += 1;
    });
    return count;
  }

  /** Every version a client received, in order: none twice, none going back. */
  function expectEachVersionOnce(c: TestClient) {
    const versions = c.received.map(({ snapshot }) => snapshot.version);
    expect([...versions].sort((x, y) => x - y)).toEqual(versions);
    expect(new Set(versions).size).toBe(versions.length);
  }

  const reveals = (c: TestClient) =>
    c.received.flatMap(({ snapshot }) =>
      snapshot.causes.filter((cause) => cause.type === "revealed"),
    );

  describe("one round across both", () => {
    beforeAll(freshGuests);

    it("shows a join, the votes and the reveal on both instances once each, with their causes", async () => {
      // A stranger on Redis hears everything the instances say, and reads every ack key.
      const spy = await redisClient();
      const heard: string[] = [];
      await spy.pSubscribe("pp*", (message, channel) => heard.push(`${channel} ${message}`));
      const code = await insert(createRoom({ ownerId: ada.id }));
      const a = client(ada, one());
      const b = client(bob, two());
      const c = client(cy, two());
      await Promise.all([a.enter(code), b.enter(code), c.enter(code)]);
      const sent = performance.now();
      expect(await b.cmd("join", { name: "Bob", role: "voter" })).toEqual({ ok: true, version: 2 });
      const joined = await a.waitFor((s) => s.version === 2);
      expect(joined.snapshot.causes).toEqual([{ type: "joined", who: bob.id }]);
      console.info(`join seen on the other instance in ${(joined.at - sent).toFixed(1)} ms`);
      expect(joined.at - sent).toBeLessThan(500);

      expect((await a.cmd("join", { name: "Ada", role: "voter" })).ok).toBe(true);
      expect((await c.cmd("join", { name: "Cy", role: "observer" })).ok).toBe(true);
      const started = await a.cmd("startRound", { subject: { kind: "none" } });
      expect(started.ok).toBe(true);
      const round = await b.waitFor((s) => s.room.round?.phase === "voting");
      expect(round.snapshot.causes[0]).toMatchObject({ type: "roundStarted", number: 1 });

      expect((await a.cmd("castVote", { card: "13", round: 1, restart: 0 })).ok).toBe(true);
      const voted = await c.waitFor((s) => (s.room.round?.voted ?? []).includes(ada.id));
      expect(voted.snapshot.causes).toEqual([{ type: "voteCast", who: ada.id }]);
      expect((await b.cmd("castVote", { card: "5", round: 1, restart: 0 })).ok).toBe(true);
      for (const x of [a, b, c]) await x.waitFor((s) => s.room.round?.phase === "revealed");
      await sleep(200);
      for (const x of [a, b, c]) {
        expectEachVersionOnce(x);
        expect(reveals(x)).toEqual([{ type: "revealed", by: "everyoneVoted" }]);
      }
      expect((await stored(code))?.version).toBe(c.latest()?.version);

      await spy.pUnsubscribe();
      const reader = await redisClient();
      const acks: string[] = [];
      for await (const keys of reader.scanIterator({ MATCH: "pp:ack:*", COUNT: 100 })) {
        for (const key of keys) acks.push(`${key} ${String(await reader.get(key))}`);
      }
      expect(heard.length).toBeGreaterThan(0);
      expect(acks.length).toBeGreaterThan(0);
      for (const line of [...heard, ...acks]) {
        expect(line).not.toContain(code);
        expect(line).not.toContain('"13"');
        expect(line).not.toContain('"5"');
        expect(line).not.toContain("card");
      }
    });
  });

  describe("secrecy on the frames of the other instance", () => {
    beforeAll(freshGuests);

    it("while Voting, the observer and the voter on the other instance never receive a card", async () => {
      const code = await insert(votingRoom());
      const a = client(ada, one());
      const b = client(bob, two());
      const c = client(cy, two());
      await Promise.all([a.enter(code), b.enter(code), c.enter(code)]);
      expect((await a.cmd("castVote", { card: "13", round: 1, restart: 0 })).ok).toBe(true);
      await c.waitFor((s) => (s.room.round?.voted ?? []).includes(ada.id));
      expect((await b.cmd("castVote", { card: "5", round: 1, restart: 0 })).ok).toBe(true);
      await c.waitFor((s) => s.room.round?.phase === "revealed");
      await b.waitFor((s) => s.room.round?.phase === "revealed");
      const voting = (frames: string[]) => frames.filter((f) => !f.includes('"phase":"revealed"'));
      const observer = voting(c.frames);
      const voter = voting(b.frames);
      // The enter's snapshot and Ada's vote, from the other instance; Bob's revealed it.
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

    it("in an anonymous round, no frame on either instance ties a person to a card", async () => {
      /** Everyone's frames for a round where Ada (one) and Bob (two) vote `cards`. */
      async function observe(cards: [string, string]) {
        const code = await insert(votingRoom({ anonymous: true }));
        const a = client(ada, one());
        const b = client(bob, two());
        const c = client(cy, two());
        const d = client(cy, one());
        await Promise.all([a.enter(code), b.enter(code), c.enter(code), d.enter(code)]);
        expect((await a.cmd("castVote", { card: cards[0], round: 1, restart: 0 })).ok).toBe(true);
        await c.waitFor((s) => (s.room.round?.voted ?? []).length === 1);
        expect((await b.cmd("castVote", { card: cards[1], round: 1, restart: 0 })).ok).toBe(true);
        await c.waitFor((s) => s.room.round?.phase === "revealed");
        await d.waitFor((s) => s.room.round?.phase === "revealed");
        return { code, there: [...c.frames], here: [...d.frames] };
      }
      const normalise = (code: string, frames: string[]) =>
        snapshotsIn(frames).map((snapshot: Snapshot) =>
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
      const first = await observe(["13", "5"]);
      const swapped = await observe(["5", "13"]);
      for (const side of ["there", "here"] as const) {
        const seen = normalise(first.code, first[side]);
        expect(seen).toHaveLength(3);
        expect(normalise(swapped.code, swapped[side])).toStrictEqual(seen);
        for (const frame of first[side]) expect(frame).not.toContain('"votes"');
      }
    });
  });

  describe("powers across instances", () => {
    beforeAll(freshGuests);

    it("closes a removed person's sockets on the other instance within 1 s", async () => {
      const code = await insert(votingRoom());
      const a = client(ada, one());
      const tabs = [client(bob, two()), client(bob, one())];
      await Promise.all([a.enter(code), ...tabs.map((tab) => tab.enter(code))]);
      const closed = tabs.map(
        (tab) =>
          new Promise<number>((resolve) =>
            tab.socket.on("disconnect", () => resolve(performance.now())),
          ),
      );
      const sent = performance.now();
      expect((await a.cmd("kick", { who: bob.id })).ok).toBe(true);
      for (const at of await Promise.all(closed)) expect(at - sent).toBeLessThan(1000);
      for (const tab of tabs) {
        expect(tab.kicked.count).toBe(1);
        expect(tab.latest()?.room.you).toBeNull();
      }
    });

    it("locks a visitor on the other instance out when the PO sets a password", async () => {
      const code = await insert(votingRoom());
      const a = client(ada, one());
      const visitor = client(dee, two());
      await Promise.all([a.enter(code), visitor.enter(code)]);
      let locked = 0;
      visitor.socket.on("locked", () => {
        locked += 1;
      });
      const response = await fetch(`${one().base}/api/rooms/${code}/password`, {
        method: "PUT",
        headers: { origin: ORIGIN, cookie: ada.cookie, "content-type": "application/json" },
        body: JSON.stringify({ password: "correct horse" }),
      });
      expect(response.status).toBe(204);
      await expect.poll(() => locked, { timeout: 2000 }).toBe(1);
      const before = visitor.received.length;
      expect(await visitor.cmd("castVote", { card: "5", round: 1, restart: 0 })).toEqual({
        ok: false,
        code: "room_not_found",
      });
      expect(visitor.received.length).toBe(before);
      expect((await visitor.enter(code)).ok).toBe(false);
    });
  });

  describe("the deadline", () => {
    beforeAll(freshGuests);

    it("reveals once, and both instances' sockets get the reveal with its causes", async () => {
      let state = votingRoom();
      state = step(state, bob.id, { type: "castVote", card: "5" });
      // Far enough for four enters on a slow runner: the reveal must come from a timer.
      const code = await insert(withDeadline(state, Date.now() + 1500));
      // Everyone holds a socket, so no presence change moves the version.
      const pages = [client(cy, one()), client(ada, two()), client(cy, two()), client(bob, one())];
      await Promise.all(pages.map((page) => page.enter(code)));
      for (const page of pages) {
        expect(page.latest()?.room.round?.phase).toBe("voting");
      }
      for (const page of pages) {
        await page.waitFor((s) => s.room.round?.phase === "revealed", 4000);
      }
      await sleep(300);
      for (const page of pages) {
        expectEachVersionOnce(page);
        expect(reveals(page)).toEqual([{ type: "revealed", by: "timer" }]);
      }
      expect((await stored(code))?.version).toBe(2);
    });
  });

  describe("Redis lost mid-run", () => {
    beforeAll(freshGuests);

    it("keeps each instance serving its own sockets, and fans out again once Redis is back", async () => {
      const unhandled: unknown[] = [];
      const listener = (reason: unknown) => unhandled.push(reason);
      process.on("unhandledRejection", listener);
      try {
        const code = await insert(votingRoom());
        const a = client(ada, one());
        const c = client(cy, one());
        const b = client(bob, two());
        await Promise.all([a.enter(code), c.enter(code), b.enter(code)]);
        // Redis stops answering writes (a PUBLISH is one), then drops every connection: the
        // publishes in flight then reject, as in a Redis restart.
        const redis = await redisClient();
        await redis.sendCommand(["CLIENT", "PAUSE", "10000", "WRITE"]);
        try {
          // Ada votes twice: the command id cannot be claimed (it runs here alone after 1 s),
          // and the signal waits in flight. Cy, on her instance, sees each vote.
          for (const card of ["3", "8"]) {
            expect((await a.cmd("castVote", { card, round: 1, restart: 0 })).ok).toBe(true);
            const last = (await stored(code))?.version ?? 0;
            await c.waitFor((s) => s.version === last);
          }
          await redis.sendCommand(["CLIENT", "KILL", "TYPE", "pubsub"]);
          await redis.sendCommand(["CLIENT", "KILL", "TYPE", "normal"]);
        } finally {
          await redis.sendCommand(["CLIENT", "UNPAUSE"]);
        }

        // Both subscribers are back: Bob's vote on the second instance reaches the first.
        await expect
          .poll(
            async () => {
              const [, count] = (await redis.sendCommand(["PUBSUB", "NUMSUB", REQUESTS])) as [
                string,
                number,
              ];
              return count;
            },
            { timeout: 5000 },
          )
          .toBe(2);
        expect((await b.cmd("castVote", { card: "5", round: 1, restart: 0 })).ok).toBe(true);
        for (const x of [a, b, c]) {
          await x.waitFor((s) => s.room.round?.phase === "revealed");
        }
        for (const instance of [one(), two()]) {
          const health = (await (await fetch(`${instance.base}/api/health`)).json()) as {
            redis?: string;
          };
          expect(health.redis).toBe("ok");
        }
        expect(logs.messages()).toContain("redis: unavailable");
        expect(unhandled).toEqual([]);
      } finally {
        process.off("unhandledRejection", listener);
      }
    });
  });

  describe("command ids and rooms in use", () => {
    beforeAll(freshGuests);

    it("answers a command id resent to the other instance with the first answer, and runs it once", async () => {
      const code = await insert(votingRoom());
      const here = client(bob, one());
      const there = client(bob, two());
      await Promise.all([here.enter(code), there.enter(code)]);
      const first = await here.cmd("castVote", { card: "5", round: 1, restart: 0 }, "resent-1");
      expect(first.ok).toBe(true);
      const again = await there.cmd("castVote", { card: "8", round: 1, restart: 0 }, "resent-1");
      expect(again).toEqual(first);
      expect((await stored(code))?.state.round?.votes[bob.id]?.card).toBe("5");
    });

    it("counts a room with a socket on the other instance as in use, for retention", async () => {
      const code = await insert(votingRoom());
      const id = (await stored(code))?.id;
      const sync = syncOf(one());
      const b = client(bob, two());
      await b.enter(code);
      expect(await sync.occupiedRooms()).toContain(id);
      b.close();
      await expect.poll(async () => (await sync.occupiedRooms()).includes(id ?? "")).toBe(false);
    });

    it("answers busy while another instance runs the same command id, and runs it once that one let go", async () => {
      const code = await insert(votingRoom());
      const id = await idOf(code);
      const b = client(bob, two());
      await b.enter(code);
      // As if the first instance claimed it and still runs it (`shared-acks.ts`).
      const redis = await redisClient();
      const key = `pp:ack:${bob.id} ${id} held-1`;
      await redis.set(key, "", { expiration: { type: "PX", value: 15_000 } });
      const vote = { card: "5", round: 1, restart: 0 };
      expect(await b.cmd("castVote", vote, "held-1")).toEqual({ ok: false, code: "busy" });
      expect((await stored(code))?.state.round?.votes[bob.id]).toBeUndefined();
      await redis.del(key);
      expect((await b.cmd("castVote", vote, "held-1")).ok).toBe(true);
      expect((await stored(code))?.state.round?.votes[bob.id]?.card).toBe("5");
    });
  });

  describe("signals that come late or never", () => {
    beforeAll(freshGuests);

    it("applies a late kick or lockout only where the newest state still calls for it", async () => {
      const code = await insert(votingRoom());
      const id = await idOf(code);
      const a = client(ada, one());
      const b = client(bob, two());
      const visitor = client(dee, two());
      await Promise.all([a.enter(code), b.enter(code), visitor.enter(code)]);
      const locked = lockedCount(visitor);
      // Queued while Redis was away: Bob's kick (he joined again since) and a lockout of a
      // password that is gone again.
      const version = (await stored(code))?.version ?? 0;
      await signal({ room: id, version, causes: [{ type: "kicked", who: bob.id }] });
      await signal({ room: id, version, causes: [], lockout: true });
      await sleep(300);
      expect(b.kicked.count).toBe(0);
      expect(b.socket.connected).toBe(true);
      expect(locked.value).toBe(0);

      // With a password, a late lockout reads the visitors' grants again: Dee keeps hers,
      // then loses it once it is gone.
      expect(
        (await api(one().base, ada, `${code}/password`, "PUT", { password: PASSWORD })).status,
      ).toBe(204);
      await expect.poll(() => locked.value).toBe(1);
      expect(
        (await api(two().base, dee, `${code}/access`, "POST", { password: PASSWORD })).status,
      ).toBe(204);
      expect((await visitor.enter(code)).ok).toBe(true);
      const now = (await stored(code))?.version ?? 0;
      await signal({ room: id, version: now, causes: [], lockout: true });
      await sleep(300);
      expect(locked.value).toBe(1);
      await admin.query("delete from room_access where room_id = $1 and user_id = $2", [
        id,
        dee.id,
      ]);
      await signal({ room: id, version: now, causes: [], lockout: true });
      await expect.poll(() => locked.value).toBe(2);
    });

    it("sends a change whose signal was lost with the next one, after every visitor's grant is read again", async () => {
      const code = await insert(votingRoom());
      const id = await idOf(code);
      expect(
        (await api(one().base, ada, `${code}/password`, "PUT", { password: PASSWORD })).status,
      ).toBe(204);
      expect(
        (await api(two().base, dee, `${code}/access`, "POST", { password: PASSWORD })).status,
      ).toBe(204);
      const a = client(ada, one());
      const b = client(bob, two());
      const visitor = client(dee, two());
      // Everyone holds a socket, so no grace moves the version.
      const observer = client(cy, one());
      await Promise.all([a.enter(code), b.enter(code), visitor.enter(code), observer.enter(code)]);
      const locked = lockedCount(visitor);
      const seen = visitor.received.length;
      // Lost: Ada's vote, stored with the drop of Dee's grant (as a kick or a new password
      // would), and never signalled.
      await admin.query("delete from room_access where room_id = $1 and user_id = $2", [
        id,
        dee.id,
      ]);
      const lost = await silently(code, (state) =>
        apply(state, { type: "castVote", card: "13" }, { actor: ada.id, now: Date.now() }),
      );
      // Bob's vote on the second instance reveals the round, a version past the lost one.
      expect(await b.cmd("castVote", { card: "5", round: 1, restart: 0 })).toEqual({
        ok: true,
        version: lost + 1,
      });
      const revealed = await b.waitFor((s) => s.version === lost + 1);
      expect(revealed.snapshot.causes).toEqual([
        { type: "voteCast", who: bob.id },
        { type: "revealed", by: "everyoneVoted" },
      ]);
      // The first instance sends it too, with the causes it heard of.
      const there = await a.waitFor((s) => s.version === lost + 1);
      expect(there.snapshot.room.round?.phase).toBe("revealed");
      // Dee, without a grant now, is locked out before she sees anything of it.
      await expect.poll(() => locked.value).toBe(1);
      expect(visitor.received.length).toBe(seen);
      for (const frame of visitor.frames) expect(frame).not.toContain('"13"');
    });

    it("sends the newer state a server run found when its signal never comes", async () => {
      const code = await insert(votingRoom());
      // Everyone holds a socket, so no grace runs; Cy's second one comes later.
      const pages = [client(ada, one()), client(cy, one())];
      const b = client(bob, two());
      await Promise.all([...pages.map((page) => page.enter(code)), b.enter(code)]);
      const lost = await silently(code, (state) =>
        apply(state, { type: "castVote", card: "8" }, { actor: ada.id, now: Date.now() }),
      );
      // Cy's tab on the second instance runs the back step there: unchanged, but it finds
      // the lost version, which Bob's socket there never got.
      const sent = performance.now();
      expect((await client(cy, two()).enter(code)).ok).toBe(true);
      const got = await b.waitFor((s) => s.version === lost, 3000);
      expect(got.snapshot.causes).toEqual([]);
      expect(got.snapshot.room.round?.voted).toContain(ada.id);
      expect(got.at - sent).toBeGreaterThanOrEqual(400);
    });
  });

  describe("presence", () => {
    beforeAll(freshGuests);

    it("keeps a person shown connected while they have a socket on either instance", async () => {
      const code = await insert(votingRoom());
      const a = client(ada, one());
      await a.enter(code);
      // Bob's first socket on the second instance starts the restart grace of Ada and Cy
      // there: the first instance, asked, still holds Ada; Cy has no socket anywhere.
      const bobHere = client(bob, two());
      const bobThere = client(bob, one());
      // Dee looks on from the second instance (no participant), so the room stays followed
      // there when Bob's socket on it closes.
      const onlooker = client(dee, two());
      await Promise.all([bobHere.enter(code), bobThere.enter(code), onlooker.enter(code)]);
      const cyAway = await a.waitFor(
        (s) => s.room.participants.some((p) => p.id === cy.id && !p.connected),
        3000,
      );
      expect(cyAway.snapshot.room.participants.find((p) => p.id === ada.id)?.connected).toBe(true);
      // The second instance's restart graces run out too, and store nothing for Ada.
      await sleep(GRACE_MS * 2);
      const settled = (await stored(code))?.version ?? 0;

      // Bob's grace starts on the second instance; when it runs out, the first instance,
      // asked, still holds him: nothing is stored (no away, so no mend either).
      const id = await idOf(code);
      bobHere.close();
      await expect.poll(() => syncOf(two()).presence.pending(id, bob.id)).toBe(true);
      await sleep(GRACE_MS * 3);
      expect(syncOf(two()).presence.pending(id, bob.id)).toBe(false);
      const room = await stored(code);
      expect(room?.version).toBe(settled);
      expect(room?.state.participants[bob.id]?.connected).toBe(true);
      expect(room?.state.participants[ada.id]?.connected).toBe(true);

      bobThere.close();
      const away = await a.waitFor(
        (s) => s.room.participants.some((p) => p.id === bob.id && !p.connected),
        3000,
      );
      expect(away.snapshot.causes).toEqual([{ type: "away", who: bob.id }]);
    });

    it("starts the grace of someone whose sockets were on an instance that stopped holding them", async () => {
      const code = await insert(votingRoom());
      const a = client(ada, one());
      const c = client(cy, one());
      const b = client(bob, two());
      await Promise.all([a.enter(code), c.enter(code), b.enter(code)]);
      // As if the second instance died: its sync forgets the room without a disconnect.
      syncOf(two()).close();
      b.socket.io.engine.close();
      const away = await a.waitFor(
        (s) => s.room.participants.some((p) => p.id === bob.id && !p.connected),
        3000,
      );
      expect(away.snapshot.causes).toEqual([{ type: "away", who: bob.id }]);
    });
  });
});
