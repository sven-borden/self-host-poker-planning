/**
 * Two server instances on one Postgres and one Redis (#39): one room served from both,
 * with real guests and the real handshake. Joins, votes and the reveal reach everyone once,
 * with their causes; the secrecy scans run on the frames of people on the other instance
 * than the voter; a kick and a new password close sockets on the other instance; a
 * deadline reveals once; presence holds while a person still has a socket on either
 * instance; a command id resent to the other instance runs once; and retention sees a room
 * in use on the other instance.
 *
 * Needs `TEST_REDIS_URL` (a throwaway Redis: `docker run --rm -p 6379:6379 redis:7-alpine`,
 * CI's `db-tests` job has one). Without it the file is skipped locally and fails in CI.
 * Not `REDIS_URL`: the other db tests read their config from defaults, never from Redis.
 */
import { performance } from "node:perf_hooks";
import { apply, type Command, createRoom, type RoomState } from "@pp/domain";
import type { Snapshot } from "@pp/protocol";
import { cardLeaks } from "@pp/protocol/leak-scan";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Config } from "../config.ts";
import { createTestDatabase, type TestDatabase } from "../db/test-db.ts";
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
let config: Config;
const instances: Instance[] = [];
const clients: TestClient[] = [];
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
      const code = await insert(withDeadline(state, Date.now() + 500));
      // Everyone holds a socket, so no presence change moves the version.
      const pages = [client(cy, one()), client(ada, two()), client(cy, two()), client(bob, one())];
      await Promise.all(pages.map((page) => page.enter(code)));
      for (const page of pages) await page.waitFor((s) => s.room.round?.phase === "revealed");
      await sleep(300);
      for (const page of pages) {
        expectEachVersionOnce(page);
        expect(reveals(page)).toEqual([{ type: "revealed", by: "timer" }]);
      }
      expect((await stored(code))?.version).toBe(2);
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
      await Promise.all([bobHere.enter(code), bobThere.enter(code)]);
      const cyAway = await a.waitFor(
        (s) => s.room.participants.some((p) => p.id === cy.id && !p.connected),
        3000,
      );
      expect(cyAway.snapshot.room.participants.find((p) => p.id === ada.id)?.connected).toBe(true);
      // The second instance's restart graces run out too, and store nothing for Ada.
      await sleep(GRACE_MS * 2);
      const settled = (await stored(code))?.version ?? 0;

      bobHere.close();
      await sleep(GRACE_MS * 3);
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
