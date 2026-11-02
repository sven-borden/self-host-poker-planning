/**
 * The queue (#52) against Postgres with real guests and the real handshake: who may read the
 * list, a paste as one command on one socket message, what a snapshot carries on the raw
 * frames, a full queue through the compare-and-set while a room votes, a redeploy, the
 * PO's hand-over, the history of a round started from the queue, and the room's end.
 */
import {
  apply,
  type Command,
  createRoom,
  MAX_QUEUE_ITEMS,
  type QueueEntry,
  type RoomState,
} from "@pp/domain";
import { queueAckSchema, snapshotSchema } from "@pp/protocol";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Config } from "../config.ts";
import { createTestDatabase, testClient as sqlClient, type TestDatabase } from "../db/test-db.ts";
import { MAX_PAYLOAD_BYTES } from "../realtime.ts";
import { createServer, type PokerServer } from "../server.ts";
import { setupServer } from "../setup.ts";
import { collectLogs, testConfig, VALID_ENV } from "../test-support.ts";
import {
  frameArgs,
  type Guest,
  roomCode,
  signInGuest,
  type TestClient,
  testClient,
} from "./test-support.ts";

const ORIGIN = VALID_ENV.BASE_URL;
const logs = collectLogs("debug");
const UNLIMITED = { perSecond: 1e6, burst: 1e6 };

type Instance = Awaited<ReturnType<typeof setupServer>> & { server: PokerServer; base: string };

let t: TestDatabase;
let config: Config;
let instance: Instance;
const clients: TestClient[] = [];
let ada: Guest;
let bob: Guest;
let dan: Guest;

async function start(): Promise<Instance> {
  const setup = await setupServer(config, logs.logger);
  const server = createServer(config, {
    ...setup.deps,
    logger: logs.logger,
    realtimeLimits: { messageLimit: UNLIMITED, rosterLimit: UNLIMITED, historyLimit: UNLIMITED },
  });
  const { port } = await server.listen();
  return { ...setup, server, base: `http://localhost:${port}` };
}

beforeAll(async () => {
  t = await createTestDatabase();
  config = testConfig({ DATABASE_URL: t.url });
  instance = await start();
  const guest = () => signInGuest(instance.base, ORIGIN);
  [ada, bob, dan] = await Promise.all([guest(), guest(), guest()]);
});

afterEach(() => {
  for (const client of clients.splice(0)) client.close();
});

afterAll(async () => {
  await instance?.server.close();
  await instance?.dispose?.();
  await t?.drop();
});

function client(guest: Guest): TestClient {
  const c = testClient(instance.base, { cookie: guest.cookie });
  clients.push(c);
  return c;
}

function step(state: RoomState, actor: string, command: Command): RoomState {
  const result = apply(state, command, { actor, now: Date.now() });
  if (!result.ok) throw new Error(`fixture refused: ${result.error}`);
  return result.state;
}

/** Ada (PO) and Bob vote; Dan is not in the room. */
async function room(): Promise<string> {
  let s = createRoom({ ownerId: ada.id });
  s = step(s, ada.id, { type: "join", name: "Ada", role: "voter" });
  s = step(s, bob.id, { type: "join", name: "Bob", role: "voter" });
  const code = roomCode();
  const stored = await instance.database.store.insertRoom({ code, name: null, state: s });
  if (!stored) throw new Error("code taken");
  return code;
}

const ticket = (n: number): QueueEntry => ({
  key: `PAY-${n}`,
  title: `Ticket number ${n} with a title of a fair length, as most of them are`,
  url: `https://acme.atlassian.net/browse/PAY-${n}`,
});

const tickets = (count: number) => Array.from({ length: count }, (_, n) => ticket(n + 1));

/** The raw `queue` request, its answer checked against the strict schema. */
async function readQueue(c: TestClient) {
  const raw = c.socket as unknown as {
    timeout(ms: number): { emitWithAck(event: string, ...args: unknown[]): Promise<unknown> };
  };
  return queueAckSchema.parse(await raw.timeout(5000).emitWithAck("queue", {}));
}

