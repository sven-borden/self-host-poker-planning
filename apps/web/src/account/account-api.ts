import { saveFile } from "../lib/save-file.ts";
import { call, field, jsonInit, RoomApiError } from "../rooms/api.ts";

// The account page over HTTP (#51, ADR-029), for the route's own chunk. Errors are `RoomApiError`s.

/** Someone in a room this person keeps, who can take it. */
export interface RoomSeat {
  readonly id: string;
  readonly name: string;
}

/** Why the first seat is the default: the same order as the server's (`heirsOf`). */
export type DefaultReason = "runsTheRoom" | "here" | "away" | "nobody";

const DEFAULT_REASONS: readonly unknown[] = ["runsTheRoom", "here", "away", "nobody"];

/** A room this person keeps, with other people in it: the default first. */
export interface SharedRoom {
  readonly id: string;
  readonly name: string | null;
  readonly lastActiveAt: string;
  readonly seats: readonly RoomSeat[];
  readonly why: DefaultReason;
}

export interface AccountOverview {
  /** The session started recently enough for a deletion. */
  readonly recent: boolean;
  /** Rooms this person keeps with nobody else in them. */
  readonly alone: number;
  /** Rooms someone else keeps where this person's seat or role goes. */
  readonly seats: number;
  /** Rooms this person keeps whose rule now refuses them: only how many. */
  readonly held: number;
  /** Rooms this person keeps that a new sign-in would show: the rule passes the account. */
  readonly signInAgain: number;
  readonly shared: readonly SharedRoom[];
  /** How many idle days this server keeps a room no signed-in person keeps. */
  readonly retentionDays: number;
  /** A guest's rooms are still moving to this account. */
  readonly moving: boolean;
}

/** What a person chose for a room: someone seated, or to delete it. */
export type RoomChoice = { readonly id: string; readonly to: string } | DeleteChoice;
type DeleteChoice = { readonly id: string; readonly delete: true };

/** What a file left out for now: a number, 0 when nothing. */
const moreRooms = (body: unknown): number => {
  const count = field(body, "signInAgain");
  return typeof count === "number" ? count : 0;
};

function toRoom(raw: unknown): SharedRoom {
  const id = field(raw, "id");
  const name = field(raw, "name");
  const lastActiveAt = field(raw, "lastActiveAt");
  const seats = field(raw, "seats");
  const why = field(raw, "why");
  if (
    typeof id !== "string" ||
    typeof lastActiveAt !== "string" ||
    !Array.isArray(seats) ||
    !DEFAULT_REASONS.includes(why)
  ) {
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
    why: why as DefaultReason,
  };
}

export async function fetchAccount(): Promise<AccountOverview> {
  const body = await call("/api/account");
  const shared = field(body, "shared");
  const alone = field(body, "alone");
  const seats = field(body, "seats");
  const held = field(body, "held");
  const retentionDays = field(body, "retentionDays");
  if (
    !Array.isArray(shared) ||
    typeof alone !== "number" ||
    typeof seats !== "number" ||
    typeof held !== "number" ||
    typeof retentionDays !== "number"
  ) {
    throw new RoomApiError("internal");
  }
  return {
    recent: field(body, "recent") === true,
    alone,
    seats,
    held,
    signInAgain: moreRooms(body),
    shared: shared.map(toRoom),
    retentionDays,
    moving: field(body, "moving") === true,
  };
}

/** Saves the person's data as a file, and says what it does not hold yet. */
export async function downloadAccount(): Promise<{ complete: boolean; signInAgain: number }> {
  const file = await call("/api/account/export");
  saveFile(JSON.stringify(file, null, 2), "poker-planning-account.json", "application/json");
  return { complete: field(file, "incomplete") !== true, signInAgain: moreRooms(file) };
}

/** Starts the deletion, and resolves whether it finished by the end of the server's wait. */
export async function deleteAccount(
  confirm: string,
  rooms: readonly RoomChoice[],
): Promise<boolean> {
  const body = await call("/api/account/delete", jsonInit("POST", { confirm, rooms }));
  return field(body, "finished") === true;
}
