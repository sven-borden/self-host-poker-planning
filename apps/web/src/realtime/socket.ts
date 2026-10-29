import { io, type ManagerOptions, type Socket, type SocketOptions } from "socket.io-client";
import { ensureIdentity, retryDelay, UNAUTHENTICATED } from "../identity/identity.ts";
import { useIdentityStore } from "../stores/identity-store.ts";
import type { ConnectionStatus } from "../stores/room-store.ts";

// A thin, typed wrapper over the Socket.IO client. The room's event maps come from
// `@pp/protocol` (`realtime/room-connection.ts`); the tests pass their own.

/**
 * Socket.IO's own EventsMap: event name to listener signature. An interface with an `any`
 * index signature, as Socket.IO declares it, so the protocol's event interfaces fit.
 */
export interface EventsMap {
  // biome-ignore lint/suspicious/noExplicitAny: mirrors Socket.IO's EventsMap constraint.
  [event: string]: any;
}

export type TypedSocket<
  ServerToClient extends EventsMap,
  ClientToServer extends EventsMap,
> = Socket<ServerToClient, ClientToServer>;

export type SocketFactoryOptions = Partial<ManagerOptions & SocketOptions>;

/**
 * The transports the server takes, from the tag it puts in `index.html` (#39): with several
 * instances behind one address it takes WebSocket only, so one connection stays on one
 * instance. Without the tag (one instance), undefined: Socket.IO's default, long-polling
 * first, then the upgrade. A tag and not a script, since the CSP refuses inline script.
 */
export function socketTransports(doc: Document | undefined = globalThis.document) {
  const meta = doc?.querySelector('meta[name="pp-socket-transport"]');
  return meta?.getAttribute("content") === "websocket" ? ["websocket"] : undefined;
}

/**
 * Creates a socket to the page's own origin without connecting it: the caller decides
 * when to call `connect()`. Nothing in the app connects at module load.
 */
export function createSocket<ServerToClient extends EventsMap, ClientToServer extends EventsMap>(
  options: SocketFactoryOptions = {},
): TypedSocket<ServerToClient, ClientToServer> {
  const transports = socketTransports();
  return io({
    path: "/socket.io",
    autoConnect: false,
    withCredentials: true,
    ...(transports && { transports }),
    ...options,
  });
}

/**
 * Handshake refusals that pass on their own (the database is back, the limiter's window
 * ends): `connectWhenIdentified` connects again after a backoff, so the status stays
 * `reconnecting`. Socket.IO itself never retries a refusal from a server middleware.
 */
export const RETRIED_REFUSALS: ReadonlySet<string> = new Set(["internal", "rate_limited"]);

/** What `connectWhenIdentified` may be handed instead of the real bootstrap and clock. */
export interface ConnectOptions {
  ensure?: (options?: { force?: boolean; retry?: boolean }) => Promise<unknown>;
  /** Milliseconds before retry number `attempt`, and the server's Retry-After if any. */
  delay?: (attempt: number, retryAfterSeconds?: number) => number;
}

/** The `retryAfter` (seconds) a server put in a refusal's `data`, if any. */
function retryAfterOf(error: Error): number | undefined {
  const data = (error as Error & { data?: unknown }).data;
  const value =
    typeof data === "object" && data !== null ? Reflect.get(data, "retryAfter") : undefined;
  return typeof value === "number" && value > 0 ? value : undefined;
}

/**
 * The server's refusal code in a `connect_error`: a handshake middleware's message, or,
 * when Engine.IO refused the request before any socket (no session cookie, #36), the
 * message of its 403, which the polling transport hands over with the XHR. Anything else
 * (the network, a 5xx) keeps Socket.IO's own message.
 */
export function refusalOf(error: Error): string {
  const { description, context } = error as Error & { description?: unknown; context?: unknown };
  if (description !== 403 || typeof context !== "object" || context === null) {
    return error.message;
  }
  try {
    const body: unknown = JSON.parse(String(Reflect.get(context, "responseText")));
    const message =
      typeof body === "object" && body !== null ? Reflect.get(body, "message") : undefined;
    return typeof message === "string" ? message : error.message;
  } catch {
    return error.message;
  }
}

/**
 * Connects `socket` once this browser has a session (`ensureIdentity`, retried with
 * backoff while it fails for a temporary reason such as a redeploy), never before: the
 * handshake carries the session cookie and the server refuses a socket without one.
 * - `internal` or `rate_limited` (`RETRIED_REFUSALS`): connects again after a capped,
 *   jittered exponential backoff that honours a `retryAfter` the server sends, until it
 *   passes; a successful connect starts the backoff over.
 * - `unauthenticated` (the session expired or was revoked, or the cookie is gone): stops
 *   Socket.IO's own retries, runs the bootstrap once more and reconnects; a second refusal in a row, or a failed bootstrap, sets the identity
 *   store's error to `unauthenticated` for the page to show.
 * Returns a function that removes the listeners and cancels a pending retry.
 */
export function connectWhenIdentified<
  ServerToClient extends EventsMap,
  ClientToServer extends EventsMap,
>(
  socket: TypedSocket<ServerToClient, ClientToServer>,
  { ensure = ensureIdentity, delay = retryDelay }: ConnectOptions = {},
): () => void {
  let retried = false;
  let stopped = false;
  let attempt = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const giveUp = () => {
    if (!stopped) useIdentityStore.getState().setError(UNAUTHENTICATED);
  };
  const connect = () => {
    if (!stopped) socket.connect();
  };
  const onConnect = () => {
    retried = false;
    attempt = 0;
  };
  const onConnectError = (error: Error) => {
    if (stopped) return;
    const code = refusalOf(error);
    if (RETRIED_REFUSALS.has(code)) {
      clearTimeout(timer);
      timer = setTimeout(connect, delay(attempt++, retryAfterOf(error)));
      return;
    }
    if (code !== UNAUTHENTICATED) return;
    // A refusal before the socket (Engine.IO's 403) leaves Socket.IO retrying without
    // the cookie; after a middleware's, the socket is already closed and this is a no-op.
    socket.disconnect();
    if (retried) {
      giveUp();
      return;
    }
    retried = true;
    ensure({ force: true, retry: true }).then(connect, giveUp);
  };
  socket.on("connect", onConnect);
  socket.on("connect_error", onConnectError);
  // A final bootstrap failure already put its code in the store (`cookies_blocked`, …).
  ensure({ retry: true }).then(connect, () => {});
  return () => {
    stopped = true;
    clearTimeout(timer);
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
  // A refusal `connectWhenIdentified` retries is not final either.
  const onConnectError = (error: Error) =>
    onStatus(socket.active || RETRIED_REFUSALS.has(error.message) ? "reconnecting" : "offline");
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
