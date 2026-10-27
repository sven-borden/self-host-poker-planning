/**
 * The room sync over real sockets, on an in-memory store and the real runner: enter,
 * commands and their acks, per-viewer broadcasts, idempotency, `busy`, a lost reply, kick,
 * the deadline timeout, the message limit and the session check. Against Postgres, with
 * real identity, see `room-sync.db.test.ts`.
 */
import { createRoom, type RoomState } from "@pp/domain";
import { afterEach, describe, expect, it } from "vitest";
import { play } from "../db/fixtures.ts";
import { createCommandRunner } from "../db/runner.ts";
import { createServer, type PokerServer } from "../server.ts";
import { collectLogs, type LogCollector, testConfig } from "../test-support.ts";
import { createRoomSync, type RoomSync } from "./room-sync.ts";
import {
  fakeIdentity,
  type MemoryRoomStore,
  memoryRoomStore,
  type TestClient,
  testClient,
  withDeadline,
} from "./test-support.ts";

const CODE = "RoomCode12";
const open: { server: PokerServer; clients: TestClient[]; sync: RoomSync }[] = [];

afterEach(async () => {
  for (const { server, clients, sync } of open.splice(0)) {
    for (const client of clients) client.close();
    sync.close();
    await server.close();
  }
});

interface Started {
  store: MemoryRoomStore;
  sync: RoomSync;
  logs: LogCollector;
  client(user: string): TestClient;
}

async function start(
  state: RoomState | null,
  options: { sessionAlive?: (id: string) => Promise<boolean> } = {},
): Promise<Started> {
  const logs = collectLogs();
  const store = memoryRoomStore();
  if (state) await store.insertRoom({ code: CODE, name: null, state });
  const sync = createRoomSync({
    runner: createCommandRunner(store),
    store,
    logger: logs.logger,
    ...options,
  });
  const server = createServer(testConfig(), {
    logger: logs.logger,
    handlers: sync,
    socketMiddleware: [fakeIdentity],
  });
  const { port } = await server.listen();
  const entry = { server, clients: [] as TestClient[], sync };
  open.push(entry);
  return {
    store,
    sync,
    logs,
    client: (user) => {
      const client = testClient(`http://localhost:${port}`, { user });
      entry.clients.push(client);
      return client;
    },
  };
}

/** Ada (PO, ua) and Bob (ub) in the lobby. */
function lobby(): RoomState {
  let s = createRoom({ ownerId: "ua" });
  s = play(s, "ua", { type: "join", name: "Ada", role: "voter" });
  return play(s, "ub", { type: "join", name: "Bob", role: "voter" }, 1);
}

/** `lobby` with a voting round started; Cy (uc) joins as an observer. */
function voting(): RoomState {
  let s = play(lobby(), "uc", { type: "join", name: "Cy", role: "observer" }, 2);
  s = play(s, "ua", { type: "startRound", subject: { kind: "none" } }, 3);
  return s;
}

describe("enter", () => {
  it("answers the viewer's snapshot, a stranger's too, and room_not_found for an unknown code", async () => {
    const { client } = await start(lobby());
    const ada = client("ua");
    const stranger = client("uz");
    const ack = await ada.enter(CODE);
    expect(ack.ok && ack.snapshot.room.you).toBe("ua");
    expect(ack.ok && ack.snapshot.version).toBe(1);
    expect(ack.ok && ack.snapshot.causes).toEqual([]);
    const other = await stranger.enter(CODE);
    expect(other.ok && other.snapshot.room.you).toBeNull();
    expect(other.ok && other.snapshot.room.participants).toHaveLength(2);
    expect(await ada.enter("NoSuchRoom")).toEqual({ ok: false, code: "room_not_found" });
  });

  it("answers protocol_mismatch to another protocol version", async () => {
    const { client } = await start(lobby());
    expect(await client("ua").enter(CODE, 1)).toEqual({ ok: false, code: "protocol_mismatch" });
  });

  it("answers unauthenticated once the socket's session is gone, and stops the feed", async () => {
    let alive = true;
    const { client } = await start(lobby(), { sessionAlive: async () => alive });
    const ada = client("ua");
    const bob = client("ub");
    expect((await ada.enter(CODE)).ok).toBe(true);
    await bob.enter(CODE);
    alive = false;
    expect(await ada.enter(CODE)).toEqual({ ok: false, code: "unauthenticated" });
    alive = true;
    const before = ada.received.length;
    expect((await bob.cmd("rename", { name: "Bobby" })).ok).toBe(true);
    await bob.waitFor((s) => s.version === 2);
    expect(ada.received.length).toBe(before);
  });
});

