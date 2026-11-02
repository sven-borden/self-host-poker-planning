import { createRoom } from "@pp/domain";
import { toSnapshot } from "@pp/protocol";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { changeLanguage } from "../i18n/i18n.ts";
import { useRoomStore } from "../stores/room-store.ts";
import { RoomStatus } from "./room-status.tsx";

// The way home is a router link: a plain anchor stands in for it.
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, className }: { children: ReactNode; className?: string }) => (
    <a href="/" className={className}>
      {children}
    </a>
  ),
}));

afterEach(async () => {
  cleanup();
  useRoomStore.getState().reset();
  vi.restoreAllMocks();
  await act(() => changeLanguage("en"));
});

describe("RoomStatus", () => {
  it("shows the connection status and how many people are in the room", () => {
    let state = createRoom({ ownerId: "ua" });
    state = {
      ...state,
      participants: {
        ua: { name: "Ada", role: "voter", joinedAt: 1, connected: true },
        ub: { name: "Bob", role: "voter", joinedAt: 2, connected: true },
      },
    };
    const store = useRoomStore.getState();
    store.open("abc");
    render(<RoomStatus />);
    expect(screen.getByRole("status").textContent).toBe("Connecting to the room…");
    act(() => {
      store.receive(toSnapshot(state, "ua", { code: "abc", version: 2, now: 0 }));
      store.setStatus("live");
    });
    expect(screen.getByRole("status").textContent).toBe("Connected");
    expect(screen.getByTestId("room-people").textContent).toBe("2 people in the room");
    act(() => store.setStatus("reconnecting"));
    expect(screen.getByRole("status").textContent).toBe("Connection lost. Reconnecting…");
  });

  it("asks for a reload when the app is out of date, in the reader's language", async () => {
    const reload = vi.fn();
    vi.spyOn(window, "location", "get").mockReturnValue({ ...window.location, reload });
    await act(() => changeLanguage("de"));
    useRoomStore.getState().open("abc");
    useRoomStore.getState().fail("protocol_mismatch");
    render(<RoomStatus />);
    expect(screen.getByRole("alert").textContent).toContain(
      "Eine neue Version der App ist verfügbar.",
    );
    fireEvent.click(screen.getByRole("button", { name: "Neu laden" }));
    expect(reload).toHaveBeenCalledOnce();
  });

  it.each([
    "offline",
    "not_participant",
    "unauthenticated",
    "bad_payload",
    "bad_command",
    "from_the_future",
  ])("%s asks for a reload and gives a button for it, beside the way home", (code) => {
    const reload = vi.fn();
    vi.spyOn(window, "location", "get").mockReturnValue({ ...window.location, reload });
    useRoomStore.getState().open("abc");
    useRoomStore.getState().fail(code);
    render(<RoomStatus />);
    expect(screen.getByRole("alert").textContent).toMatch(/reload/i);
    fireEvent.click(screen.getByRole("button", { name: "Reload" }));
    expect(reload).toHaveBeenCalledOnce();
    expect(screen.getByRole("link", { name: "Back to the home page" })).toBeTruthy();
  });

  it("offers no reload for an error that does not ask for one", () => {
    useRoomStore.getState().open("abc");
    useRoomStore.getState().fail("room_full");
    render(<RoomStatus />);
    expect(screen.queryByRole("button", { name: "Reload" })).toBeNull();
    expect(screen.getByRole("link", { name: "Back to the home page" })).toBeTruthy();
  });
});
