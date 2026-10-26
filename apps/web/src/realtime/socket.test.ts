import { afterEach, describe, expect, it } from "vitest";
import { useRoomStore } from "../stores/room-store.ts";
import { createSocket, type EventsMap, type TypedSocket, trackConnection } from "./socket.ts";

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
