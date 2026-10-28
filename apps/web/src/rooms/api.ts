import type { PresetDeckId } from "@pp/domain";
import { ensureIdentity, UNAUTHENTICATED } from "../identity/identity.ts";

// The room API over HTTP (#14): create a room, read a room's header (code and name). The
// room itself arrives over the socket (#15). Errors carry the server's code, which the
// page turns into a sentence with `errorMessage`.

/** A failed room call: the server's code (`rate_limited`, `room_not_found`, …), or `network`. */
export class RoomApiError extends Error {
  readonly code: string;
  /** With `room_not_found`: how many idle days this server keeps a room, when it says. */
  readonly retentionDays: number | undefined;
  /** With `rate_limited`: the seconds to wait (`Retry-After`), when the server says. */
  readonly retryAfter: number | undefined;
  constructor(code: string, retentionDays?: number, retryAfter?: number) {
    super(code);
    this.name = "RoomApiError";
    this.code = code;
    this.retentionDays = retentionDays;
    this.retryAfter = retryAfter;
  }
}

/** What anyone holding the link may read before entering: never the room's state. */
export interface RoomHeader {
  readonly code: string;
  /** null for a room created without a name. */
  readonly name: string | null;
  /** The room asks for a password (#31); false from a server before #31. */
  readonly hasPassword: boolean;
}

async function json(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

function field(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined;
}

async function call(path: string, init: RequestInit = {}): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(path, { credentials: "same-origin", ...init });
  } catch {
    throw new RoomApiError("network");
  }
  const body = await json(response);
  if (!response.ok) {
    const code = field(body, "code");
    const days = field(body, "retentionDays");
    const wait = Number(response.headers.get("retry-after"));
    throw new RoomApiError(
      typeof code === "string" ? code : "internal",
      Number.isSafeInteger(days) && (days as number) > 0 ? (days as number) : undefined,
      Number.isFinite(wait) && wait > 0 ? wait : undefined,
    );
  }
  return body;
}

function post(name: string | undefined, deck: PresetDeckId): Promise<unknown> {
  return call("/api/rooms", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...(name !== undefined && { name }), deck }),
  });
}

/**
 * Creates a room and resolves with its code; this browser's guest becomes its product
 * owner. `name` is sent only when it holds more than whitespace. A session that ended
 * meanwhile (`unauthenticated`) is renewed once.
 */
export async function createRoom(input: { name: string; deck: PresetDeckId }): Promise<string> {
  const name = input.name.trim() === "" ? undefined : input.name;
  await ensureIdentity();
  let body: unknown;
  try {
    body = await post(name, input.deck);
  } catch (error) {
    if (!(error instanceof RoomApiError && error.code === UNAUTHENTICATED)) throw error;
    await ensureIdentity({ force: true });
    body = await post(name, input.deck);
  }
  const code = field(body, "code");
  if (typeof code !== "string") throw new RoomApiError("internal");
  return code;
}

/** The room's header, or a `RoomApiError` (`room_not_found` for an unknown code). */
export async function fetchRoomHeader(code: string): Promise<RoomHeader> {
  const body = await call(`/api/rooms/${encodeURIComponent(code)}`);
  const found = field(body, "code");
  const name = field(body, "name");
  if (typeof found !== "string") throw new RoomApiError("internal");
  return {
    code: found,
    name: typeof name === "string" ? name : null,
    hasPassword: field(body, "hasPassword") === true,
  };
}

const jsonInit = (method: string, body?: object): RequestInit => ({
  method,
  ...(body !== undefined && {
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }),
});

/**
 * Sets or changes the room's password (#31), the PO only: resolves once the server stored
 * it, or throws a `RoomApiError` (`bad_password`, `not_allowed`, `rate_limited`, …).
 * The password travels in the body of this one request, never over the socket.
 */
export async function setRoomPassword(code: string, password: string): Promise<void> {
  await call(`/api/rooms/${encodeURIComponent(code)}/password`, jsonInit("PUT", { password }));
}

/** Removes the room's password (#31), the PO only. */
export async function removeRoomPassword(code: string): Promise<void> {
  await call(`/api/rooms/${encodeURIComponent(code)}/password`, jsonInit("DELETE"));
}

/**
 * Checks the room's password (#31): resolves when it is right, and this browser's user
 * may then enter the room; throws `wrong_password`, or `rate_limited` with `retryAfter`.
 */
export async function enterRoomPassword(code: string, password: string): Promise<void> {
  await call(`/api/rooms/${encodeURIComponent(code)}/access`, jsonInit("POST", { password }));
}