describe("cmd", () => {
  it("broadcasts each socket its own snapshot with the causes, and acks the version", async () => {
    const { client } = await start(lobby());
    const ada = client("ua");
    const cy = client("uc");
    await ada.enter(CODE);
    await cy.enter(CODE);
    const ack = await cy.cmd("join", { name: "Cy", role: "observer" });
    expect(ack).toEqual({ ok: true, version: 2 });
    const seen = await ada.waitFor((s) => s.version === 2);
    expect(seen.snapshot.causes).toEqual([{ type: "joined", who: "uc" }]);
    expect(seen.snapshot.room.you).toBe("ua");
    expect(cy.latest()?.room.you).toBe("uc");
  });

  it("answers room_not_found before enter, and the domain's code for a refused command", async () => {
    const { client } = await start(lobby());
    const bob = client("ub");
    expect(await bob.cmd("reveal")).toEqual({ ok: false, code: "room_not_found" });
    await bob.enter(CODE);
    expect(await bob.cmd("startRound", { subject: { kind: "none" } })).toEqual({
      ok: false,
      code: "not_owner",
    });
    expect(await bob.cmd("castVote", { card: 5 })).toEqual({ ok: false, code: "bad_payload" });
  });

  it("applies a command id once, sent twice at once or again later", async () => {
    const { client, store } = await start(voting());
    const bob = client("ub");
    await bob.enter(CODE);
    const [first, second] = await Promise.all([
      bob.cmd("castVote", { card: "5" }, "same-id"),
      bob.cmd("castVote", { card: "5" }, "same-id"),
    ]);
    expect(first).toEqual({ ok: true, version: 2 });
    expect(second).toEqual(first);
    // A retract in between, then the vote's id again: still the first answer, no new vote.
    expect(await bob.cmd("retractVote")).toEqual({ ok: true, version: 3 });
    expect(await bob.cmd("castVote", { card: "5" }, "same-id")).toEqual(first);
    expect(store.commits).toBe(2);
    expect(store.rooms.get(CODE)?.state.round?.votes).toEqual({});
  });

  it("answers busy when every attempt loses the compare-and-set, and lets the same id run again", async () => {
    const { client, store } = await start(voting());
    const bob = client("ub");
    await bob.enter(CODE);
    store.fate = () => "lose";
    expect(await bob.cmd("castVote", { card: "8" }, "retry-me")).toEqual({
      ok: false,
      code: "busy",
    });
    store.fate = () => "store";
    expect(await bob.cmd("castVote", { card: "8" }, "retry-me")).toEqual({ ok: true, version: 2 });
  });

  it("after a commit whose reply was lost, acks internal and sends everyone the stored room", async () => {
    const { client, store, logs } = await start(voting());
    const ada = client("ua");
    const bob = client("ub");
    await ada.enter(CODE);
    await bob.enter(CODE);
    store.fate = () => "store-then-fail";
    expect(await bob.cmd("castVote", { card: "13" })).toEqual({ ok: false, code: "internal" });
    const seen = await ada.waitFor((s) => s.version === 2);
    expect(seen.snapshot.room.round?.voted).toEqual(["ub"]);
    expect(seen.snapshot.causes).toEqual([]);
    expect((await bob.waitFor((s) => s.version === 2)).snapshot.room.round?.yourVote).toBe("13");
    expect(store.commits).toBe(1);
    expect(logs.messages()).toContain("command failed in the database");
    // Neither the card nor the payload reaches a log line.
    expect(logs.raw.filter((line) => line.includes('"13"'))).toEqual([]);
  });

  it("acks internal when the database fails before writing, without a broadcast", async () => {
    const { client, store } = await start(voting());
    const ada = client("ua");
    const bob = client("ub");
    await ada.enter(CODE);
    await bob.enter(CODE);
    store.fate = () => "fail";
    expect(await bob.cmd("castVote", { card: "3" })).toEqual({ ok: false, code: "internal" });
    expect(ada.received).toHaveLength(1);
  });

  it("tells a kicked person's sockets and closes them", async () => {
    const { client } = await start(lobby());
    const ada = client("ua");
    const bob = client("ub");
    await ada.enter(CODE);
    await bob.enter(CODE);
    const closed = new Promise<string>((resolve) => bob.socket.on("disconnect", resolve));
    expect((await ada.cmd("kick", { who: "ub" })).ok).toBe(true);
    expect(await closed).toBe("io server disconnect");
    expect(bob.kicked.count).toBe(1);
  });

  it("answers rate_limited past the bucket and keeps the socket and the room working", async () => {
    const { client } = await start(voting());
    const bob = client("ub");
    await bob.enter(CODE);
    const acks = await Promise.all(
      Array.from({ length: 40 }, () => bob.cmd("castVote", { card: "5" })),
    );
    const limited = acks.filter((a) => !a.ok && a.code === "rate_limited").length;
    expect(limited).toBeGreaterThanOrEqual(15);
    expect(acks.filter((a) => a.ok).length).toBe(40 - limited);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect((await bob.cmd("retractVote")).ok).toBe(true);
    expect(bob.socket.connected).toBe(true);
  });
});

describe("the deadline", () => {
  it("reveals at the deadline with no client action, once", async () => {
    const state = play(voting(), "ub", { type: "castVote", card: "5" }, 4);
    const { client, store, sync } = await start(withDeadline(state, Date.now() + 200));
    const ada = client("ua");
    const cy = client("uc");
    await ada.enter(CODE);
    await cy.enter(CODE);
    expect(sync.deadlines.armed(CODE)).toBeDefined();
    const seen = await cy.waitFor((s) => s.room.round?.phase === "revealed", 3000);
    expect(seen.snapshot.causes).toEqual([{ type: "revealed", by: "timer" }]);
    await ada.waitFor((s) => s.room.round?.phase === "revealed");
    expect(store.commits).toBe(1);
    expect(sync.deadlines.armed(CODE)).toBeUndefined();
  });

  it("follows a timer started, then forgets it when the room's last socket leaves", async () => {
    const { client, sync } = await start(voting());
    const ada = client("ua");
    await ada.enter(CODE);
    expect(sync.deadlines.armed(CODE)).toBeUndefined();
    expect((await ada.cmd("startTimer", { seconds: 60 })).ok).toBe(true);
    await ada.waitFor((s) => s.room.round?.deadlineAt !== undefined);
    expect(sync.deadlines.armed(CODE)).toBe(ada.latest()?.room.round?.deadlineAt);
    const gone = new Promise((resolve) => setTimeout(resolve, 100));
    ada.close();
    await gone;
    expect(sync.deadlines.armed(CODE)).toBeUndefined();
  });
});