async function storedRoom(code: string) {
  const sql = sqlClient(t.url);
  try {
    const { rows } = await sql.query(
      "select live, queue, pg_column_size(live) as live_bytes from room where code = $1",
      [code],
    );
    return rows[0];
  } finally {
    await sql.end();
  }
}

describe("the list", () => {
  it("goes to the PO alone, on a fresh load at every request", async () => {
    const code = await room();
    const po = client(ada);
    const voter = client(bob);
    const visitor = client(dan);
    await po.enter(code);
    await voter.enter(code);
    await visitor.enter(code);
    expect((await po.cmd("queueAdd", { items: tickets(3) })).ok).toBe(true);
    const read = await readQueue(po);
    expect(read).toMatchObject({ ok: true, rev: 1 });
    expect(read.ok && read.items.map((item) => item.key)).toEqual(["PAY-1", "PAY-2", "PAY-3"]);
    expect(await readQueue(voter)).toEqual({ ok: false, code: "not_owner" });
    expect(await readQueue(visitor)).toEqual({ ok: false, code: "not_owner" });
    // A hand-over hands over the queue, at once.
    expect((await po.cmd("transferOwner", { to: bob.id })).ok).toBe(true);
    expect(await readQueue(po)).toEqual({ ok: false, code: "not_owner" });
    const handed = await readQueue(voter);
    expect(handed.ok && handed.items).toHaveLength(3);
  });

  it("refuses a socket that entered no room", async () => {
    expect(await readQueue(client(dan))).toEqual({ ok: false, code: "room_not_found" });
  });

  it("leaves no title or link in the logs", async () => {
    const code = await room();
    const po = client(ada);
    await po.enter(code);
    const items = [{ key: "PAY-9", title: "Secret-sounding title", url: "https://x.test/secret" }];
    await po.cmd("queueAdd", { items });
    await readQueue(po);
    const written = JSON.stringify(logs.lines);
    expect(written).not.toContain("Secret-sounding");
    expect(written).not.toContain("x.test/secret");
    expect(written).not.toContain(code);
  });
});

describe("a paste", () => {
  it("is one command on one message, even 500 ordinary tickets", async () => {
    const code = await room();
    const po = client(ada);
    const voter = client(bob);
    await po.enter(code);
    await voter.enter(code);
    const items = tickets(MAX_QUEUE_ITEMS);
    expect(new TextEncoder().encode(JSON.stringify(items)).length).toBeLessThan(MAX_PAYLOAD_BYTES);
    const ack = await po.cmd("queueAdd", { items });
    expect(ack).toMatchObject({ ok: true });
    const { snapshot } = await voter.waitFor((s) => s.room.queue !== undefined);
    expect(snapshot.room.queue).toEqual({
      count: MAX_QUEUE_ITEMS,
      rev: 1,
      next: { id: 1, key: "PAY-1" },
    });
    expect(snapshot.causes).toEqual([{ type: "queueChanged", added: MAX_QUEUE_ITEMS }]);
    expect(await po.cmd("queueAdd", { items: [{ title: "One too many" }] })).toEqual({
      ok: false,
      code: "queue_full",
    });
  });

  it("is refused whole for one bad link, and nothing is stored", async () => {
    const code = await room();
    const po = client(ada);
    await po.enter(code);
    const items = [{ title: "fine" }, { url: "javascript:alert(1)" }];
    expect(await po.cmd("queueAdd", { items })).toEqual({ ok: false, code: "bad_queue_item" });
    expect((await storedRoom(code))?.queue).toBeNull();
  });

  it("is not the voter's to send", async () => {
    const code = await room();
    const voter = client(bob);
    await voter.enter(code);
    expect(await voter.cmd("queueAdd", { items: tickets(1) })).toEqual({
      ok: false,
      code: "not_owner",
    });
  });
});

