import { createRoom, type Participant, type RoomState } from "@pp/domain";
import { toSnapshot } from "@pp/protocol";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { changeLanguage } from "../i18n/i18n.ts";
import { IdentityError } from "../identity/identity.ts";
import { useIdentityStore } from "../stores/identity-store.ts";
import { useRoomStore } from "../stores/room-store.ts";
import { RoomView } from "./room-view.tsx";

const mocks = vi.hoisted(() => ({ sendCommand: vi.fn(), setDisplayName: vi.fn() }));
vi.mock("../realtime/room-connection.ts", () => ({ sendCommand: mocks.sendCommand }));
vi.mock("../identity/identity.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../identity/identity.ts")>()),
  setDisplayName: mocks.setDisplayName,
}));

const CODE = "abcdefghij";
const ME = "me";
let version = 1;

function stateWith(
  people: Array<[string, string, Participant["role"]]>,
  settings: Partial<RoomState["settings"]> = {},
): RoomState {
  const state = createRoom({ ownerId: "po" });
  const participants: Record<string, Participant> = {};
  people.forEach(([id, name, role], i) => {
    participants[id] = { name, role, joinedAt: i + 1, connected: true };
  });
  return { ...state, settings: { ...state.settings, ...settings }, participants };
}

/** The server's next snapshot of `state`, as this viewer sees it. */
function show(state: RoomState) {
  act(() => {
    version += 1;
    useRoomStore.getState().receive(toSnapshot(state, ME, { code: CODE, version, now: 0 }));
    useRoomStore.getState().setStatus("live");
  });
}

/** RoomView inside a router, for the room-full screen's link home. */
async function renderView() {
  const router = createRouter({
    routeTree: createRootRoute({ component: RoomView }),
    history: createMemoryHistory({ initialEntries: [`/r/${CODE}`] }),
  });
  await act(async () => {
    render(<RouterProvider router={router} />);
    await router.load();
  });
}

const others: Array<[string, string, Participant["role"]]> = [
  ["ua", "Ana", "voter"],
  ["ub", "Ben", "observer"],
];
const joined = stateWith([...others, [ME, "Cleo", "voter"]]);

beforeEach(() => {
  // The router restores the scroll position, which jsdom does not implement.
  vi.spyOn(window, "scrollTo").mockImplementation(() => {});
  version = 1;
  useRoomStore.getState().open(CODE);
});

afterEach(async () => {
  cleanup();
  useRoomStore.getState().reset();
  useIdentityStore.getState().reset();
  mocks.sendCommand.mockReset();
  mocks.setDisplayName.mockReset();
  vi.restoreAllMocks();
  await act(() => changeLanguage("en"));
});

