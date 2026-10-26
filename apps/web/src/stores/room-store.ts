import { create } from "zustand";

// The room store. For now it holds only the connection status; the room projection from
// the server joins it in W1. It renders what the server sends and never decides outcomes.

export type ConnectionStatus = "idle" | "connecting" | "connected" | "reconnecting" | "offline";

export interface RoomStoreState {
  connection: ConnectionStatus;
  setConnection: (connection: ConnectionStatus) => void;
  reset: () => void;
}

const initialState = { connection: "idle" as ConnectionStatus };

export const useRoomStore = create<RoomStoreState>()((set) => ({
  ...initialState,
  setConnection: (connection) => set({ connection }),
  reset: () => set(initialState),
}));
