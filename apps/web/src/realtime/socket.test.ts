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
    fire(socket, "disconnect", "transport close");
    expect(status()).toBe("reconnecting");
    fire(socket, "disconnect", "io client disconnect");
    expect(status()).toBe("offline");

    stop();
    fire(socket, "connect");
    expect(status()).toBe("offline");
    socket.close();
  });
});
