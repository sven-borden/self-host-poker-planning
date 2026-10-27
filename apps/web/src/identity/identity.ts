import { useIdentityStore } from "../stores/identity-store.ts";

// The identity bootstrap (#10): a few typed fetch calls to the server's Better Auth
// endpoints instead of `better-auth/client`, which would add about 12 kB gzipped to the
// room route. The session lives in an httpOnly cookie the browser sends on its own; this
// module only learns the user id and the name.

/**
 * The code the server gives a request or a socket handshake without a valid session; the
 * socket sees it as its `connect_error` message.
 */
export const UNAUTHENTICATED = "unauthenticated";

export interface Identity {
  readonly userId: string;
  /** null until the person picks a name. */
  readonly name: string | null;
}

/** A failed identity call, with the server's code (`rate_limited`, `bad_name`, …). */
export class IdentityError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.name = "IdentityError";
    this.code = code;
  }
}

interface ServerUser {
  id?: unknown;
  name?: unknown;
}

function toIdentity(user: ServerUser | undefined): Identity {
  if (typeof user?.id !== "string" || user.id === "") throw new IdentityError("internal");
  const name = typeof user.name === "string" && user.name !== "" ? user.name : null;
  return { userId: user.id, name };
}

/** The JSON body, or undefined when there is none or it is not JSON. */
async function body(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

/** The server's error code from a failed response; `internal` when it sent none. */
async function failure(response: Response): Promise<IdentityError> {
  const json = await body(response);
  const code =
    typeof json === "object" && json !== null && typeof Reflect.get(json, "code") === "string"
      ? (Reflect.get(json, "code") as string)
      : "internal";
  return new IdentityError(code);
}

const JSON_POST = {
  method: "POST",
  credentials: "same-origin",
  headers: { "content-type": "application/json" },
} as const;

/** The current session's identity, or null when this browser has none. */
export async function fetchSession(): Promise<Identity | null> {
  const response = await fetch("/api/auth/get-session", { credentials: "same-origin" });
  if (!response.ok) throw await failure(response);
  const json = (await body(response)) as { user?: ServerUser } | null | undefined;
  return json?.user ? toIdentity(json.user) : null;
}

/** Creates a guest and its session cookie. */
export async function signInAnonymously(): Promise<Identity> {
  const response = await fetch("/api/auth/sign-in/anonymous", { ...JSON_POST, body: "{}" });
  if (!response.ok) throw await failure(response);
  const json = (await body(response)) as { user?: ServerUser } | undefined;
  return toIdentity(json?.user);
}

let pending: Promise<Identity> | undefined;

/**
 * Resolves with this browser's identity: the store's when it has one, else the session's,
 * else a new guest's. Concurrent calls share one request. `force` asks the server again
 * even when the store has an identity (after the socket said `unauthenticated`). A
 * failure sets the store's `error` and rejects with an `IdentityError`.
 */
export function ensureIdentity({ force = false }: { force?: boolean } = {}): Promise<Identity> {
  const store = useIdentityStore.getState();
  if (!force && !pending && store.status === "ready" && store.userId !== null) {
    return Promise.resolve({ userId: store.userId, name: store.name });
  }
  pending ??= (async () => {
    useIdentityStore.getState().setLoading();
    try {
      const identity = (await fetchSession()) ?? (await signInAnonymously());
      useIdentityStore.getState().setIdentity(identity);
      return identity;
    } catch (error) {
      const failed = error instanceof IdentityError ? error : new IdentityError("network");
      useIdentityStore.getState().setError(failed.code);
      throw failed;
    } finally {
      pending = undefined;
    }
  })();
  return pending;
}

/**
 * Stores a new display name on the user. The server cleans it (whitespace collapsed,
 * 1 to 32 characters) and answers with what it stored, which is what the store keeps.
 * Rejects with `IdentityError` (`bad_name`, `unauthenticated`, …).
 */
export async function setDisplayName(name: string): Promise<string> {
  await ensureIdentity();
  let response: Response;
  try {
    response = await fetch("/api/me/name", { ...JSON_POST, body: JSON.stringify({ name }) });
  } catch {
    throw new IdentityError("network");
  }
  if (!response.ok) throw await failure(response);
  const json = (await body(response)) as { name?: unknown } | undefined;
  if (typeof json?.name !== "string") throw new IdentityError("internal");
  useIdentityStore.getState().setName(json.name);
  return json.name;
}
