import { afterEach, describe, expect, it, vi } from "vitest";
import { useIdentityStore } from "../stores/identity-store.ts";
import { useRoomStore } from "../stores/room-store.ts";
import {
  connectWhenIdentified,
  createSocket,
  type EventsMap,
  refusalOf,
  socketTransports,
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
    expect(socket.io.opts.transports).toBeUndefined();
    socket.close();
  });

  it("uses WebSocket only when index.html says so (several instances, #39)", () => {
    const meta = document.createElement("meta");
    meta.name = "pp-socket-transport";
    meta.content = "websocket";
    document.head.append(meta);
    try {
      expect(socketTransports()).toEqual(["websocket"]);
      const socket = createSocket();
      expect(socket.io.opts.transports).toEqual(["websocket"]);
      socket.close();
      meta.content = "polling";
      expect(socketTransports()).toBeUndefined();
    } finally {
      meta.remove();
    }
    expect(socketTransports()).toBeUndefined();
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

  it("reports a refusal that connectWhenIdentified retries as reconnecting", () => {
    const socket = createSocket();
    const statuses: string[] = [];
    const stop = trackConnection(socket, (status) => statuses.push(status));
    setActive(socket, false);
    fire(socket, "connect_error", new Error("internal"));
    fire(socket, "connect_error", new Error("rate_limited"));
    fire(socket, "connect_error", new Error("unauthenticated"));
    expect(statuses).toEqual(["reconnecting", "reconnecting", "offline"]);
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

/** Engine.IO's polling error: the HTTP status as `description`, the XHR as `context`. */
function engineRefusal(status: number, responseText: string) {
  return Object.assign(new Error("xhr poll error"), {
    description: status,
    context: { responseText },
  });
}

describe("refusalOf", () => {
  it("reads a middleware's message, and the message of Engine.IO's 403", () => {
    expect(refusalOf(new Error("rate_limited"))).toBe("rate_limited");
    expect(refusalOf(engineRefusal(403, '{"code":4,"message":"unauthenticated"}'))).toBe(
      "unauthenticated",
    );
  });

  it("keeps Socket.IO's message for anything else", () => {
    for (const error of [
      engineRefusal(502, '{"message":"unauthenticated"}'),
      engineRefusal(403, "<html>proxy</html>"),
      engineRefusal(403, '{"code":4}'),
      engineRefusal(403, "null"),
      Object.assign(new Error("xhr poll error"), { description: 403 }),
    ]) {
      expect(refusalOf(error)).toBe("xhr poll error");
    }
  });
});

describe("connectWhenIdentified", () => {
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

  type Ensure = (options?: { force?: boolean; retry?: boolean }) => Promise<unknown>;

  function setup(
    ensure: Ensure,
    delay: (attempt: number, retryAfter?: number) => number = () => 5,
  ) {
    const socket = createSocket();
    const connect = vi.spyOn(socket, "connect").mockReturnValue(socket);
    const stop = connectWhenIdentified(socket, { ensure, delay });
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

  it("asks for a bootstrap that retries, and never connects when it fails for good", async () => {
    const ensure = vi.fn<Ensure>(() => Promise.reject(new Error("cookies_blocked")));
    const { connect, stop } = setup(ensure);
    await tick();
    expect(ensure).toHaveBeenCalledWith({ retry: true });
    expect(connect).not.toHaveBeenCalled();
    stop();
  });

  it("connects again after internal or rate_limited, with backoff, until the server is back", async () => {
    vi.useFakeTimers();
    try {
      const delay = vi.fn((attempt: number) => 1000 * 2 ** attempt);
      const { socket, connect, stop } = setup(() => Promise.resolve({ userId: "u1" }), delay);
      await vi.advanceTimersByTimeAsync(0);
      expect(connect).toHaveBeenCalledTimes(1);
      // The database is down: the handshake answers internal, twice.
      fire(socket, "connect_error", new Error("internal"));
      await vi.advanceTimersByTimeAsync(999);
      expect(connect).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(connect).toHaveBeenCalledTimes(2);
      fire(socket, "connect_error", new Error("internal"));
      await vi.advanceTimersByTimeAsync(2000);
      expect(connect).toHaveBeenCalledTimes(3);
      // A refusal that names its wait passes it on.
      const limited = Object.assign(new Error("rate_limited"), { data: { retryAfter: 7 } });
      fire(socket, "connect_error", limited);
      expect(delay).toHaveBeenLastCalledWith(2, 7);
      await vi.advanceTimersByTimeAsync(4000);
      expect(connect).toHaveBeenCalledTimes(4);
      // Back: the next refusal starts the backoff over.
      fire(socket, "connect");
      fire(socket, "connect_error", new Error("internal"));
      expect(delay).toHaveBeenLastCalledWith(0, undefined);
      expect(useIdentityStore.getState().error).toBeNull();
      // Cleanup cancels the pending retry.
      stop();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(connect).toHaveBeenCalledTimes(4);
    } finally {
      vi.useRealTimers();
    }
  });

  it("runs the bootstrap once more on unauthenticated, then reports a second refusal", async () => {
    const ensure = vi.fn(() => Promise.resolve({ userId: "u1", name: null }));
    const { socket, connect, stop } = setup(ensure);
    await tick();
    fire(socket, "connect_error", new Error("unauthenticated"));
    await tick();
    expect(ensure).toHaveBeenLastCalledWith({ force: true, retry: true });
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

  it("reads unauthenticated from Engine.IO's 403 before the socket, and stops its retries", async () => {
    const ensure = vi.fn(() => Promise.resolve({ userId: "u1", name: null }));
    const { socket, connect, stop } = setup(ensure);
    const disconnect = vi.spyOn(socket, "disconnect");
    await tick();
    fire(socket, "connect_error", engineRefusal(403, '{"code":4,"message":"unauthenticated"}'));
    await tick();
    expect(disconnect).toHaveBeenCalledOnce();
    expect(ensure).toHaveBeenLastCalledWith({ force: true, retry: true });
    expect(connect).toHaveBeenCalledTimes(2);
    stop();
  });

  describe("WebSocket only (several instances, #39)", () => {
    /** A socket on WebSocket alone, as with the server's tag, and its session checks. */
    function websocketSetup(session: () => Promise<unknown>) {
      const ensure = vi.fn<Ensure>(() => Promise.resolve({ userId: "u1", name: null }));
      const socket = createSocket({ transports: ["websocket"] });
      const connect = vi.spyOn(socket, "connect").mockReturnValue(socket);
      const disconnect = vi.spyOn(socket, "disconnect");
      const check = vi.fn(session);
      const stop = connectWhenIdentified(socket, {
        ensure,
        delay: (attempt) => 1000 * 2 ** attempt,
        session: check,
      });
      return { socket, connect, disconnect, ensure, check, stop };
    }

    it("asks for the session over HTTP on a websocket error, and signs in again when it is gone", async () => {
      // The server refused the cookieless upgrade (400): the browser only says "websocket error".
      const { socket, connect, disconnect, ensure, check, stop } = websocketSetup(() =>
        Promise.resolve(null),
      );
      await tick();
      fire(socket, "connect_error", new Error("websocket error"));
      await tick();
      expect(check).toHaveBeenCalledOnce();
      expect(disconnect).toHaveBeenCalledOnce();
      expect(ensure).toHaveBeenLastCalledWith({ force: true, retry: true });
      expect(connect).toHaveBeenCalledTimes(2);
      stop();
    });

    it("leaves Socket.IO retrying while the session exists, asking again only after a backoff", async () => {
      vi.useFakeTimers();
      try {
        const { socket, connect, disconnect, ensure, check, stop } = websocketSetup(() =>
          Promise.resolve({ user: { id: "u1" } }),
        );
        await vi.advanceTimersByTimeAsync(0);
        fire(socket, "connect_error", new Error("websocket error"));
        await vi.advanceTimersByTimeAsync(0);
        expect(check).toHaveBeenCalledOnce();
        // Socket.IO's own retries within the first step ask nothing.
        fire(socket, "connect_error", new Error("websocket error"));
        await vi.advanceTimersByTimeAsync(999);
        fire(socket, "connect_error", new Error("websocket error"));
        expect(check).toHaveBeenCalledOnce();
        await vi.advanceTimersByTimeAsync(1);
        fire(socket, "connect_error", new Error("websocket error"));
        expect(check).toHaveBeenCalledTimes(2);
        // A failed check backs off too.
        check.mockRejectedValueOnce(new Error("network"));
        await vi.advanceTimersByTimeAsync(2000);
        fire(socket, "connect_error", new Error("websocket error"));
        await vi.advanceTimersByTimeAsync(0);
        expect(check).toHaveBeenCalledTimes(3);
        fire(socket, "connect_error", new Error("websocket error"));
        expect(check).toHaveBeenCalledTimes(3);
        expect(disconnect).not.toHaveBeenCalled();
        expect(ensure).toHaveBeenCalledOnce();
        expect(connect).toHaveBeenCalledOnce();
        stop();
      } finally {
        vi.useRealTimers();
      }
    });

    it("asks nothing on a websocket error with Socket.IO's default transports", async () => {
      const check = vi.fn(() => Promise.resolve(null));
      const socket = createSocket();
      vi.spyOn(socket, "connect").mockReturnValue(socket);
      const stop = connectWhenIdentified(socket, {
        ensure: () => Promise.resolve({ userId: "u1" }),
        session: check,
      });
      await tick();
      fire(socket, "connect_error", new Error("websocket error"));
      await tick();
      expect(check).not.toHaveBeenCalled();
      stop();
      socket.close();
    });
  });

  it("reports unauthenticated when the second bootstrap fails, and stops on cleanup", async () => {
    const ensure = vi
      .fn<Ensure>()
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
