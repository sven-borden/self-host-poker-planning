import { createRoom, type RoomState } from "@pp/domain";
import { COMMAND_ID_PATTERN, PROTOCOL_VERSION, type Snapshot, toSnapshot } from "@pp/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useRoomStore } from "../stores/room-store.ts";
import {
  ACCESS_CHANNEL,
  announceRoomAccess,
  commandSender,
  enterRoomAgain,
  HISTORY_RETRY_MS,
  isCmdAck,
  isEnterAck,
  isHistoryAck,
  isSnapshot,
  openRoom,
  type RoomSocket,
  requestHistory,
  sendCommand,
} from "./room-connection.ts";
import { createSocket } from "./socket.ts";

const CODE = "abcdefghij";

function snapshot(version: number, state: RoomState = createRoom({ ownerId: "ua" })): Snapshot {
  return toSnapshot(state, "ua", { code: CODE, version, now: 0 });
}

interface Sent {
  event: string;
  payload: Record<string, unknown>;
}

/**
 * A real Socket.IO client socket that never touches the network: `connected` is under
 * the test's control, and every `emitWithAck` goes to `answer`.
 */
function fakeSocket(answer: (sent: Sent) => unknown) {
  const socket = createSocket() as unknown as RoomSocket;
  let connected = false;
  // Socket.IO stays active (it reconnects on its own) until the client disconnects.
  let active = true;
  Object.defineProperty(socket, "connected", { configurable: true, get: () => connected });
  Object.defineProperty(socket, "active", { configurable: true, get: () => active });
  const sent: Sent[] = [];
  Object.assign(socket, {
    timeout: () => ({
      emitWithAck: (event: string, payload: Record<string, unknown>) => {
        const message = { event, payload };
        sent.push(message);
        return Promise.resolve().then(() => answer(message));
      },
    }),
    connect: vi.fn(),
    disconnect: vi.fn(() => {
      const was = connected;
      connected = false;
      active = false;
      if (was) fire("disconnect", "io client disconnect");
      return socket;
    }),
  });
  function fire(event: string, ...args: unknown[]) {
    for (const listener of socket.listeners(event as never)) {
      (listener as (...a: unknown[]) => void)(...args);
    }
  }
  return {
    socket,
    sent,
    fire,
    up() {
      connected = true;
      active = true;
      fire("connect");
    },
    drop() {
      connected = false;
      fire("disconnect", "transport close");
    },
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const status = () => useRoomStore.getState().status;

const closers: Array<() => void> = [];
function open(fake: ReturnType<typeof fakeSocket>, delay = () => 0) {
  const close = openRoom(CODE, { socket: fake.socket, connect: () => () => {}, delay });
  closers.push(close);
  return close;
}

afterEach(() => {
  for (const close of closers.splice(0)) close();
  useRoomStore.getState().reset();
});

describe("openRoom", () => {
  it("enters on connect with the protocol version and goes live with the snapshot", async () => {
    const fake = fakeSocket(() => ({ ok: true, snapshot: snapshot(3) }));
    open(fake);
    expect(status()).toBe("connecting");
    fake.up();
    await settle();
    expect(fake.sent).toEqual([
      { event: "enter", payload: { code: CODE, protocol: PROTOCOL_VERSION } },
    ]);
    expect(status()).toBe("live");
    expect(useRoomStore.getState().snapshot?.version).toBe(3);
  });

  it("enters again on every reconnect, and drops snapshots older than the one it holds", async () => {
    let version = 3;
    const fake = fakeSocket(() => ({ ok: true, snapshot: snapshot(version) }));
    open(fake);
    fake.up();
    await settle();
    fake.fire("snapshot", snapshot(5));
    fake.fire("snapshot", snapshot(4));
    expect(useRoomStore.getState().snapshot?.version).toBe(5);
    fake.drop();
    expect(status()).toBe("reconnecting");
    version = 7;
    fake.up();
    await settle();
    expect(fake.sent.filter((s) => s.event === "enter")).toHaveLength(2);
    expect(status()).toBe("live");
    expect(useRoomStore.getState().snapshot?.version).toBe(7);
  });

  it("stops on protocol_mismatch: error status, socket closed, no second enter", async () => {
    const fake = fakeSocket(() => ({ ok: false, code: "protocol_mismatch" }));
    open(fake);
    fake.up();
    await settle();
    await settle();
    expect(useRoomStore.getState()).toMatchObject({ status: "error", error: "protocol_mismatch" });
    expect(fake.socket.disconnect).toHaveBeenCalled();
    expect(fake.sent).toHaveLength(1);
  });

  it("sends enter again after internal, and stops on room_not_found", async () => {
    const answers = [
      { ok: false, code: "internal" },
      { ok: false, code: "room_not_found" },
    ];
    const fake = fakeSocket(() => answers.shift());
    open(fake);
    fake.up();
    await settle();
    expect(status()).toBe("reconnecting");
    await settle();
    await settle();
    expect(fake.sent).toHaveLength(2);
    expect(useRoomStore.getState()).toMatchObject({ status: "error", error: "room_not_found" });
  });

  it("signs in again on unauthenticated without passing through offline, and a waiting command goes through", async () => {
    let enters = 0;
    const fake = fakeSocket(({ event }) => {
      if (event !== "enter") return { ok: true, version: 9 };
      enters += 1;
      return enters === 2
        ? { ok: false, code: "unauthenticated" }
        : { ok: true, snapshot: snapshot(enters) };
    });
    let signedIn: () => void = () => {};
    const ensure = vi.fn(() => new Promise<void>((resolve) => (signedIn = resolve)));
    closers.push(
      openRoom(CODE, { socket: fake.socket, connect: () => () => {}, ensure, delay: () => 0 }),
    );
    fake.up();
    await vi.waitFor(() => expect(status()).toBe("live"));
    const seen: string[] = [];
    const unsubscribe = useRoomStore.subscribe(({ status: s, error, connection }) =>
      seen.push(`${s}${error ? `:${error}` : ""}/${connection}`),
    );
    // A dropped connection; the enter after the reconnect finds the session gone.
    fake.drop();
    const pending = sendCommand({ type: "reveal" });
    fake.up();
    await vi.waitFor(() => expect(ensure).toHaveBeenCalledWith({ force: true, retry: true }));
    signedIn();
    await vi.waitFor(() => expect(fake.socket.connect).toHaveBeenCalled());
    fake.up();
    expect(await pending).toEqual({ ok: true, version: 9 });
    unsubscribe();
    expect(status()).toBe("live");
    expect(seen.some((entry) => entry.includes("error") || entry.includes("offline"))).toBe(false);
  });

  it("after kicked, connects again and enters as someone not in the room (#30)", async () => {
    let version = 1;
    const fake = fakeSocket(() => ({ ok: true, snapshot: snapshot(version) }));
    open(fake);
    fake.up();
    await settle();
    fake.fire("kicked");
    expect(useRoomStore.getState()).toMatchObject({ status: "live", removed: true });
    // The server closes the socket: not a final offline, the socket connects again.
    Object.defineProperty(fake.socket, "active", { configurable: true, get: () => false });
    fake.fire("disconnect", "io server disconnect");
    expect(fake.socket.connect).toHaveBeenCalledTimes(1);
    expect(useRoomStore.getState()).toMatchObject({ status: "live", error: null, removed: true });
    version = 2;
    fake.up();
    await settle();
    expect(fake.sent.filter((m) => m.event === "enter")).toHaveLength(2);
    expect(useRoomStore.getState().snapshot?.version).toBe(2);
    // A later close the server forces is final again.
    fake.fire("disconnect", "io server disconnect");
    expect(useRoomStore.getState()).toMatchObject({ status: "error", error: "offline" });
  });

  it("locks on password_required, keeps the socket, and enters again once asked (#31)", async () => {
    let answer: unknown = { ok: false, code: "password_required" };
    const fake = fakeSocket(() => answer);
    open(fake);
    fake.up();
    await settle();
    expect(useRoomStore.getState()).toMatchObject({
      status: "locked",
      locked: "required",
      snapshot: null,
    });
    expect(fake.socket.disconnect).not.toHaveBeenCalled();
    // A blip while locked keeps the form: the next enter asks again.
    fake.drop();
    expect(status()).toBe("locked");
    fake.up();
    await settle();
    expect(status()).toBe("locked");

    answer = { ok: true, snapshot: snapshot(4) };
    expect(await enterRoomAgain()).toBe("ok");
    expect(useRoomStore.getState()).toMatchObject({ status: "live", locked: null });
    expect(useRoomStore.getState().snapshot?.version).toBe(4);
  });

  it("says the password changed when the room it showed had one, and re-enters on locked", async () => {
    const withPassword = { ...createRoom({ ownerId: "ua" }), hasPassword: true as const };
    let answer: unknown = { ok: true, snapshot: snapshot(2, withPassword) };
    const fake = fakeSocket(() => answer);
    open(fake);
    fake.up();
    await settle();
    answer = { ok: false, code: "password_required" };
    fake.fire("locked");
    await settle();
    expect(useRoomStore.getState()).toMatchObject({ status: "locked", locked: "changed" });
    expect(await enterRoomAgain()).toBe("password_required");
  });

  it("keeps saying the password changed through a reconnect (N5)", async () => {
    const withPassword = { ...createRoom({ ownerId: "ua" }), hasPassword: true as const };
    let answer: unknown = { ok: true, snapshot: snapshot(2, withPassword) };
    const fake = fakeSocket(() => answer);
    open(fake);
    fake.up();
    await settle();
    answer = { ok: false, code: "password_required" };
    fake.fire("locked");
    await settle();
    expect(useRoomStore.getState().locked).toBe("changed");
    // The reconnect enters with no snapshot held: it still says "changed".
    fake.drop();
    fake.up();
    await settle();
    expect(useRoomStore.getState()).toMatchObject({ status: "locked", locked: "changed" });
  });

  it("enters again when another tab of this browser got in, and only for its room (N5)", async () => {
    let answer: unknown = { ok: false, code: "password_required" };
    const fake = fakeSocket(() => answer);
    open(fake);
    fake.up();
    await settle();
    expect(status()).toBe("locked");
    const enters = () => fake.sent.length;
    const before = enters();
    const tab = new BroadcastChannel(ACCESS_CHANNEL);
    try {
      tab.postMessage({ code: "another-room" });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(enters()).toBe(before);
      answer = { ok: true, snapshot: snapshot(3) };
      tab.postMessage({ code: CODE });
      await vi.waitFor(() => expect(status()).toBe("live"));
      expect(enters()).toBe(before + 1);
    } finally {
      tab.close();
    }
  });

  it("tells the other tabs, never itself, that the password was accepted (N5)", async () => {
    const fake = fakeSocket(() => ({ ok: false, code: "password_required" }));
    open(fake);
    fake.up();
    await settle();
    const before = fake.sent.length;
    const tab = new BroadcastChannel(ACCESS_CHANNEL);
    const heard: unknown[] = [];
    tab.onmessage = (event) => heard.push(event.data);
    try {
      announceRoomAccess();
      await vi.waitFor(() => expect(heard).toEqual([{ code: CODE }]));
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(fake.sent.length).toBe(before);
    } finally {
      tab.close();
    }
  });

  it("resolves offline when no room is open", async () => {
    expect(await enterRoomAgain()).toBe("offline");
  });

  it("resets the store when closed", async () => {
    const fake = fakeSocket(() => ({ ok: true, snapshot: snapshot(1) }));
    const close = open(fake);
    fake.up();
    await settle();
    close();
    expect(useRoomStore.getState()).toMatchObject({ code: null, status: "idle", snapshot: null });
  });
});

describe("sendCommand", () => {
  it("answers offline when no room is open", async () => {
    expect(await sendCommand({ type: "reveal" })).toEqual({ ok: false, code: "offline" });
  });

  it("sends the command with a fresh id and resolves with the ack", async () => {
    const fake = fakeSocket(({ event }) =>
      event === "enter" ? { ok: true, snapshot: snapshot(1) } : { ok: true, version: 2 },
    );
    open(fake);
    fake.up();
    const ack = await sendCommand({
      type: "castVote",
      payload: { card: "5", round: 1, restart: 0 },
    });
    expect(ack).toEqual({ ok: true, version: 2 });
    const cmd = fake.sent.find((s) => s.event === "cmd");
    expect(cmd?.payload).toMatchObject({
      type: "castVote",
      payload: { card: "5", round: 1, restart: 0 },
    });
    expect(String(cmd?.payload.id)).toMatch(COMMAND_ID_PATTERN);
  });

  it("sends the same id again after busy and after a lost ack, once live again", async () => {
    let cmds = 0;
    const fake = fakeSocket(({ event }) => {
      if (event === "enter") return { ok: true, snapshot: snapshot(1) };
      cmds += 1;
      if (cmds === 1) return { ok: false, code: "busy" };
      if (cmds === 2) {
        fake.drop();
        throw new Error("socket has been disconnected");
      }
      return { ok: true, version: 2 };
    });
    open(fake);
    fake.up();
    const pending = sendCommand({ type: "reveal" });
    await vi.waitFor(() => expect(cmds).toBe(2));
    expect(status()).toBe("reconnecting");
    fake.up();
    expect(await pending).toEqual({ ok: true, version: 2 });
    const ids = fake.sent.filter((s) => s.event === "cmd").map((s) => s.payload.id);
    expect(ids).toHaveLength(3);
    expect(new Set(ids).size).toBe(1);
  });

  it("never carries a waiting command over to the next room opened", async () => {
    const first = fakeSocket(({ event }) =>
      event === "enter" ? { ok: true, snapshot: snapshot(1) } : { ok: true, version: 2 },
    );
    const closeFirst = open(first);
    first.up();
    await vi.waitFor(() => expect(status()).toBe("live"));
    // The connection drops: the command waits for the room to be live again.
    first.drop();
    const pending = sendCommand({ type: "leave" });
    await settle();
    // The page leaves for another room, which goes live at once.
    closeFirst();
    const second = fakeSocket(({ event }) =>
      event === "enter" ? { ok: true, snapshot: snapshot(1) } : { ok: true, version: 2 },
    );
    open(second);
    second.up();
    expect(await pending).toEqual({ ok: false, code: "offline" });
    expect(second.sent.filter((s) => s.event === "cmd")).toEqual([]);
    expect(first.sent.filter((s) => s.event === "cmd")).toEqual([]);
  });

  // Room A's answer comes only after the page has moved to room B, which is live by then:
  // a lost ack, or `busy`, must not send the command again to B (#76's open point).
  it.each([
    ["lost", (fail: (error: Error) => void) => fail(new Error("operation has timed out"))],
    [
      "busy",
      (_fail: unknown, answer: (ack: unknown) => void) => answer({ ok: false, code: "busy" }),
    ],
  ] as const)("sends nothing to the next room when the ack is %s", async (_, settleAck) => {
    let answer: (ack: unknown) => void = () => {};
    let fail: (error: Error) => void = () => {};
    const first = fakeSocket(({ event }) =>
      event === "enter"
        ? { ok: true, snapshot: snapshot(1) }
        : new Promise((resolve, reject) => {
            answer = resolve;
            fail = reject;
          }),
    );
    const closeFirst = open(first);
    first.up();
    await vi.waitFor(() => expect(status()).toBe("live"));
    const pending = sendCommand({ type: "reveal" });
    await vi.waitFor(() => expect(first.sent.some((s) => s.event === "cmd")).toBe(true));
    closeFirst();
    const second = fakeSocket(({ event }) =>
      event === "enter" ? { ok: true, snapshot: snapshot(1) } : { ok: true, version: 2 },
    );
    open(second);
    second.up();
    await vi.waitFor(() => expect(status()).toBe("live"));
    settleAck(fail, answer);
    expect(await pending).toEqual({ ok: false, code: "offline" });
    expect(second.sent.filter((s) => s.event === "cmd")).toEqual([]);
  });
});

describe("commandSender", () => {
  const live = () =>
    fakeSocket(({ event }) =>
      event === "enter" ? { ok: true, snapshot: snapshot(1) } : { ok: true, version: 2 },
    );

  it("sends to the room open when it was taken", async () => {
    const fake = live();
    open(fake);
    fake.up();
    const send = commandSender();
    expect(await send({ type: "leave" })).toEqual({ ok: true, version: 2 });
    expect(fake.sent.filter((s) => s.event === "cmd")).toHaveLength(1);
  });

  it("answers offline at once, and sends nothing, once the page has moved to another room", async () => {
    const first = live();
    const closeFirst = open(first);
    first.up();
    await vi.waitFor(() => expect(status()).toBe("live"));
    // Taken when the form is submitted; the page moves on while the name is being saved.
    const send = commandSender();
    closeFirst();
    const second = live();
    open(second);
    second.up();
    await vi.waitFor(() => expect(status()).toBe("live"));
    expect(await send({ type: "join", payload: { name: "Ana", role: "voter" } })).toEqual({
      ok: false,
      code: "offline",
    });
    expect(second.sent.filter((s) => s.event === "cmd")).toEqual([]);
    expect(first.sent.filter((s) => s.event === "cmd")).toEqual([]);
  });

  it("answers offline when no room was open", async () => {
    const send = commandSender();
    const fake = live();
    open(fake);
    fake.up();
    await vi.waitFor(() => expect(status()).toBe("live"));
    expect(await send({ type: "leave" })).toEqual({ ok: false, code: "offline" });
    expect(fake.sent.filter((s) => s.event === "cmd")).toEqual([]);
  });

  it("stops waiting and sends nothing once its signal aborts", async () => {
    const fake = live();
    open(fake);
    const send = commandSender();
    const controller = new AbortController();
    // The room is not live yet: the send waits, then is given up.
    const pending = send({ type: "leave" }, { signal: controller.signal });
    controller.abort();
    expect(await pending).toEqual({ ok: false, code: "offline" });
    fake.up();
    await vi.waitFor(() => expect(status()).toBe("live"));
    expect(fake.sent.filter((s) => s.event === "cmd")).toEqual([]);
  });
});

const ROUND = {
  number: 3,
  subject: { kind: "title", text: "Login" },
  final: null,
  stats: { distribution: [{ card: "5", count: 2 }], suggested: "5" },
  startedAt: 1,
  revealedAt: 2,
  finishedAt: 3,
  votes: { kind: "anonymous", cards: ["5", "5"] },
};

describe("requestHistory (#33)", () => {
  it("answers offline when no room is open", async () => {
    expect(await requestHistory()).toEqual({ ok: false, code: "offline" });
  });

  it("asks the live room for a page and resolves with the answer", async () => {
    const page = { ok: true, rounds: [ROUND], next: 3 };
    const fake = fakeSocket(({ event }) =>
      event === "enter" ? { ok: true, snapshot: snapshot(1) } : page,
    );
    open(fake);
    fake.up();
    expect(await requestHistory({ before: 10, limit: 5 })).toEqual(page);
    expect(fake.sent.find((s) => s.event === "history")?.payload).toEqual({ before: 10, limit: 5 });
  });

  it("asks again after rate_limited, after a pause", async () => {
    let asks = 0;
    const fake = fakeSocket(({ event }) => {
      if (event === "enter") return { ok: true, snapshot: snapshot(1) };
      asks += 1;
      return asks === 1 ? { ok: false, code: "rate_limited" } : { ok: true, rounds: [] };
    });
    open(fake);
    fake.up();
    const started = Date.now();
    expect(await requestHistory()).toEqual({ ok: true, rounds: [] });
    expect(asks).toBe(2);
    expect(Date.now() - started).toBeGreaterThanOrEqual(HISTORY_RETRY_MS - 50);
  });

  it("asks again after a lost answer, and turns an unreadable one into bad_payload", async () => {
    let asks = 0;
    const fake = fakeSocket(({ event }) => {
      if (event === "enter") return { ok: true, snapshot: snapshot(1) };
      asks += 1;
      if (asks === 1) {
        fake.drop();
        throw new Error("socket has been disconnected");
      }
      return { ok: true, rounds: [{ number: "3" }] };
    });
    open(fake);
    fake.up();
    const pending = requestHistory();
    await vi.waitFor(() => expect(asks).toBe(1));
    fake.up();
    expect(await pending).toEqual({ ok: false, code: "bad_payload" });
    expect(asks).toBe(2);
  });
});

describe("message guards", () => {
  it("read a history answer by its shape", () => {
    expect(isHistoryAck({ ok: true, rounds: [] })).toBe(true);
    expect(isHistoryAck({ ok: true, rounds: [ROUND], next: 2 })).toBe(true);
    expect(isHistoryAck({ ok: false, code: "not_participant" })).toBe(true);
    const named = { ...ROUND, final: "5", votes: { kind: "named", votes: [] } };
    expect(isHistoryAck({ ok: true, rounds: [named] })).toBe(true);
    for (const wrong of [
      null,
      { ok: true },
      { ok: true, rounds: [], next: "2" },
      { ok: true, rounds: [{ ...ROUND, votes: { kind: "secret" } }] },
      { ok: true, rounds: [{ ...ROUND, final: 5 }] },
      { ok: true, rounds: [{ ...ROUND, stats: {} }] },
      { ok: false },
    ]) {
      expect(isHistoryAck(wrong)).toBe(false);
    }
  });

  it("accept the server's messages and refuse other shapes", () => {
    expect(isSnapshot(snapshot(1))).toBe(true);
    expect(isSnapshot({ ...snapshot(1), protocol: PROTOCOL_VERSION + 1 })).toBe(false);
    expect(isSnapshot({ ...snapshot(1), version: "1" })).toBe(false);
    expect(isSnapshot(null)).toBe(false);
    expect(isSnapshot({ ...snapshot(1), version: Number.MAX_SAFE_INTEGER + 2 })).toBe(false);
    const room = snapshot(1).room;
    for (const participants of [[null], [42], [{ id: "ua" }]]) {
      expect(isSnapshot({ ...snapshot(1), room: { ...room, participants } })).toBe(false);
    }
    expect(isSnapshot({ ...snapshot(1), room: { ...room, round: "voting" } })).toBe(false);
    expect(isEnterAck({ ok: true, snapshot: snapshot(1) })).toBe(true);
    expect(isEnterAck({ ok: true })).toBe(false);
    expect(isEnterAck({ ok: false, code: "room_not_found" })).toBe(true);
    expect(isCmdAck({ ok: true, version: 3 })).toBe(true);
    expect(isCmdAck({ ok: true, version: 1.5 })).toBe(false);
    expect(isCmdAck({ ok: false })).toBe(false);
    expect(isCmdAck("ok")).toBe(false);
  });

  it("turns an unreadable enter answer into a final bad_payload", async () => {
    const fake = fakeSocket(() => ({ ok: true, snapshot: { version: 1 } }));
    open(fake);
    fake.up();
    await settle();
    expect(useRoomStore.getState()).toMatchObject({ status: "error", error: "bad_payload" });
  });
});
