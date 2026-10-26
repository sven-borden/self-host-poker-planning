import { io, type ManagerOptions, type Socket, type SocketOptions } from "socket.io-client";
import type { ConnectionStatus } from "../stores/room-store.ts";

// A thin, typed wrapper over the Socket.IO client. The event maps come from
// `@pp/protocol` once #5 defines them; until then callers pass their own.

/** Same shape as Socket.IO's own EventsMap: event name to listener signature. */
// biome-ignore lint/suspicious/noExplicitAny: mirrors Socket.IO's EventsMap constraint.
export type EventsMap = Record<string, (...args: any[]) => void>;

export type TypedSocket<
  ServerToClient extends EventsMap,
  ClientToServer extends EventsMap,
> = Socket<ServerToClient, ClientToServer>;

export type SocketFactoryOptions = Partial<ManagerOptions & SocketOptions>;

/**
 * Creates a socket to the page's own origin without connecting it: the caller decides
 * when to call `connect()`. Nothing in the app connects at module load.
 */
export function createSocket<ServerToClient extends EventsMap, ClientToServer extends EventsMap>(
  options: SocketFactoryOptions = {},
): TypedSocket<ServerToClient, ClientToServer> {
  return io({
    path: "/socket.io",
    autoConnect: false,
    withCredentials: true,
    ...options,
  });
}

/**
 * Mirrors the socket's connection state into `onStatus` (typically the room store's
 * `setConnection`). Returns a function that removes the listeners.
 */
export function trackConnection<ServerToClient extends EventsMap, ClientToServer extends EventsMap>(
  socket: TypedSocket<ServerToClient, ClientToServer>,
  onStatus: (status: ConnectionStatus) => void,
): () => void {
  const onConnect = () => onStatus("connected");
  const onDisconnect = (reason: Socket.DisconnectReason) => {
    // A disconnect the client asked for is final; any other one is retried by Socket.IO.
    onStatus(reason === "io client disconnect" ? "offline" : "reconnecting");
  };
  const onConnectError = () => onStatus(socket.active ? "reconnecting" : "offline");
  const onReconnectAttempt = () => onStatus("reconnecting");

  socket.on("connect", onConnect);
  socket.on("disconnect", onDisconnect);
  socket.on("connect_error", onConnectError);
  socket.io.on("reconnect_attempt", onReconnectAttempt);

  return () => {
    socket.off("connect", onConnect);
    socket.off("disconnect", onDisconnect);
    socket.off("connect_error", onConnectError);
    socket.io.off("reconnect_attempt", onReconnectAttempt);
  };
}