describe("the frames", () => {
  it("carry the next item and a count, never another item's title", async () => {
    const code = await room();
    const po = client(ada);
    const voter = client(bob);
    await po.enter(code);
    await voter.enter(code);
    await po.cmd("queueAdd", { items: tickets(20) });
    await voter.waitFor((s) => s.room.queue?.count === 20);
    await po.cmd("startRound", { subject: { kind: "none" } });
    await po.cmd("castVote", { card: "5", round: 1 });
    await voter.cmd("castVote", { card: "5", round: 1 });
    await voter.waitFor((s) => s.room.round?.phase === "revealed");
    const sent = voter.frames.join("\n");
    expect(sent).not.toContain("Ticket number");
    expect(sent).not.toContain("atlassian.net");
    expect(sent).not.toContain("PAY-2");
    expect(sent).toContain("PAY-1");
    for (const frame of voter.frames) {
      const [event, payload] = frameArgs(frame);
      if (event === "snapshot") expect(snapshotSchema.safeParse(payload).success).toBe(true);
    }
  });
});

describe("a full queue through the compare-and-set", () => {
  it("leaves `live` its old size and survives a round of votes unchanged", async () => {
    const code = await room();
    const po = client(ada);
    const voter = client(bob);
    await po.enter(code);
    await voter.enter(code);
    const small = (await storedRoom(code))?.live_bytes;
    await po.cmd("queueAdd", { items: tickets(MAX_QUEUE_ITEMS) });
    const stored = await storedRoom(code);
    expect(stored?.live).not.toHaveProperty("queue");
    expect(stored?.live_bytes).toBe(small);
    expect(stored?.queue.items).toHaveLength(MAX_QUEUE_ITEMS);

    await po.cmd("startRound", { subject: { kind: "none" } });
    const acks = await Promise.all([
      po.cmd("castVote", { card: "5", round: 1 }),
      voter.cmd("castVote", { card: "8", round: 1 }),
    ]);
    expect(acks.map((ack) => ack.ok)).toEqual([true, true]);
    const after = await storedRoom(code);
    expect(after?.queue).toEqual(stored?.queue);
    expect(after?.live.round.phase).toBe("revealed");
  });
});

describe("a round from the queue", () => {
  it("records its subject as any other, with its title, and leaves the rest waiting", async () => {
    const code = await room();
    const po = client(ada);
    const voter = client(bob);
    await po.enter(code);
    await voter.enter(code);
    await po.cmd("queueAdd", { items: tickets(2) });
    expect((await po.cmd("startNext", { id: 1 })).ok).toBe(true);
    const { snapshot } = await voter.waitFor((s) => s.room.round !== null);
    expect(snapshot.room.round?.subject).toEqual({ kind: "link", ...ticket(1) });
    expect(snapshot.room.queue?.next.key).toBe("PAY-2");
    await po.cmd("castVote", { card: "5", round: 1 });
    await voter.cmd("castVote", { card: "5", round: 1 });
    await voter.waitFor((s) => s.room.round?.phase === "revealed");
    expect((await po.cmd("setFinal", { card: "5" })).ok).toBe(true);
    expect((await po.cmd("startNext", { id: 2 })).ok).toBe(true);
    const page = await po.history();
    expect(page.ok && page.rounds[0]?.subject).toEqual({ kind: "link", ...ticket(1) });
    expect(page.ok && page.rounds[0]?.final).toBe("5");
  });
});

describe("a redeploy", () => {
  it("keeps the queue and its order", async () => {
    const code = await room();
    const po = client(ada);
    await po.enter(code);
    await po.cmd("queueAdd", { items: tickets(3) });
    await po.cmd("queueMove", { id: 3, to: 0 });
    po.close();
    await instance.server.close();
    await instance.dispose?.();
    instance = await start();
    const back = client(ada);
    const entered = await back.enter(code);
    expect(entered.ok && entered.snapshot.room.queue?.next.key).toBe("PAY-3");
    const read = await readQueue(back);
    expect(read.ok && read.items.map((item) => item.id)).toEqual([3, 1, 2]);
  });
});

describe("the room's end", () => {
  it("takes the queue with it: it is a column of the room's row", async () => {
    const code = await room();
    const po = client(ada);
    await po.enter(code);
    await po.cmd("queueAdd", { items: tickets(2) });
    const sql = sqlClient(t.url);
    try {
      await sql.query("delete from room where code = $1", [code]);
      const { rows } = await sql.query("select count(*)::int as n from room where queue is null");
      expect(typeof rows[0].n).toBe("number");
    } finally {
      await sql.end();
    }
    expect(await instance.database.store.loadRoom(code)).toBeNull();
  });
});
