import { io, type ManagerOptions, type Socket, type SocketOptions } from "socket.io-client";
import { ensureIdentity, UNAUTHENTICATED } from "../identity/identity.ts";
import { useIdentityStore } from "../stores/identity-store.ts";
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
 * Connects `socket` once this browser has a session (`ensureIdentity`), never before: the
 * handshake carries the session cookie and the server refuses a socket without one. When
 * the server still answers `unauthenticated` (the session expired or was revoked), runs
 * the bootstrap once more and reconnects; a second refusal in a row, or a failed
 * bootstrap, sets the identity store's error to `unauthenticated` for the page to show
 * (`errorMessage(t, "unauthenticated")`). Returns a function that removes the listeners.
 */
export function connectWhenIdentified<
  ServerToClient extends EventsMap,
  ClientToServer extends EventsMap,
>(
  socket: TypedSocket<ServerToClient, ClientToServer>,
  ensure: (options?: { force?: boolean }) => Promise<unknown> = ensureIdentity,
): () => void {
  let retried = false;
  let stopped = false;
  const giveUp = () => {
    if (!stopped) useIdentityStore.getState().setError(UNAUTHENTICATED);
  };
  const connect = () => {
    if (!stopped) socket.connect();
  };
  const onConnect = () => {
    retried = false;
  };
  const onConnectError = (error: Error) => {
    if (stopped || error.message !== UNAUTHENTICATED) return;
    if (retried) {
      giveUp();
      return;
    }
    retried = true;
    ensure({ force: true }).then(connect, giveUp);
  };
  socket.on("connect", onConnect);
  socket.on("connect_error", onConnectError);
  // A failed bootstrap already put its code in the store (`rate_limited`, `network`, …).
  ensure().then(connect, () => {});
  return () => {
    stopped = true;
    socket.off("connect", onConnect);
    socket.off("connect_error", onConnectError);
  };
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
  // Socket.IO retries a lost connection on its own while the socket stays active. It does
  // not after a disconnect the client asked for (`io client disconnect`) or one the server
  // forced (`io server disconnect`): then `active` is false and the status is final.
  const onDisconnect = () => onStatus(socket.active ? "reconnecting" : "offline");
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
