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

/**
 * The browser refuses the session cookie: a guest was created, yet the next session read
 * has none. No further guest is created on this page; the page asks for cookies.
 */
export const COOKIES_BLOCKED = "cookies_blocked";

/** Failures that may pass on their own (a redeploy, a database restart, a busy limiter). */
export const TEMPORARY_CODES: ReadonlySet<string> = new Set([
  "network",
  "internal",
  "rate_limited",
]);

export interface Identity {
  readonly userId: string;
  /** null until the person picks a name. */
  readonly name: string | null;
}

/** A failed identity call, with the server's code (`rate_limited`, `bad_name`, …). */
export class IdentityError extends Error {
  readonly code: string;
  /** Seconds the server asked to wait (`Retry-After`), when it did. */
  readonly retryAfter: number | undefined;
  constructor(code: string, retryAfter?: number) {
    super(code);
    this.name = "IdentityError";
    this.code = code;
    this.retryAfter = retryAfter;
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
  const retryAfter = Number(response.headers.get("retry-after"));
  return new IdentityError(code, retryAfter > 0 ? retryAfter : undefined);
}

/** `fetch`, with a request that never landed (offline, a redeploy) as `network`. */
async function request(path: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(path, init);
  } catch {
    throw new IdentityError("network");
  }
}

const JSON_POST = {
  method: "POST",
  credentials: "same-origin",
  headers: { "content-type": "application/json" },
} as const;

/** The current session's identity, or null when this browser has none. */
export async function fetchSession(): Promise<Identity | null> {
  const response = await request("/api/auth/get-session", { credentials: "same-origin" });
  if (!response.ok) throw await failure(response);
  const json = (await body(response)) as { user?: ServerUser } | null | undefined;
  return json?.user ? toIdentity(json.user) : null;
}

/** Creates a guest and its session cookie. */
export async function signInAnonymously(): Promise<Identity> {
  const response = await request("/api/auth/sign-in/anonymous", { ...JSON_POST, body: "{}" });
  if (!response.ok) throw await failure(response);
  const json = (await body(response)) as { user?: ServerUser } | undefined;
  return toIdentity(json?.user);
}

let cookiesBlocked = false;

/**
 * The session's identity, or a new guest's. Another tab may sign in at the same moment:
 * the server then answers `not_allowed` (this browser already holds a guest's cookie), and
 * the session that tab created is read instead. The identity is always the one read back
 * from the session, so the store agrees with the cookie the socket sends. A guest whose
 * cookie the browser does not keep is reported as `cookies_blocked`, and no further guest
 * is created on this page.
 */
async function bootstrap(): Promise<Identity> {
  const existing = await fetchSession();
  if (existing) return existing;
  if (cookiesBlocked || globalThis.navigator?.cookieEnabled === false) {
    cookiesBlocked = true;
    throw new IdentityError(COOKIES_BLOCKED);
  }
  try {
    await signInAnonymously();
  } catch (error) {
    if (!(error instanceof IdentityError && error.code === "not_allowed")) throw error;
  }
  const session = await fetchSession();
  if (session) return session;
  cookiesBlocked = true;
  throw new IdentityError(COOKIES_BLOCKED);
}

/**
 * Runs `task` while holding this origin's identity lock, so two tabs opened together
 * create one guest, not two (the second finds the first one's session). Without the Web
 * Locks API it runs at once: `bootstrap` still recovers from the server's `not_allowed`.
 */
function withIdentityLock<T>(task: () => Promise<T>): Promise<T> {
  const locks = globalThis.navigator?.locks;
  return locks?.request ? locks.request("pp-identity", task) : task();
}

/** Backoff of the retries: 1 s doubling up to 30 s, with jitter; see `retryDelay`. */
export const RETRY_BASE_MS = 1000;
export const RETRY_CAP_MS = 30_000;
/** A server's Retry-After above this is not honoured in full. */
const RETRY_AFTER_CAP_SECONDS = 300;

/**
 * Milliseconds before retry number `attempt` (0 for the first): an exponential ceiling
 * (`RETRY_BASE_MS` doubling up to `RETRY_CAP_MS`), half of it fixed and half random so
 * that clients do not come back in step, and never less than the server's Retry-After.
 */
export function retryDelay(
  attempt: number,
  retryAfterSeconds?: number,
  random: () => number = Math.random,
): number {
  const ceiling = Math.min(RETRY_CAP_MS, RETRY_BASE_MS * 2 ** Math.min(attempt, 30));
  const delay = ceiling / 2 + (random() * ceiling) / 2;
  const asked = Math.min(retryAfterSeconds ?? 0, RETRY_AFTER_CAP_SECONDS) * 1000;
  return Math.max(delay, asked);
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

let pending: Promise<Identity> | undefined;

async function run(retry: boolean): Promise<Identity> {
  useIdentityStore.getState().setLoading();
  for (let attempt = 0; ; attempt++) {
    try {
      const identity = await withIdentityLock(bootstrap);
      useIdentityStore.getState().setIdentity(identity);
      return identity;
    } catch (error) {
      const failed = error instanceof IdentityError ? error : new IdentityError("network");
      if (!retry || !TEMPORARY_CODES.has(failed.code)) {
        useIdentityStore.getState().setError(failed.code);
        throw failed;
      }
      useIdentityStore.getState().setRetrying(failed.code);
      await sleep(retryDelay(attempt, failed.retryAfter));
    }
  }
}

/**
 * Resolves with this browser's identity: the store's when it has one, else the session's,
 * else a new guest's. Concurrent calls share one bootstrap. `force` asks the server again
 * even when the store has an identity (after the socket said `unauthenticated`). With
 * `retry`, a temporary failure (`TEMPORARY_CODES`) is retried with backoff until it
 * passes, the store's status being `retrying` meanwhile. A final failure sets the store's
 * `error` and rejects with an `IdentityError`.
 */
export function ensureIdentity({
  force = false,
  retry = false,
}: {
  force?: boolean;
  retry?: boolean;
} = {}): Promise<Identity> {
  const store = useIdentityStore.getState();
  if (!force && !pending && store.status === "ready" && store.userId !== null) {
    return Promise.resolve({ userId: store.userId, name: store.name });
  }
  if (pending) {
    // A bootstrap without retries is running: if it fails for a while, retry after it.
    return retry
      ? pending.catch((error: unknown) =>
          error instanceof IdentityError && TEMPORARY_CODES.has(error.code)
            ? ensureIdentity({ retry })
            : Promise.reject(error),
        )
      : pending;
  }
  pending = run(retry).finally(() => {
    pending = undefined;
  });
  return pending;
}

/**
 * Stores a new display name on the user. The server cleans it (whitespace collapsed,
 * 1 to 32 characters, nothing invisible) and answers with what it stored, which is what
 * the store keeps. Rejects with `IdentityError` (`bad_name`, `rate_limited`, …).
 */
export async function setDisplayName(name: string): Promise<string> {
  await ensureIdentity();
  const response = await request("/api/me/name", { ...JSON_POST, body: JSON.stringify({ name }) });
  if (!response.ok) throw await failure(response);
  const json = (await body(response)) as { name?: unknown } | undefined;
  if (typeof json?.name !== "string") throw new IdentityError("internal");
  useIdentityStore.getState().setName(json.name);
  return json.name;
}

/** For tests: forgets a cookie refusal and a running bootstrap. */
export function resetIdentityModule(): void {
  cookiesBlocked = false;
  pending = undefined;
}
