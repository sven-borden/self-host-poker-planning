import type { Snapshot } from "@pp/protocol";
import { create } from "zustand";

// The room store: the latest snapshot the server sent for the open room, and where the
// connection stands. `realtime/room-connection.ts` fills it; components only render it.
// It never decides an outcome: every change comes from the server as a new snapshot.

/** The socket's own state, as `trackConnection` reports it. */
export type ConnectionStatus = "idle" | "connecting" | "connected" | "reconnecting" | "offline";

/**
 * The room's state for the page:
 * - `connecting`: the first connection and `enter` are under way;
 * - `live`: entered; snapshots arrive as the room changes;
 * - `reconnecting`: the connection dropped or the server refused for a while; the last
 *   snapshot stays on screen;
 * - `error`: final until the page reloads; `error` says why.
 */
export type RoomStatus = "idle" | "connecting" | "live" | "reconnecting" | "error";

/**
 * Why the room is in `error`: an ack code (`room_not_found`, `protocol_mismatch`,
 * `unauthenticated`, …), or `kicked` and `offline` from the connection itself.
 */
export type RoomError = string;

export interface RoomStoreState {
  /** The room code the open page follows; null when no room page is open. */
  code: string | null;
  status: RoomStatus;
  error: RoomError | null;
  /** The newest snapshot of the room for this viewer; null before the first one. */
  snapshot: Snapshot | null;
  connection: ConnectionStatus;
  /** Starts following `code`; a different code drops the snapshot held. */
  open: (code: string) => void;
  /**
   * Keeps `snapshot` when it belongs to the open room and is newer than the one held.
   * Versions only grow on the server, so an older or equal one is stale (an answer that
   * crossed a broadcast). Returns whether it was kept.
   */
  receive: (snapshot: Snapshot) => boolean;
  setStatus: (status: Exclude<RoomStatus, "error">) => void;
  fail: (error: RoomError) => void;
  setConnection: (connection: ConnectionStatus) => void;
  reset: () => void;
}

const initialState = {
  code: null,
  status: "idle" as RoomStatus,
  error: null,
  snapshot: null,
  connection: "idle" as ConnectionStatus,
};

export const useRoomStore = create<RoomStoreState>()((set, get) => ({
  ...initialState,
  open: (code) =>
    set((state) => ({
      code,
      status: "connecting",
      error: null,
      snapshot: state.code === code ? state.snapshot : null,
    })),
  receive: (snapshot) => {
    const { code, snapshot: held } = get();
    if (snapshot.room.code !== code) return false;
    if (held && snapshot.version <= held.version) return false;
    set({ snapshot });
    return true;
  },
  setStatus: (status) => set({ status, error: null }),
  fail: (error) => set({ status: "error", error }),
  setConnection: (connection) => set({ connection }),
  reset: () => set(initialState),
}));
