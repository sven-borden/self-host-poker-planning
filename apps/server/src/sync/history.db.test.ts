/**
 * The history request (#33) against Postgres with real guests and the real handshake: who
 * may read it (a voter, an observer and the PO; not someone on the join form, a removed
 * person or anyone a password keeps out), the round on the table left out until the next
 * one starts, paging across 45 rounds, and AC 2 on the raw WebSocket frames: no history
 * frame carries a user id, and none of an anonymous round a name. The restart (AC 1) is
 * in `restart.db.test.ts`.
 */
import { apply, type Command, createRoom, type RoomState, type Subject } from "@pp/domain";
import { type HistoryAck, historyAckSchema } from "@pp/protocol";
import { historyLeaks } from "@pp/protocol/leak-scan";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Config } from "../config.ts";
import { createTestDatabase, type TestDatabase } from "../db/test-db.ts";
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

type Instance = Awaited<ReturnType<typeof setupServer>> & { server: PokerServer; base: string };

let t: TestDatabase;
let config: Config;
let instance: Instance;
const clients: TestClient[] = [];
let ada: Guest;
let bob: Guest;
let cy: Guest;
let dan: Guest;

beforeAll(async () => {
  t = await createTestDatabase();
  config = testConfig({ DATABASE_URL: t.url });
  const setup = await setupServer(config, logs.logger);
  const server = createServer(config, { ...setup.deps, logger: logs.logger });
  const { port } = await server.listen();
  instance = { ...setup, server, base: `http://localhost:${port}` };
  const guest = () => signInGuest(instance.base, ORIGIN);
  [ada, bob, cy, dan] = await Promise.all([guest(), guest(), guest(), guest()]);
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

let lastStep = 0;
function tick(): number {
  lastStep = Math.max(Date.now(), lastStep + 1);
  return lastStep;
}

function step(state: RoomState, actor: string, command: Command): RoomState {
  const result = apply(state, command, { actor, now: tick() });
  if (!result.ok) throw new Error(`fixture refused: ${result.error}`);
  return result.state;
}

/** Ada (PO) and Bob vote, Cy observes; Dan is not in the room. */
async function room({ anonymous = false, password = false } = {}): Promise<string> {
  let s = createRoom({ ownerId: ada.id });
  s = step(s, ada.id, { type: "join", name: "Ada", role: "voter" });
  s = step(s, bob.id, { type: "join", name: "Bob", role: "voter" });
  s = step(s, cy.id, { type: "join", name: "Cy", role: "observer" });
  if (anonymous) s = step(s, ada.id, { type: "updateSettings", patch: { revealNames: false } });
  if (password) s = step(s, ada.id, { type: "password", on: true });
  const code = roomCode();
  const stored = await instance.database.store.insertRoom({
    code,
    name: null,
    state: s,
    passwordHash: password ? HASH : null,
  });
  if (!stored) throw new Error("code taken");
  return code;
}

/** Stands in for an argon2id hash: the grants compare it as text. */
const HASH =
  "$argon2id$v=19$m=19456,t=2,p=1$c2FsdHNhbHRzYWx0c2FsdA$aGFzaGhhc2hoYXNoaGFzaGhhc2hoYXNoaGFzaGhhc2g";

/** Runs a command through the runner, as a socket's would (history rows included). */
async function play(code: string, actor: string, command: Command) {
  const outcome = await instance.database.runner.run(code, (state) =>
    apply(state, command, { actor, now: tick() }),
  );
  if (!outcome.ok || !outcome.result.ok) throw new Error(`fixture refused: ${command.type}`);
}

/** Starts a round and lets Ada and Bob vote: the last vote reveals it. */
async function round(code: string, number: number, cards: [string, string], subject?: Subject) {
  await play(code, ada.id, {
    type: "startRound",
    subject: subject ?? { kind: "title", text: `Story ${number}` },
  });
  await play(code, ada.id, { type: "castVote", card: cards[0], round: number });
  await play(code, bob.id, { type: "castVote", card: cards[1], round: number });
}

const numbers = (ack: HistoryAck) => (ack.ok ? ack.rounds.map((r) => r.number) : ack.code);

async function entered(guest: Guest, code: string): Promise<TestClient> {
  const c = client(guest);
  expect((await c.enter(code)).ok).toBe(true);
  return c;
}

describe("who reads the history", () => {
  it("a voter, an observer and the PO read it, newest first; the round on the table shows once the next starts", async () => {
    const code = await room();
    await round(code, 1, ["3", "5"]);
    await round(code, 2, ["8", "8"]);
    await round(code, 3, ["5", "8"]);
    // The PO records round 3's final: its row is written, but it is still on the table.
    await play(code, ada.id, { type: "setFinal", card: "5" });
    const readers = await Promise.all([ada, bob, cy].map((guest) => entered(guest, code)));
    for (const reader of readers) expect(numbers(await reader.history())).toEqual([2, 1]);
    const page = await readers[1]?.history();
    expect(page).toEqual({
      ok: true,
      rounds: [
        expect.objectContaining({
          number: 2,
          subject: { kind: "title", text: "Story 2" },
          final: null,
          votes: {
            kind: "named",
            votes: [
              { name: "Ada", card: "8" },
              { name: "Bob", card: "8" },
            ],
          },
          stats: expect.objectContaining({ suggested: "8", agreement: 1 }),
        }),
        expect.objectContaining({ number: 1 }),
      ],
    });
    const [second] = page?.ok ? page.rounds : [];
    expect(second && second.revealedAt >= second.startedAt).toBe(true);
    expect(second && second.finishedAt >= second.revealedAt).toBe(true);

    await play(code, ada.id, { type: "startRound", subject: { kind: "none" } });
    const after = await readers[2]?.history();
    expect(after && numbers(after)).toEqual([3, 2, 1]);
    expect(after?.ok && after.rounds[0]?.final).toBe("5");
  });

  it("refuses a socket that entered no room, someone on the join form, and a removed person", async () => {
    const code = await room();
    await round(code, 1, ["3", "5"]);
    await play(code, ada.id, { type: "startRound", subject: { kind: "none" } });

    const nowhere = client(dan);
    await new Promise<void>((resolve) => nowhere.socket.once("connect", () => resolve()));
    expect(await nowhere.history()).toEqual({ ok: false, code: "room_not_found" });
    const onForm = await entered(dan, code);
    expect(await onForm.history()).toEqual({ ok: false, code: "not_participant" });
    // Joining lets Dan read it.
    expect((await onForm.cmd("join", { name: "Dan", role: "observer" })).ok).toBe(true);
    expect(numbers(await onForm.history())).toEqual([1]);

    // The PO removes Bob: his socket closes, and the one he opens again is on the join form.
    const before = await entered(bob, code);
    const po = await entered(ada, code);
    const closed = new Promise<void>((resolve) =>
      before.socket.once("disconnect", () => resolve()),
    );
    expect((await po.cmd("kick", { who: bob.id })).ok).toBe(true);
    await closed;
    const again = await entered(bob, code);
    expect(await again.history()).toEqual({ ok: false, code: "not_participant" });
  });

  it("in a room with a password: anyone it keeps out has no room to read, a grant alone is the join form", async () => {
    const code = await room({ password: true });
    await round(code, 1, ["3", "5"]);
    await play(code, ada.id, { type: "startRound", subject: { kind: "none" } });
    const outside = client(dan);
    expect(await outside.enter(code)).toEqual({ ok: false, code: "password_required" });
    expect(await outside.history()).toEqual({ ok: false, code: "room_not_found" });

    const stored = await instance.database.store.loadRoom(code);
    expect(await instance.database.store.grantAccess(stored?.id ?? "", dan.id, HASH)).toBe(true);
    const granted = await entered(dan, code);
    expect(await granted.history()).toEqual({ ok: false, code: "not_participant" });
    const member = await entered(cy, code);
    expect(numbers(await member.history())).toEqual([1]);
  });

  it("answers bad_payload to a request the protocol refuses", async () => {
    const code = await room();
    const reader = await entered(ada, code);
    for (const request of [{ limit: 51 }, { before: 0 }, { page: 2 }, "all"]) {
      expect(await reader.history(request)).toEqual({ ok: false, code: "bad_payload" });
    }
  });
});

describe("paging (45 rounds)", () => {
  it("pages 20 at a time by round number, 50 at most, the table's round left out", async () => {
    const code = await room();
    for (let n = 1; n <= 45; n++) await round(code, n, n % 2 === 0 ? ["3", "5"] : ["8", "8"]);
    // Round 46 on the table: round 45 is history, 46 is not.
    await play(code, ada.id, { type: "startRound", subject: { kind: "none" } });
    const reader = await entered(cy, code);

    const first = await reader.history();
    expect(numbers(first)).toEqual(range(45, 26));
    expect(first.ok && first.next).toBe(26);
    const second = await reader.history({ before: 26 });
    expect(numbers(second)).toEqual(range(25, 6));
    expect(second.ok && second.next).toBe(6);
    const third = await reader.history({ before: 6 });
    expect(numbers(third)).toEqual(range(5, 1));
    expect(third.ok && "next" in third).toBe(false);

    const all = await reader.history({ limit: 50 });
    expect(numbers(all)).toEqual(range(45, 1));
    expect(all.ok && "next" in all).toBe(false);
    const sevens = await reader.history({ before: 10, limit: 7 });
    expect(numbers(sevens)).toEqual(range(9, 3));
    expect(sevens.ok && sevens.next).toBe(3);
    expect(numbers(await reader.history({ before: 1 }))).toEqual([]);
  }, 60_000);
});

describe("AC 2 on the wire", () => {
  it("no history frame carries a user id, and none of an anonymous round a name", async () => {
    const code = await room({ anonymous: true });
    await round(code, 1, ["8", "3"], {
      kind: "link",
      url: "https://acme.atlassian.net/browse/PAY-9",
    });
    await round(code, 2, ["5", "5"]);
    // Named from round 3 on.
    await play(code, ada.id, { type: "updateSettings", patch: { revealNames: true } });
    await round(code, 3, ["13", "8"]);
    await round(code, 4, ["1", "2"]);
    const readers = await Promise.all([ada, bob, cy].map((guest) => entered(guest, code)));
    const people = { ids: [ada.id, bob.id, cy.id], names: ["Ada", "Bob", "Cy"] };
    for (const reader of readers) {
      const from = reader.frames.length;
      const page = await reader.history();
      expect(numbers(page)).toEqual([3, 2, 1]);
      const answers = reader.frames
        .slice(from)
        .flatMap(frameArgs)
        .filter((arg) => historyAckSchema.safeParse(arg).success);
      expect(answers).toHaveLength(1);
      for (const answer of answers) expect(historyLeaks(answer, people)).toEqual([]);
      const frame = reader.frames.slice(from).join("");
      for (const id of people.ids) expect(frame).not.toContain(id);
      if (!page.ok) continue;
      expect(page.rounds.map((r) => r.votes.kind)).toEqual(["named", "anonymous", "anonymous"]);
      // Anonymous: the cards in the deck's order, never the order they were played.
      expect(page.rounds[2]?.votes).toEqual({ kind: "anonymous", cards: ["3", "8"] });
      expect(page.rounds[0]?.votes).toEqual({
        kind: "named",
        votes: [
          { name: "Ada", card: "13" },
          { name: "Bob", card: "8" },
        ],
      });
    }
    // No log line holds the room's code, a subject or a name.
    const lines = logs.raw.join("");
    expect(logs.messages()).toContain("history read");
    for (const word of [code, "PAY-9", "Story 2", "Ada", "Bob"]) expect(lines).not.toContain(word);
  });
});

/** The integers from `high` down to `low`. */
function range(high: number, low: number): number[] {
  return Array.from({ length: high - low + 1 }, (_, i) => high - i);
}
