/**
 * The room sync over real sockets, on an in-memory store and the real runner: enter,
 * commands and their acks, per-viewer broadcasts, idempotency, `busy`, a lost reply, kick,
 * the deadline timeout, the message limit, the session check, concurrent enters on one
 * socket, and room codes kept out of the logs. Against Postgres, with real identity, see
 * `room-sync.db.test.ts`.
 */
import { createRoom, type RoomState } from "@pp/domain";
import { PROTOCOL_VERSION } from "@pp/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DatabaseError } from "../db/errors.ts";
import { play } from "../db/fixtures.ts";
import type { StoredHistoryRound } from "../db/history.ts";
import type { HistoryQuery, HistoryStore } from "../db/rooms.ts";
import { createCommandRunner } from "../db/runner.ts";
import { createServer, type PokerServer } from "../server.ts";
import { collectLogs, type LogCollector, testConfig } from "../test-support.ts";
import { channelOf, createRoomSync, type RoomSync, SESSION_RECHECK_MS } from "./room-sync.ts";
import {
  fakeIdentity,
  type MemoryRoomStore,
  memoryRoomStore,
  type TestClient,
  testClient,
  withDeadline,
} from "./test-support.ts";

const CODE = "RoomCode12";
/** The id `memoryRoomStore` gave a room. */
function idOf(store: MemoryRoomStore, code = CODE): string {
  const id = store.rooms.get(code)?.id;
  if (id === undefined) throw new Error("no such room");
  return id;
}
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
  server: PokerServer;
  logs: LogCollector;
  client(user: string): TestClient;
}

interface StartOptions {
  sessionAlive?: (id: string) => Promise<boolean>;
  now?: () => number;
  touchRoom?: (roomId: string) => Promise<void>;
  /** Runs before every load of a room (enter, the runner, a reload): may wait or throw. */
  beforeLoad?: (code: string) => Promise<void> | void;
  history?: Pick<HistoryStore, "loadHistory">;
}