describe("the join form", () => {
  it("prefills the saved name, saves it, then joins with the role picked", async () => {
    useIdentityStore.getState().setIdentity({ userId: ME, name: "Cleo" });
    await renderView();
    show(stateWith(others));
    const name = screen.getByRole("textbox", { name: "Your name" });
    expect(name).toHaveProperty("value", "Cleo");
    expect(screen.getByRole("radio", { name: /^Voter/ })).toHaveProperty("checked", true);
    fireEvent.change(name, { target: { value: "  Cleo   M " } });
    fireEvent.click(screen.getByRole("radio", { name: /^Observer/ }));
    mocks.setDisplayName.mockResolvedValue("Cleo M");
    mocks.sendCommand.mockImplementation(async () => {
      // The server broadcasts before it acks: the snapshot with `you` comes first.
      show(stateWith([...others, [ME, "Cleo M", "observer"]]));
      return { ok: true, version };
    });
    fireEvent.click(screen.getByRole("button", { name: "Join the room" }));
    await waitFor(() => expect(screen.getByRole("heading", { name: "You" })).toBeTruthy());
    expect(mocks.setDisplayName).toHaveBeenCalledWith("  Cleo   M ");
    expect(mocks.sendCommand).toHaveBeenCalledWith({
      type: "join",
      payload: { name: "Cleo M", role: "observer" },
    });
    // The form is gone, so the focus moves to the viewer's own panel.
    expect(document.activeElement).toBe(screen.getByRole("heading", { name: "You" }));
    expect(screen.getByText("Watching, not voting")).toBeTruthy();
  });

  it("takes the saved name when it arrives after the form, unless the field was typed in", async () => {
    await renderView();
    show(stateWith(others));
    const name = screen.getByRole("textbox", { name: "Your name" });
    expect(name).toHaveProperty("value", "");
    act(() => useIdentityStore.getState().setIdentity({ userId: ME, name: "Dee" }));
    expect(name).toHaveProperty("value", "Dee");
    fireEvent.change(name, { target: { value: "Dora" } });
    act(() => useIdentityStore.getState().setName("Dee 2"));
    expect(name).toHaveProperty("value", "Dora");
  });

  it("refuses a bad name in the browser, links the error and focuses the field", async () => {
    await renderView();
    show(stateWith(others));
    const name = screen.getByRole("textbox", { name: "Your name" });
    for (const bad of ["   ", "x".repeat(33), "Sv\u{200B}en"]) {
      fireEvent.change(name, { target: { value: bad } });
      fireEvent.click(screen.getByRole("button", { name: "Join the room" }));
      const alert = screen.getByRole("alert");
      expect(alert.textContent).toBe("A name needs 1 to 32 characters. Choose another one.");
      expect(name.getAttribute("aria-invalid")).toBe("true");
      expect(name.getAttribute("aria-describedby")).toContain(alert.id);
      expect(document.activeElement).toBe(name);
    }
    expect(mocks.setDisplayName).not.toHaveBeenCalled();
    expect(mocks.sendCommand).not.toHaveBeenCalled();
  });

  it("shows what the server or the network said", async () => {
    await renderView();
    show(stateWith(others));
    fireEvent.change(screen.getByRole("textbox", { name: "Your name" }), {
      target: { value: "Eve" },
    });
    const submit = screen.getByRole("button", { name: "Join the room" });
    mocks.setDisplayName.mockRejectedValueOnce(new IdentityError("rate_limited"));
    fireEvent.click(submit);
    await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/Too many attempts/));
    mocks.setDisplayName.mockRejectedValueOnce(new IdentityError("network"));
    fireEvent.click(submit);
    await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/Could not reach/));
    mocks.setDisplayName.mockResolvedValue("Eve");
    mocks.sendCommand.mockResolvedValueOnce({ ok: false, code: "offline" });
    fireEvent.click(submit);
    await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/connection/));
    mocks.sendCommand.mockResolvedValueOnce({ ok: false, code: "something_new" });
    fireEvent.click(submit);
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toBe(
        "Something went wrong. Try again, or reload the page.",
      ),
    );
    // Another tab of this browser joined first: no error, the snapshot brings the seat.
    mocks.sendCommand.mockResolvedValueOnce({ ok: false, code: "already_joined" });
    fireEvent.click(submit);
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  });

  it("shows the room-full screen on room_full, and the form again once the room changes", async () => {
    await renderView();
    show(stateWith(others));
    fireEvent.change(screen.getByRole("textbox", { name: "Your name" }), {
      target: { value: "Eve" },
    });
    mocks.setDisplayName.mockResolvedValue("Eve");
    mocks.sendCommand.mockResolvedValueOnce({ ok: false, code: "room_full" });
    fireEvent.click(screen.getByRole("button", { name: "Join the room" }));
    await waitFor(() => expect(screen.getByRole("heading", { name: "This room is full" })));
    expect(screen.getByRole("link", { name: "Back to the home page" })).toBeTruthy();
    show(stateWith(others.slice(0, 1)));
    expect(screen.getByRole("button", { name: "Join the room" })).toBeTruthy();
  });

  it("shows the room-full screen at once when the snapshot shows 16 people", async () => {
    await renderView();
    const sixteen = Array.from({ length: 16 }, (_, i): [string, string, Participant["role"]] => [
      `u${i}`,
      `P${i}`,
      "voter",
    ]);
    show(stateWith(sixteen));
    expect(screen.getByRole("heading", { name: "This room is full" })).toBeTruthy();
    expect(screen.getByText(/16 people are already in this room/)).toBeTruthy();
  });

  it("offers the observer row when only the seats are taken", async () => {
    await renderView();
    show(stateWith(others, { observersCount: false }));
    fireEvent.change(screen.getByRole("textbox", { name: "Your name" }), {
      target: { value: "Eve" },
    });
    mocks.setDisplayName.mockResolvedValue("Eve");
    mocks.sendCommand.mockResolvedValueOnce({ ok: false, code: "room_full" });
    fireEvent.click(screen.getByRole("button", { name: "Join the room" }));
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toMatch(/All 16 seats at the table are taken/),
    );
    expect(screen.queryByRole("heading", { name: "This room is full" })).toBeNull();
  });
});

