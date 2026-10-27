import { createRoom, type RoomState } from "@pp/domain";
import { COMMAND_ID_PATTERN, PROTOCOL_VERSION, type Snapshot, toSnapshot } from "@pp/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useRoomStore } from "../stores/room-store.ts";
import {
  isCmdAck,
  isEnterAck,
  isSnapshot,
  openRoom,
  type RoomSocket,
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

  it("reports kicked", async () => {
    const fake = fakeSocket(() => ({ ok: true, snapshot: snapshot(1) }));
    open(fake);
    fake.up();
    await settle();
    fake.fire("kicked");
    expect(useRoomStore.getState()).toMatchObject({ status: "error", error: "kicked" });
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
    const ack = await sendCommand({ type: "castVote", payload: { card: "5" } });
    expect(ack).toEqual({ ok: true, version: 2 });
    const cmd = fake.sent.find((s) => s.event === "cmd");
    expect(cmd?.payload).toMatchObject({ type: "castVote", payload: { card: "5" } });
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
});

describe("message guards", () => {
  it("accept the server's messages and refuse other shapes", () => {
    expect(isSnapshot(snapshot(1))).toBe(true);
    expect(isSnapshot({ ...snapshot(1), protocol: PROTOCOL_VERSION + 1 })).toBe(false);
    expect(isSnapshot({ ...snapshot(1), version: "1" })).toBe(false);
    expect(isSnapshot(null)).toBe(false);
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