async function start(
  state: RoomState | null,
  { beforeLoad, ...options }: StartOptions = {},
): Promise<Started> {
  const logs = collectLogs("debug");
  const store = memoryRoomStore();
  if (state) await store.insertRoom({ code: CODE, name: null, state });
  if (beforeLoad) {
    const load = store.loadRoom;
    store.loadRoom = async (code) => {
      await beforeLoad(code);
      return load(code);
    };
  }
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
    server,
    logs,
    client: (user) => {
      const client = testClient(`http://localhost:${port}`, { user });
      entry.clients.push(client);
      return client;
    },
  };
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

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
    expect(await client("ua").enter(CODE, PROTOCOL_VERSION + 1)).toEqual({
      ok: false,
      code: "protocol_mismatch",
    });
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

  it("records a visit for the retention purge, and a failed one only logs", async () => {
    const touched: string[] = [];
    let fail = false;
    const { client, store, logs } = await start(lobby(), {
      touchRoom: async (id) => {
        touched.push(id);
        if (fail) throw new DatabaseError("touch room", "57P01");
      },
    });
    const ada = client("ua");
    expect((await ada.enter(CODE)).ok).toBe(true);
    expect(touched).toEqual([idOf(store)]);
    expect((await ada.enter("NoSuchRoom")).ok).toBe(false);
    expect(touched).toHaveLength(1);
    fail = true;
    expect((await client("ub").enter(CODE)).ok).toBe(true);
    await vi.waitFor(() => expect(logs.messages()).toContain("visit not recorded"));
    expect(logs.lines.find((line) => line.msg === "visit not recorded")).toMatchObject({
      room: idOf(store),
      err: "57P01",
    });
  });

  it("names the rooms with a socket on this instance, and forgets a room left empty", async () => {
    const { client, store, sync } = await start(lobby());
    expect(await sync.occupiedRooms()).toEqual([]);
    const ada = client("ua");
    await ada.enter(CODE);
    expect(await sync.occupiedRooms()).toEqual([idOf(store)]);
    ada.close();
    await vi.waitFor(async () => expect(await sync.occupiedRooms()).toEqual([]));
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
    expect(await bob.cmd("castVote", { card: 5, round: 1, restart: 0 })).toEqual({
      ok: false,
      code: "bad_payload",
    });
  });

  it("applies a command id once, sent twice at once or again later", async () => {
    const { client, store } = await start(voting());
    const bob = client("ub");
    await bob.enter(CODE);
    const [first, second] = await Promise.all([
      bob.cmd("castVote", { card: "5", round: 1, restart: 0 }, "same-id"),
      bob.cmd("castVote", { card: "5", round: 1, restart: 0 }, "same-id"),
    ]);
    expect(first).toEqual({ ok: true, version: 2 });
    expect(second).toEqual(first);
    // A retract in between, then the vote's id again: still the first answer, no new vote.
    expect(await bob.cmd("retractVote", { round: 1, restart: 0 })).toEqual({
      ok: true,
      version: 3,
    });
    expect(await bob.cmd("castVote", { card: "5", round: 1, restart: 0 }, "same-id")).toEqual(
      first,
    );
    expect(store.commits).toBe(2);
    expect(store.rooms.get(CODE)?.state.round?.votes).toEqual({});
  });

  it("answers busy when every attempt loses the compare-and-set, and lets the same id run again", async () => {
    const { client, store } = await start(voting());
    const bob = client("ub");
    await bob.enter(CODE);
    store.fate = () => "lose";
    expect(await bob.cmd("castVote", { card: "8", round: 1, restart: 0 }, "retry-me")).toEqual({
      ok: false,
      code: "busy",
    });
    store.fate = () => "store";
    expect(await bob.cmd("castVote", { card: "8", round: 1, restart: 0 }, "retry-me")).toEqual({
      ok: true,
      version: 2,
    });
  });

  it("after a commit whose reply was lost, acks internal and sends everyone the stored room", async () => {
    const { client, store, logs } = await start(voting());
    const ada = client("ua");
    const bob = client("ub");
    await ada.enter(CODE);
    await bob.enter(CODE);
    store.fate = () => "store-then-fail";
    expect(await bob.cmd("castVote", { card: "13", round: 1, restart: 0 })).toEqual({
      ok: false,
      code: "internal",
    });
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
    expect(await bob.cmd("castVote", { card: "3", round: 1, restart: 0 })).toEqual({
      ok: false,
      code: "internal",
    });
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
      Array.from({ length: 40 }, () => bob.cmd("castVote", { card: "5", round: 1, restart: 0 })),
    );
    const limited = acks.filter((a) => !a.ok && a.code === "rate_limited").length;
    expect(limited).toBeGreaterThanOrEqual(15);
    expect(acks.filter((a) => a.ok).length).toBe(40 - limited);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect((await bob.cmd("retractVote", { round: 1, restart: 0 })).ok).toBe(true);
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
    expect(sync.deadlines.armed(idOf(store))).toBeDefined();
    const seen = await cy.waitFor((s) => s.room.round?.phase === "revealed", 3000);
    expect(seen.snapshot.causes).toEqual([{ type: "revealed", by: "timer" }]);
    await ada.waitFor((s) => s.room.round?.phase === "revealed");
    expect(store.commits).toBe(1);
    expect(sync.deadlines.armed(idOf(store))).toBeUndefined();
  });

  it("follows a timer started, then forgets it when the room's last socket leaves", async () => {
    const { client, store, sync } = await start(voting());
    const ada = client("ua");
    await ada.enter(CODE);
    expect(sync.deadlines.armed(idOf(store))).toBeUndefined();
    expect((await ada.cmd("startTimer", { seconds: 60 })).ok).toBe(true);
    await ada.waitFor((s) => s.room.round?.deadlineAt !== undefined);
    expect(sync.deadlines.armed(idOf(store))).toBe(ada.latest()?.room.round?.deadlineAt);
    const gone = new Promise((resolve) => setTimeout(resolve, 100));
    ada.close();
    await gone;
    expect(sync.deadlines.armed(idOf(store))).toBeUndefined();
  });
});