describe("at the table", () => {
  it("seats the viewer first, observers in the row, every name inside bdi", async () => {
    await renderView();
    show(joined);
    const seats = screen.getByRole("list", { name: "People at the table" });
    const names = [...seats.querySelectorAll("[data-seat-part=name] bdi")].map(
      (b) => b.textContent,
    );
    expect(names).toEqual(["Cleo", "Ana"]);
    const row = screen.getByRole("list", { name: "Observers" });
    expect(row.querySelector("bdi")?.textContent).toBe("Ben");
    expect(screen.getByText("Cleo", { selector: "[data-you-name] bdi" })).toBeTruthy();
  });

  it("renames: saves the name, sends rename, and Escape cancels back to the button", async () => {
    await renderView();
    show(joined);
    fireEvent.click(screen.getByRole("button", { name: "Change your name" }));
    let field = screen.getByRole("textbox", { name: "Your name" });
    expect(document.activeElement).toBe(field);
    fireEvent.keyDown(field, { key: "Escape" });
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole("button", { name: "Change your name" })),
    );
    expect(mocks.sendCommand).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Change your name" }));
    field = screen.getByRole("textbox", { name: "Your name" });
    // The same name closes the editor without a request.
    fireEvent.submit(field);
    await waitFor(() => expect(screen.queryByRole("textbox")).toBeNull());
    expect(mocks.setDisplayName).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Change your name" }));
    field = screen.getByRole("textbox", { name: "Your name" });
    fireEvent.change(field, { target: { value: "" } });
    fireEvent.submit(field);
    expect(screen.getByRole("alert").textContent).toMatch(/A name needs 1 to 32/);
    expect(field.getAttribute("aria-invalid")).toBe("true");

    fireEvent.change(field, { target: { value: "Cleo B" } });
    mocks.setDisplayName.mockResolvedValue("Cleo B");
    mocks.sendCommand.mockImplementation(async () => {
      show(stateWith([...others, [ME, "Cleo B", "voter"]]));
      return { ok: true, version };
    });
    fireEvent.submit(field);
    await waitFor(() => expect(screen.queryByRole("textbox")).toBeNull());
    expect(mocks.sendCommand).toHaveBeenCalledWith({
      type: "rename",
      payload: { name: "Cleo B" },
    });
    expect(screen.getByText("Cleo B", { selector: "[data-you-name] bdi" })).toBeTruthy();
  });

  it("keeps the editor open with the message when the rename is refused", async () => {
    await renderView();
    show(joined);
    fireEvent.click(screen.getByRole("button", { name: "Change your name" }));
    const field = screen.getByRole("textbox", { name: "Your name" });
    fireEvent.change(field, { target: { value: "Cleo C" } });
    mocks.setDisplayName.mockResolvedValue("Cleo C");
    mocks.sendCommand.mockResolvedValueOnce({ ok: false, code: "not_participant" });
    fireEvent.submit(field);
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toMatch(/no longer in this room/),
    );
    expect(screen.getByRole("textbox", { name: "Your name" })).toBeTruthy();
  });

  it("switches role, and shows a refusal", async () => {
    await renderView();
    show(joined);
    mocks.sendCommand.mockImplementationOnce(async () => {
      show(stateWith([...others, [ME, "Cleo", "observer"]]));
      return { ok: true, version };
    });
    fireEvent.click(screen.getByRole("button", { name: "Switch to observer" }));
    await waitFor(() => screen.getByRole("button", { name: "Switch to voter" }));
    expect(mocks.sendCommand).toHaveBeenCalledWith({
      type: "setRole",
      payload: { role: "observer" },
    });
    const seats = screen.getByRole("list", { name: "People at the table" });
    expect(seats.textContent).not.toContain("Cleo");
    mocks.sendCommand.mockResolvedValueOnce({ ok: false, code: "room_full" });
    fireEvent.click(screen.getByRole("button", { name: "Switch to voter" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/This room is full/));
  });

  it("leaves: the join form comes back with the focus on the name", async () => {
    useIdentityStore.getState().setIdentity({ userId: ME, name: "Cleo" });
    await renderView();
    show(joined);
    mocks.sendCommand.mockImplementationOnce(async () => {
      show(stateWith(others));
      return { ok: true, version };
    });
    fireEvent.click(screen.getByRole("button", { name: "Leave the room" }));
    await waitFor(() => screen.getByRole("button", { name: "Join the room" }));
    expect(mocks.sendCommand).toHaveBeenCalledWith({ type: "leave" });
    const name = screen.getByRole("textbox", { name: "Your name" });
    expect(document.activeElement).toBe(name);
    expect(name).toHaveProperty("value", "Cleo");
  });

  it("treats not_participant on leave as left, and shows other refusals", async () => {
    await renderView();
    show(joined);
    mocks.sendCommand.mockResolvedValueOnce({ ok: false, code: "offline" });
    fireEvent.click(screen.getByRole("button", { name: "Leave the room" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/connection/));
    mocks.sendCommand.mockResolvedValueOnce({ ok: false, code: "not_participant" });
    fireEvent.click(screen.getByRole("button", { name: "Leave the room" }));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  });

  it("speaks the reader's language", async () => {
    await act(() => changeLanguage("fr"));
    await renderView();
    show(joined);
    expect(screen.getByRole("button", { name: "Quitter la salle" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Passer observateur" })).toBeTruthy();
  });
});
