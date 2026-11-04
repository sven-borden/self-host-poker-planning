/**
 * A person the PO removes while their socket is down (U5), against Postgres with real guests and
 * real sockets: their next `enter` says `notice: "removed"`, the others in the room get no new
 * frame, the removal survives a redeploy (a new server on the same database), and once they have
 * joined again a later reconnect says nothing. A room with a password asks for it again, with the
 * notice.
 */
import { apply, type Command, createRoom, type RoomState } from "@pp/domain";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Config } from "../config.ts";
import { createTestDatabase, type TestDatabase } from "../db/test-db.ts";
import { hashPassword } from "../password.ts";
import { createServer, type PokerServer } from "../server.ts";
import { setupServer } from "../setup.ts";
import { collectLogs, testConfig, VALID_ENV } from "../test-support.ts";
import { type Guest, roomCode, signInGuest, type TestClient, testClient } from "./test-support.ts";

const ORIGIN = VALID_ENV.BASE_URL;
const logs = collectLogs("debug");
const SIGN_IN_HEADROOM = { window: 60, max: 1_000 } as const;

type Instance = Awaited<ReturnType<typeof setupServer>> & { server: PokerServer; base: string };

let t: TestDatabase;
let config: Config;
let current: Instance | undefined;
const clients: TestClient[] = [];

async function startInstance(): Promise<Instance> {
  const setup = await setupServer(config, logs.logger, undefined, {
    anonymousSignInLimit: SIGN_IN_HEADROOM,
  });
  const server = createServer(config, { ...setup.deps, logger: logs.logger });
  const { port } = await server.listen();
  current = { ...setup, server, base: `http://localhost:${port}` };
  return current;
}

async function stopInstance(): Promise<void> {
  if (!current) return;
  await current.server.close();
  await current.dispose?.();
  current = undefined;
}

function main(): Instance {
  if (!current) throw new Error("not started");
  return current;
}

function client(guest: Guest): TestClient {
  const c = testClient(main().base, { cookie: guest.cookie });
  clients.push(c);
  return c;
}

const guest = () => signInGuest(main().base, ORIGIN);
const threeGuests = () => Promise.all([guest(), guest(), guest()]);

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

beforeAll(async () => {
  t = await createTestDatabase();
  config = testConfig({ DATABASE_URL: t.url });
  await startInstance();
});

afterEach(() => {
  for (const each of clients.splice(0)) each.close();
});

afterAll(async () => {
  await stopInstance();
  await t?.drop();
});

/** Ada (PO), Bob and Cy seated, in the lobby; with a password when given. */
async function seatedRoom(ada: Guest, bob: Guest, cy: Guest, password?: string): Promise<string> {
  let state: RoomState = createRoom({ ownerId: ada.id });
  const step = (actor: string, command: Command) => {
    const result = apply(state, command, { actor, now: Date.now() });
    if (!result.ok) throw new Error(result.error);
    state = result.state;
  };
  step(ada.id, { type: "join", name: "Ada", role: "voter" });
  step(bob.id, { type: "join", name: "Bob", role: "voter" });
  step(cy.id, { type: "join", name: "Cy", role: "voter" });
  if (password !== undefined) step(ada.id, { type: "password", on: true });
  const code = roomCode();
  const passwordHash = password === undefined ? null : await hashPassword(password);
  const stored = await main().database.store.insertRoom({ code, name: null, state, passwordHash });
  if (!stored) throw new Error("code taken");
  return code;
}

describe("a person removed while their socket was down (U5)", () => {
  it("hears it at their next enter, alone, after a redeploy too, and never once seated again", async () => {
    const [ada, bob, cy] = await threeGuests();
    const code = await seatedRoom(ada, bob, cy);
    const po = client(ada);
    const other = client(cy);
    const away = client(bob);
    for (const each of [po, other, away]) expect((await each.enter(code)).ok).toBe(true);

    // Bob's network drops; the PO removes him before he is back.
    away.close();
    expect((await po.cmd("kick", { who: bob.id })).ok).toBe(true);
    await other.waitFor((s) => s.causes.some((cause) => cause.type === "kicked"));
    expect(away.kicked.count).toBe(0);
    const seen = { po: po.frames.length, other: other.frames.length };

    const back = client(bob);
    const ack = await back.enter(code);
    expect(ack.ok && ack.notice).toBe("removed");
    expect(ack.ok && ack.snapshot.room.you).toBeNull();
    // The notice is in Bob's answer alone: nobody else gets a frame for his return.
    await sleep(300);
    expect(po.frames.length).toBe(seen.po);
    expect(other.frames.length).toBe(seen.other);
    expect([...po.frames, ...other.frames].join("")).not.toContain("removed");
    // Cy's own enter says nothing of it.
    const cyAgain = await client(cy).enter(code);
    expect(cyAgain.ok && cyAgain.notice).toBeUndefined();

    // A redeploy: a new server on the same database still knows.
    for (const each of clients.splice(0)) each.close();
    await stopInstance();
    await startInstance();
    const afterRestart = client(bob);
    const restarted = await afterRestart.enter(code);
    expect(restarted.ok && restarted.notice).toBe("removed");

    // He joins again; a later reconnect is an ordinary one.
    expect((await afterRestart.cmd("join", { name: "Bob", role: "voter" })).ok).toBe(true);
    afterRestart.close();
    const later = await client(bob).enter(code);
    expect(later.ok && later.notice).toBeUndefined();
    expect(later.ok && later.snapshot.room.you).toBe(bob.id);
  });

  it("in a room with a password, asks for it again, with the notice", async () => {
    const [ada, bob, cy] = await threeGuests();
    const code = await seatedRoom(ada, bob, cy, "correct horse");
    const po = client(ada);
    expect((await po.enter(code)).ok).toBe(true);
    expect((await po.cmd("kick", { who: bob.id })).ok).toBe(true);

    expect(await client(bob).enter(code)).toEqual({
      ok: false,
      code: "password_required",
      notice: "removed",
    });
    const stranger = await guest();
    expect(await client(stranger).enter(code)).toEqual({ ok: false, code: "password_required" });
  });
});