describe("one room per socket", () => {
  const A = "RoomSlowAA";
  const B = "RoomQuickB";

  it("runs two enters sent at once one after the other: the socket ends in the second room only", async () => {
    // Room A loads slowly and is at version 9; room B is at version 1.
    const { client, store, server } = await start(null, {
      beforeLoad: (code) => (code === A ? sleep(80) : undefined),
    });
    let a = lobby();
    await store.insertRoom({ code: A, name: null, state: a });
    for (let n = 0; n < 8; n++) {
      a = play(a, "ua", { type: "rename", name: `Ada ${n}` });
      const room = store.rooms.get(A);
      if (room) store.rooms.set(A, { ...room, version: room.version + 1, state: a });
    }
    await store.insertRoom({ code: B, name: null, state: createRoom({ ownerId: "ub" }) });
    const x = client("ux");
    const bob = client("ub");
    const ada = client("ua");
    await bob.enter(B);
    await ada.enter(A);

    const [ackA, ackB] = await Promise.all([x.enter(A), x.enter(B)]);
    expect(ackA.ok && ackA.snapshot.version).toBe(9);
    expect(ackB.ok && ackB.snapshot.room.code).toBe(B);
    const rooms = server.io.sockets.adapter.rooms;
    expect(rooms.get(channelOf(idOf(store, A)))?.size).toBe(1);
    expect(rooms.get(channelOf(idOf(store, B)))?.size).toBe(2);

    // Three changes in B (versions 2 to 4) reach the socket; a change in A does not.
    const from = x.received.length;
    expect((await bob.cmd("join", { name: "Bob", role: "voter" })).ok).toBe(true);
    expect((await bob.cmd("rename", { name: "Bobby" })).ok).toBe(true);
    expect((await bob.cmd("rename", { name: "Bobo" })).ok).toBe(true);
    expect((await ada.cmd("rename", { name: "Ada again" })).ok).toBe(true);
    await x.waitFor((s) => s.room.code === B && s.version === 4, 2000, from);
    await sleep(50);
    const seen = x.received.slice(from).map(({ snapshot: s }) => `${s.room.code}@${s.version}`);
    expect(seen).toEqual([`${B}@2`, `${B}@3`, `${B}@4`]);
  });

  it("runs a command sent during an enter in the room entered, and refuses it after a failed one", async () => {
    const { client, store } = await start(lobby(), { beforeLoad: () => sleep(50) });
    const cy = client("uc");
    const [entered, joined] = await Promise.all([
      cy.enter(CODE),
      cy.cmd("join", { name: "Cy", role: "observer" }),
    ]);
    expect(entered.ok).toBe(true);
    expect(joined).toEqual({ ok: true, version: 2 });
    expect(store.rooms.get(CODE)?.state.participants.uc).toBeDefined();

    const dee = client("ud");
    const [refused, command] = await Promise.all([
      dee.enter("NoSuchRoom"),
      dee.cmd("join", { name: "Dee", role: "voter" }),
    ]);
    expect(refused).toEqual({ ok: false, code: "room_not_found" });
    expect(command).toEqual({ ok: false, code: "room_not_found" });
  });
});

describe("a session that ends while the socket stays open", () => {
  it("is checked again by a command once the last check is a minute old, then refused and closed", async () => {
    let alive = true;
    let checks = 0;
    let clock = Date.now();
    const { client } = await start(voting(), {
      now: () => clock,
      sessionAlive: async () => {
        checks += 1;
        return alive;
      },
    });
    const bob = client("ub");
    await bob.enter(CODE);
    expect(checks).toBe(1);
    alive = false;
    // Within the minute the enter's check still holds.
    expect((await bob.cmd("castVote", { card: "5", round: 1, restart: 0 })).ok).toBe(true);
    expect(checks).toBe(1);
    clock += SESSION_RECHECK_MS + 1;
    const closed = new Promise<string>((resolve) => bob.socket.on("disconnect", resolve));
    expect(await bob.cmd("retractVote", { round: 1, restart: 0 })).toEqual({
      ok: false,
      code: "unauthenticated",
    });
    expect(checks).toBe(2);
    // A transport close: the client reconnects, and the handshake refuses the old session.
    expect(await closed).toBe("transport close");
  });
});

