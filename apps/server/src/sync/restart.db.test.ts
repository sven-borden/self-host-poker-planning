/**
 * AC 2: the built server (`dist/main.mjs`, so `pnpm --filter @pp/server build` first) runs
 * as a child process; two guests enter a room and one votes mid-round; the process is
 * killed hard and started again on the same port. The clients reconnect on their own,
 * enter again and get the same round, the hidden vote included.
 *
 * #27 (AC 3): a timer running when the server dies still reveals at its deadline, once.
 * Nothing arms the deadline at start-up: the first socket that enters the room arms it
 * again (`armDeadline` on enter), and `apply` stamps the reveal with the deadline itself,
 * so the stored round is the same whoever resolves it.
 *
 * #33 (AC 1): the history of finished rounds reads the same after the restart.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { resolve } from "node:path";
import { apply, type Command, createRoom, type RoomState } from "@pp/domain";
import { afterAll, beforeAll, expect, it } from "vitest";
import { type Database, openDatabase } from "../database.ts";
import { createTestDatabase, type TestDatabase } from "../db/test-db.ts";
import { collectLogs } from "../test-support.ts";
import { type Guest, roomCode, signInGuest, type TestClient, testClient } from "./test-support.ts";

const MAIN = resolve(import.meta.dirname, "../../dist/main.mjs");

let t: TestDatabase;
let database: Database;
let port: number;
let base: string;
let child: ChildProcess | undefined;
const output: string[] = [];
const clients: TestClient[] = [];

function freePort(): Promise<number> {
  return new Promise((done, fail) => {
    const probe = createNetServer();
    probe.once("error", fail);
    probe.listen(0, () => {
      const address = probe.address();
      probe.close(() => done(typeof address === "object" && address ? address.port : 0));
    });
  });
}

/** Starts the built server and resolves once `/api/health` answers 200. */
async function startServer(): Promise<void> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_ENV: "production",
    DATABASE_URL: t.url,
    PORT: String(port),
    BASE_URL: base,
    BETTER_AUTH_SECRET: "restart-test-fake-secret-0123456789abcdefghij",
    TRUST_PROXY: "false",
    LOG_LEVEL: "warn",
  };
  delete env.NODE_OPTIONS;
  const started = spawn(process.execPath, ["--enable-source-maps", MAIN], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child = started;
  started.stdout?.on("data", (chunk: Buffer) => output.push(chunk.toString()));
  started.stderr?.on("data", (chunk: Buffer) => output.push(chunk.toString()));
  const until = Date.now() + 30_000;
  while (Date.now() < until) {
    if (started.exitCode !== null) throw new Error(`server exited: ${output.join("")}`);
    const ok = await fetch(`${base}/api/health`).then(
      (response) => response.ok,
      () => false,
    );
    if (ok) return;
    await new Promise((wake) => setTimeout(wake, 100));
  }
  throw new Error(`server did not start: ${output.join("")}`);
}

/** Kills the server at once (no shutdown, no disconnect packets) and waits for its exit. */
async function killServer(): Promise<void> {
  const running = child;
  child = undefined;
  if (!running || running.exitCode !== null) return;
  const exited = new Promise((done) => running.once("exit", done));
  running.kill("SIGKILL");
  await exited;
}

function step(state: RoomState, actor: string, command: Command): RoomState {
  const result = apply(state, command, { actor, now: Date.now() });
  if (!result.ok) throw new Error(`fixture refused: ${result.error}`);
  return result.state;
}

/** A client that enters `code` on every connect, as the web app does. */
function roomClient(guest: Guest, code: string): TestClient {
  const client = testClient(base, { cookie: guest.cookie, reconnection: true });
  client.socket.on("connect", () => {
    void client.enter(code).catch(() => {});
  });
  clients.push(client);
  return client;
}

beforeAll(async () => {
  if (!existsSync(MAIN)) {
    throw new Error("apps/server/dist/main.mjs is missing: run `pnpm --filter @pp/server build`");
  }
  t = await createTestDatabase();
  port = await freePort();
  base = `http://localhost:${port}`;
  await startServer();
  database = await openDatabase(t.url, collectLogs("warn").logger);
});

afterAll(async () => {
  for (const client of clients.splice(0)) client.close();
  await killServer();
  await database?.close();
  await t?.drop();
});

it("restores the round, hidden vote included, after a hard kill and a restart", async () => {
  const [ada, bob] = await Promise.all([signInGuest(base, base), signInGuest(base, base)]);
  let state = createRoom({ ownerId: ada.id });
  state = step(state, ada.id, { type: "join", name: "Ada", role: "voter" });
  state = step(state, bob.id, { type: "join", name: "Bob", role: "voter" });
  state = step(state, ada.id, { type: "startRound", subject: { kind: "none" } });
  const code = roomCode();
  expect(await database.store.insertRoom({ code, name: null, state })).not.toBeNull();

  const a = roomClient(ada, code);
  const b = roomClient(bob, code);
  await a.waitFor((s) => s.version === 1);
  await b.waitFor((s) => s.version === 1);
  expect(await a.cmd("castVote", { card: "8", round: 1, restart: 0 })).toEqual({
    ok: true,
    version: 2,
  });
  await b.waitFor((s) => s.room.round?.voted.includes(ada.id) === true);

  const fromA = a.received.length;
  const fromB = b.received.length;
  const dropped = new Promise((done) => b.socket.once("disconnect", done));
  await killServer();
  await dropped;
  await startServer();

  const again = await a.waitFor((s) => s.version === 2, 10_000, fromA);
  expect(again.snapshot.room.round).toMatchObject({
    phase: "voting",
    voted: [ada.id],
    yourVote: "8",
  });
  const other = await b.waitFor((s) => s.version === 2, 10_000, fromB);
  expect(other.snapshot.room.round?.voted).toEqual([ada.id]);
  expect(other.snapshot.room.round?.yourVote).toBeUndefined();

  // The vote survived: Bob's vote completes the round, and the reveal shows Ada's 8.
  expect((await b.cmd("castVote", { card: "3", round: 1, restart: 0 })).ok).toBe(true);
  const revealed = await b.waitFor((s) => s.room.round?.phase === "revealed", 3000, fromB);
  const round = revealed.snapshot.room.round;
  expect(round?.phase === "revealed" && !round.anonymous && round.votes).toEqual([
    { who: ada.id, card: "8", changedAfterReveal: false },
    { who: bob.id, card: "3", changedAfterReveal: false },
  ]);
}, 60_000);

