import { afterEach, describe, expect, it, vi } from "vitest";
import { useIdentityStore } from "../stores/identity-store.ts";
import { useRoomStore } from "../stores/room-store.ts";
import {
  connectWhenIdentified,
  createSocket,
  type EventsMap,
  type TypedSocket,
  trackConnection,
} from "./socket.ts";

interface ServerToClient extends EventsMap {
  "room:snapshot": (snapshot: { version: number }) => void;
}
interface ClientToServer extends EventsMap {
  "room:join": (code: string) => void;
}

/** Calls the listeners registered for a reserved event, as Socket.IO would. */
function fire(socket: TypedSocket<EventsMap, EventsMap>, event: string, ...args: unknown[]) {
  for (const listener of socket.listeners(event as never)) {
    (listener as (...a: unknown[]) => void)(...args);
  }
}

/** Socket.IO's `active` is true while it will retry; tests set it without a server. */
function setActive(socket: TypedSocket<EventsMap, EventsMap>, active: boolean) {
  Object.defineProperty(socket, "active", { configurable: true, get: () => active });
}

afterEach(() => {
  useRoomStore.getState().reset();
  useIdentityStore.getState().reset();
});

describe("createSocket", () => {
  it("creates a typed socket without connecting", () => {
    const socket = createSocket<ServerToClient, ClientToServer>();
    expect(socket.connected).toBe(false);
    expect(socket.active).toBe(false);
    expect(socket.io.opts.path).toBe("/socket.io");
    socket.close();
  });

  it("goes offline after a disconnect forced by the server, which Socket.IO never retries", () => {
    const socket = createSocket();
    const statuses: string[] = [];
    const stop = trackConnection(socket, (status) => statuses.push(status));
    fire(socket, "connect");
    setActive(socket, false);
    fire(socket, "disconnect", "io server disconnect");
    expect(statuses).toEqual(["connected", "offline"]);
    stop();
    socket.close();
  });

  it("reports a failed attempt as reconnecting while Socket.IO keeps trying", () => {
    const socket = createSocket();
    const statuses: string[] = [];
    const stop = trackConnection(socket, (status) => statuses.push(status));
    setActive(socket, true);
    fire(socket, "connect_error", new Error("xhr poll error"));
    setActive(socket, false);
    fire(socket, "connect_error", new Error("refused"));
    expect(statuses).toEqual(["reconnecting", "offline"]);
    stop();
    socket.close();
  });
});

describe("trackConnection", () => {
  it("mirrors the socket state into the room store", () => {
    const socket = createSocket();
    const { setConnection } = useRoomStore.getState();
    const stop = trackConnection(socket, setConnection);
    const status = () => useRoomStore.getState().connection;

    expect(status()).toBe("idle");
    fire(socket, "connect");
    expect(status()).toBe("connected");
    setActive(socket, true);
    fire(socket, "disconnect", "transport close");
    expect(status()).toBe("reconnecting");
    setActive(socket, false);
    fire(socket, "disconnect", "io client disconnect");
    expect(status()).toBe("offline");

    stop();
    fire(socket, "connect");
    expect(status()).toBe("offline");
    socket.close();
  });
});

describe("connectWhenIdentified", () => {
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

  function setup(ensure: (options?: { force?: boolean }) => Promise<unknown>) {
    const socket = createSocket();
    const connect = vi.spyOn(socket, "connect").mockReturnValue(socket);
    const stop = connectWhenIdentified(socket, ensure);
    return { socket, connect, stop };
  }

  it("connects only once the identity exists", async () => {
    let resolve: (value: unknown) => void = () => {};
    const ensure = vi.fn(() => new Promise((r) => (resolve = r)));
    const { connect, stop } = setup(ensure);
    await tick();
    expect(connect).not.toHaveBeenCalled();
    resolve({ userId: "u1", name: null });
    await tick();
    expect(connect).toHaveBeenCalledOnce();
    stop();
  });

  it("never connects when the bootstrap fails", async () => {
    const { connect, stop } = setup(() => Promise.reject(new Error("rate_limited")));
    await tick();
    expect(connect).not.toHaveBeenCalled();
    stop();
  });

  it("runs the bootstrap once more on unauthenticated, then reports a second refusal", async () => {
    const ensure = vi.fn(() => Promise.resolve({ userId: "u1", name: null }));
    const { socket, connect, stop } = setup(ensure);
    await tick();
    fire(socket, "connect_error", new Error("unauthenticated"));
    await tick();
    expect(ensure).toHaveBeenLastCalledWith({ force: true });
    expect(connect).toHaveBeenCalledTimes(2);
    expect(useIdentityStore.getState().error).toBeNull();
    fire(socket, "connect_error", new Error("unauthenticated"));
    await tick();
    expect(connect).toHaveBeenCalledTimes(2);
    expect(useIdentityStore.getState().error).toBe("unauthenticated");
    stop();
  });

  it("starts over after a successful connect and ignores other errors", async () => {
    const ensure = vi.fn(() => Promise.resolve({ userId: "u1", name: null }));
    const { socket, connect, stop } = setup(ensure);
    await tick();
    fire(socket, "connect_error", new Error("xhr poll error"));
    expect(ensure).toHaveBeenCalledTimes(1);
    fire(socket, "connect_error", new Error("unauthenticated"));
    await tick();
    fire(socket, "connect");
    fire(socket, "connect_error", new Error("unauthenticated"));
    await tick();
    expect(connect).toHaveBeenCalledTimes(3);
    expect(useIdentityStore.getState().error).toBeNull();
    stop();
  });

  it("reports unauthenticated when the second bootstrap fails, and stops on cleanup", async () => {
    const ensure = vi
      .fn<(options?: { force?: boolean }) => Promise<unknown>>()
      .mockResolvedValueOnce({ userId: "u1", name: null })
      .mockRejectedValueOnce(new Error("internal"));
    const { socket, connect, stop } = setup(ensure);
    await tick();
    fire(socket, "connect_error", new Error("unauthenticated"));
    await tick();
    expect(useIdentityStore.getState().error).toBe("unauthenticated");
    stop();
    fire(socket, "connect_error", new Error("unauthenticated"));
    expect(connect).toHaveBeenCalledOnce();
  });
});
