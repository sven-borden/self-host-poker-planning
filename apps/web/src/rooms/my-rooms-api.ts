import { call, field, jsonInit, RoomApiError } from "./api.ts";

// "My rooms" over HTTP (#49, ADR-027), for the route's own chunk. A room is named by its id in
// an address: its code stays out of every address but the room's. Errors are `RoomApiError`s.

export interface MyRoom {
  readonly id: string;
  readonly code: string;
  /** null for a room created without a name. */
  readonly name: string | null;
  /** The caller holds the PO role. */
  readonly owned: boolean;
  /** The caller holds the right to delete it, which takes the PO role too (ADR-027). */
  readonly keeper: boolean;
  /** No account holds the right to delete this room: nobody can, and it goes when idle. */
  readonly noKeeper: boolean;
  /** The caller holds a seat. */
  readonly seated: boolean;
  /** Rounds started in the room. */
  readonly rounds: number;
  /** ISO 8601. */
  readonly lastActiveAt: string;
}

export interface MyRoomsPage {
  readonly rooms: readonly MyRoom[];
  /** How many idle days this server keeps a room no signed-in person keeps. */
  readonly retentionDays: number;
  /** Where the next page starts, when there is one. */
  readonly next?: string;
  /** A guest's rooms are still moving to this account. */
  readonly moving: boolean;
  /** Rooms were left out, as their rule asks for a more recent sign-in (ADR-028). */
  readonly signInAgain: boolean;
}

function toRoom(raw: unknown): MyRoom {
  const id = field(raw, "id");
  const code = field(raw, "code");
  const name = field(raw, "name");
  const rounds = field(raw, "rounds");
  const lastActiveAt = field(raw, "lastActiveAt");
  if (
    typeof id !== "string" ||
    typeof code !== "string" ||
    typeof rounds !== "number" ||
    typeof lastActiveAt !== "string"
  ) {
    throw new RoomApiError("internal");
  }
  return {
    id,
    code,
    name: typeof name === "string" ? name : null,
    owned: field(raw, "owned") === true,
    keeper: field(raw, "keeper") === true,
    seated: field(raw, "seated") === true,
    noKeeper: field(raw, "noKeeper") === true,
    rounds,
    lastActiveAt,
  };
}

/** One page of the rooms this person owns or holds a seat in, the last active first. */
export async function fetchMyRooms(after?: string): Promise<MyRoomsPage> {
  const query = after === undefined ? "" : `?after=${encodeURIComponent(after)}`;
  const body = await call(`/api/my-rooms${query}`);
  const rooms = field(body, "rooms");
  const retentionDays = field(body, "retentionDays");
  const next = field(body, "next");
  if (!Array.isArray(rooms) || typeof retentionDays !== "number") {
    throw new RoomApiError("internal");
  }
  return {
    rooms: rooms.map(toRoom),
    retentionDays,
    ...(typeof next === "string" && { next }),
    moving: field(body, "moving") === true,
    signInAgain: field(body, "signInAgain") === true,
  };
}

const path = (id: string) => `/api/my-rooms/${encodeURIComponent(id)}`;

/** Renames a room, its PO only, and resolves with the name the server stored. */
export async function renameMyRoom(id: string, name: string): Promise<string> {
  const stored = field(await call(path(id), jsonInit("PATCH", { name })), "name");
  if (typeof stored !== "string") throw new RoomApiError("internal");
  return stored;
}

/** Deletes a room and all it holds, for someone who is its PO and its keeper. */
export async function deleteMyRoom(id: string): Promise<void> {
  await call(path(id), jsonInit("DELETE"));
}

/** Gives up this person's seat in a room. */
export async function leaveMyRoom(id: string): Promise<void> {
  await call(`${path(id)}/leave`, jsonInit("POST", {}));
}