describe("history (#33)", () => {
  const row = (number: number): StoredHistoryRound => ({
    number,
    subject: { kind: "none" },
    votes: { kind: "named", votes: [{ who: "ub", name: "Bob", card: "5" }] },
    stats: {
      distribution: [{ card: "5", count: 1 }],
      core: ["5"],
      mode: "5",
      agreement: 1,
      spread: ["5", "5"],
      consensus: false,
      average: 5,
      median: 5,
      suggested: "5",
    },
    final: null,
    startedAt: new Date(1_000),
    revealedAt: new Date(2_000),
    finishedAt: new Date(3_000),
  });

  it("refuses a socket outside the room and someone on the join form; a member reads an empty one", async () => {
    const { client } = await start(voting());
    const stranger = client("uz");
    expect(await stranger.history()).toEqual({ ok: false, code: "room_not_found" });
    await stranger.enter(CODE);
    expect(await stranger.history()).toEqual({ ok: false, code: "not_participant" });
    const cy = client("uc");
    await cy.enter(CODE);
    expect(await cy.history()).toEqual({ ok: true, rounds: [] });
  });

  it("asks for 20 rounds below the cursor without the table's round, sends no id, and gives the next cursor", async () => {
    const queries: HistoryQuery[] = [];
    const { client } = await start(voting(), {
      history: {
        loadHistory: async (_id, query) => {
          queries.push(query);
          return { rounds: [row(9), row(8)], more: query.before === undefined };
        },
      },
    });
    const ada = client("ua");
    await ada.enter(CODE);
    const first = await ada.history();
    expect(first).toEqual({
      ok: true,
      rounds: [
        expect.objectContaining({
          number: 9,
          votes: { kind: "named", votes: [{ name: "Bob", card: "5" }] },
        }),
        expect.objectContaining({
          number: 8,
          startedAt: 1_000,
          revealedAt: 2_000,
          finishedAt: 3_000,
        }),
      ],
      next: 8,
    });
    expect(await ada.history({ before: 8, limit: 2 })).toEqual({
      ok: true,
      rounds: [expect.objectContaining({ number: 9 }), expect.objectContaining({ number: 8 })],
    });
    expect(queries).toEqual([
      { before: undefined, limit: 20, exclude: 1 },
      { before: 8, limit: 2, exclude: 1 },
    ]);
  });

  it("answers internal when the database fails, and logs the room by its id", async () => {
    const { client, store, logs } = await start(voting(), {
      history: {
        loadHistory: async () => {
          throw new DatabaseError("load history", "57P01");
        },
      },
    });
    const ada = client("ua");
    await ada.enter(CODE);
    expect(await ada.history()).toEqual({ ok: false, code: "internal" });
    const line = logs.lines.find((l) => l.msg === "history read failed in the database");
    expect(line).toMatchObject({ room: idOf(store), err: "57P01" });
  });

  it("waits for an enter in progress, and refuses once the session is gone", async () => {
    let alive = true;
    let clock = Date.now();
    const { client } = await start(voting(), { now: () => clock, sessionAlive: async () => alive });
    const bob = client("ub");
    await new Promise<void>((resolve) => bob.socket.once("connect", () => resolve()));
    const [entered, read] = await Promise.all([bob.enter(CODE), bob.history()]);
    expect(entered.ok).toBe(true);
    expect(read).toEqual({ ok: true, rounds: [] });
    alive = false;
    clock += SESSION_RECHECK_MS + 1;
    expect(await bob.history()).toEqual({ ok: false, code: "unauthenticated" });
  });
});

describe("room codes in the logs", () => {
  it("names a room by its id on every path that logs one, never by its code", async () => {
    let failLoads = false;
    const { client, store, logs } = await start(voting(), {
      beforeLoad: () => {
        if (failLoads) throw new DatabaseError("load room", "57P01");
      },
    });
    const ada = client("ua");
    expect((await ada.enter(CODE)).ok).toBe(true);
    // Every attempt loses: "command not run" (busy).
    store.fate = () => "lose";
    expect(await ada.cmd("castVote", { card: "5", round: 1, restart: 0 })).toEqual({
      ok: false,
      code: "busy",
    });
    // The commit fails, and so does the reload after it.
    store.fate = () => {
      failLoads = true;
      return "fail";
    };
    expect(await ada.cmd("castVote", { card: "5", round: 1, restart: 0 })).toEqual({
      ok: false,
      code: "internal",
    });
    failLoads = false;
    // The deadline: every attempt lost, then a failed timeUp, then the reveal.
    const room = store.rooms.get(CODE);
    if (!room) throw new Error("no room");
    store.rooms.set(CODE, {
      ...room,
      version: room.version + 1,
      state: withDeadline(room.state, Date.now() + 30),
    });
    store.fate = () => "lose";
    expect((await ada.enter(CODE)).ok).toBe(true);
    await vi.waitFor(() =>
      expect(logs.messages()).toContain("deadline: every attempt lost the compare-and-set"),
    );
    store.fate = () => "fail";
    await vi.waitFor(() => expect(logs.messages()).toContain("deadline: timeUp failed"));
    store.fate = () => "store";
    await ada.waitFor((s) => s.room.round?.phase === "revealed", 3000);

    const messages = logs.messages();
    for (const message of [
      "socket entered",
      "command not run",
      "command failed in the database",
      "room reload failed",
      "deadline: every attempt lost the compare-and-set",
      "deadline: timeUp failed",
    ]) {
      expect(messages).toContain(message);
      expect(logs.lines.find((line) => line.msg === message)?.room).toBe(idOf(store));
    }
    expect(logs.raw.filter((line) => line.includes(CODE))).toEqual([]);
  });
});
