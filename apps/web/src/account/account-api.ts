import { saveFile } from "../lib/save-file.ts";
import { call, field, jsonInit, RoomApiError } from "../rooms/api.ts";

// The account page over HTTP (#51, ADR-029), for the route's own chunk. Errors are `RoomApiError`s.

/** Someone in a room this person keeps, who can take it. */
export interface RoomSeat {
  readonly id: string;
  readonly name: string;
}

/** A room this person keeps, with other people in it: the longest seated first. */
export interface SharedRoom {
  readonly id: string;
  readonly name: string | null;
  readonly lastActiveAt: string;
  readonly seats: readonly RoomSeat[];
}

export interface AccountOverview {
  /** The session started recently enough for a deletion. */
  readonly recent: boolean;
  /** Rooms this person keeps with nobody else in them. */
  readonly alone: number;
  /** Rooms someone else keeps where this person's seat or role goes. */
  readonly seats: number;
  readonly shared: readonly SharedRoom[];
  /** How many idle days this server keeps a room no signed-in person keeps. */
  readonly retentionDays: number;
  /** A guest's rooms are still moving to this account. */
  readonly moving: boolean;
}

/** What a person chose for a room: someone seated, or to delete it. */
export type RoomChoice = { readonly id: string; readonly to: string } | DeleteChoice;
type DeleteChoice = { readonly id: string; readonly delete: true };

function toRoom(raw: unknown): SharedRoom {
  const id = field(raw, "id");
  const name = field(raw, "name");
  const lastActiveAt = field(raw, "lastActiveAt");
  const seats = field(raw, "seats");
  if (typeof id !== "string" || typeof lastActiveAt !== "string" || !Array.isArray(seats)) {
    throw new RoomApiError("internal");
  }
  return {
    id,
    name: typeof name === "string" ? name : null,
    lastActiveAt,
    seats: seats.map((seat: unknown) => ({
      id: String(field(seat, "id")),
      name: String(field(seat, "name")),
    })),
  };
}

export async function fetchAccount(): Promise<AccountOverview> {
  const body = await call("/api/account");
  const shared = field(body, "shared");
  const alone = field(body, "alone");
  const seats = field(body, "seats");
  const retentionDays = field(body, "retentionDays");
  if (
    !Array.isArray(shared) ||
    typeof alone !== "number" ||
    typeof seats !== "number" ||
    typeof retentionDays !== "number"
  ) {
    throw new RoomApiError("internal");
  }
  return {
    recent: field(body, "recent") === true,
    alone,
    seats,
    shared: shared.map(toRoom),
    retentionDays,
    moving: field(body, "moving") === true,
  };
}

/** Saves the person's data as a file, and resolves whether it holds all of it. */
export async function downloadAccount(): Promise<boolean> {
  const file = await call("/api/account/export");
  saveFile(JSON.stringify(file, null, 2), "poker-planning-account.json", "application/json");
  return field(file, "incomplete") !== true;
}

/** Starts the deletion, and resolves whether it finished by the end of the server's wait. */
export async function deleteAccount(
  confirm: string,
  rooms: readonly RoomChoice[],
): Promise<boolean> {
  const body = await call("/api/account/delete", jsonInit("POST", { confirm, rooms }));
  return field(body, "finished") === true;
}