it("reveals at the deadline, once, when the server restarts mid-countdown (#27)", async () => {
  const [ada, bob] = await Promise.all([signInGuest(base, base), signInGuest(base, base)]);
  let state = createRoom({ ownerId: ada.id });
  state = step(state, ada.id, { type: "join", name: "Ada", role: "voter" });
  state = step(state, bob.id, { type: "join", name: "Bob", role: "voter" });
  state = step(state, ada.id, { type: "startRound", subject: { kind: "none" } });
  state = step(state, ada.id, { type: "startTimer", seconds: 12 });
  const deadlineAt = state.round?.deadlineAt ?? 0;
  const code = roomCode();
  expect(await database.store.insertRoom({ code, name: null, state })).not.toBeNull();

  const a = roomClient(ada, code);
  const b = roomClient(bob, code);
  await a.waitFor((s) => s.version === 1);
  await b.waitFor((s) => s.version === 1);
  expect(await a.cmd("castVote", { card: "5", round: 1 })).toEqual({ ok: true, version: 2 });
  await b.waitFor((s) => s.room.round?.voted.includes(ada.id) === true);

  const fromA = a.received.length;
  const dropped = new Promise((done) => b.socket.once("disconnect", done));
  await killServer();
  await dropped;
  await startServer();
  // Both clients are back before the deadline: the countdown goes on where it was.
  const back = await a.waitFor((s) => s.room.round?.deadlineAt === deadlineAt, 10_000, fromA);
  expect(back.snapshot.room.round?.phase).toBe("voting");
  expect(Date.now()).toBeLessThan(deadlineAt);

  const shown = await Promise.all(
    [a, b].map((client) =>
      client.waitFor((s) => s.room.round?.phase === "revealed", deadlineAt - Date.now() + 5_000),
    ),
  );
  for (const [i, client] of [a, b].entries()) {
    const reveals = client.received.flatMap((r) =>
      r.snapshot.causes.filter((cause) => cause.type === "revealed"),
    );
    expect(reveals, `client ${i}`).toEqual([{ type: "revealed", by: "timer" }]);
    const round = shown[i]?.snapshot.room.round;
    expect(round?.phase === "revealed" && round.revealedAt).toBe(deadlineAt);
  }
  // Not before the deadline, and stored as the timer's reveal.
  const stored = await database.store.loadRoom(code);
  expect(stored?.state.round).toMatchObject({ phase: "revealed", revealedAt: deadlineAt });
  expect(stored?.state.round?.votes).toEqual({ [ada.id]: { card: "5" } });
  // One more second: nothing reveals twice.
  await new Promise((wake) => setTimeout(wake, 1_000));
  for (const client of [a, b]) {
    const count = client.received.filter((r) =>
      r.snapshot.causes.some((cause) => cause.type === "revealed"),
    ).length;
    expect(count).toBe(1);
  }
}, 60_000);

it("keeps every history row through a hard kill and a restart (#33, AC 1)", async () => {
  const [ada, bob] = await Promise.all([signInGuest(base, base), signInGuest(base, base)]);
  let state = createRoom({ ownerId: ada.id });
  state = step(state, ada.id, { type: "join", name: "Ada", role: "voter" });
  state = step(state, bob.id, { type: "join", name: "Bob", role: "voter" });
  state = step(state, ada.id, { type: "startRound", subject: { kind: "title", text: "Story 1" } });
  const code = roomCode();
  expect(await database.store.insertRoom({ code, name: null, state })).not.toBeNull();

  const a = roomClient(ada, code);
  const b = roomClient(bob, code);
  await a.waitFor((s) => s.version === 1);
  await b.waitFor((s) => s.version === 1);
  // Three rounds voted; the fourth is on the table.
  for (const round of [1, 2, 3]) {
    expect((await a.cmd("castVote", { card: "5", round })).ok).toBe(true);
    expect((await b.cmd("castVote", { card: "8", round })).ok).toBe(true);
    const subject = { kind: "title", text: `Story ${round + 1}` };
    expect((await a.cmd("startRound", { subject })).ok).toBe(true);
  }
  const before = await b.history();
  expect(before.ok && before.rounds.map((row) => row.number)).toEqual([3, 2, 1]);
  const version = a.latest()?.version ?? 0;

  const fromA = a.received.length;
  const fromB = b.received.length;
  const dropped = new Promise((done) => b.socket.once("disconnect", done));
  await killServer();
  await dropped;
  await startServer();
  await a.waitFor((s) => s.version === version, 10_000, fromA);
  await b.waitFor((s) => s.version === version, 10_000, fromB);
  expect(await a.history()).toEqual(before);
  expect(await b.history({ limit: 2 })).toEqual({
    ok: true,
    rounds: before.ok ? before.rounds.slice(0, 2) : [],
    next: 2,
  });
}, 60_000);
