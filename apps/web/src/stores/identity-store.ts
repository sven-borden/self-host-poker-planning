import { create } from "zustand";

// Who this browser is (#10): a guest the server created, or later (W5) a signed-in user.
// `src/identity/identity.ts` fills it; components read it. The session cookie itself is
// httpOnly and never reaches JavaScript.

/** `retrying`: a temporary failure (`error` holds its code); the bootstrap tries again. */
export type IdentityStatus = "idle" | "loading" | "retrying" | "ready" | "error";

export interface IdentityStoreState {
  status: IdentityStatus;
  /** The server's user id once the session exists. */
  userId: string | null;
  /** The display name; null until the person picks one (#16 asks on joining). */
  name: string | null;
  /** The server's error code when the last attempt failed (`unauthenticated`, …). */
  error: string | null;
  setLoading: () => void;
  setIdentity: (identity: { userId: string; name: string | null }) => void;
  setName: (name: string) => void;
  setError: (code: string) => void;
  setRetrying: (code: string) => void;
  reset: () => void;
}

const initialState = {
  status: "idle" as IdentityStatus,
  userId: null,
  name: null,
  error: null,
};

export const useIdentityStore = create<IdentityStoreState>()((set) => ({
  ...initialState,
  setLoading: () => set({ status: "loading", error: null }),
  setIdentity: ({ userId, name }) => set({ status: "ready", userId, name, error: null }),
  setName: (name) => set({ name }),
  setError: (error) => set({ status: "error", error }),
  setRetrying: (error) => set({ status: "retrying", error }),
  reset: () => set(initialState),
}));
