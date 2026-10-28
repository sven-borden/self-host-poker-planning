import { apply, type Command, createRoom, type Participant, type RoomState } from "@pp/domain";
import { type Snapshot, toSnapshot } from "@pp/protocol";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { changeLanguage, fixedT, loadLanguage } from "../i18n/i18n.ts";
import { useIdentityStore } from "../stores/identity-store.ts";
import { useRoomStore } from "../stores/room-store.ts";
import { describeEvents, liveEvents, mergeEvents } from "./announcements.ts";
import { RoomView } from "./room-view.tsx";
import { RoomSettingsButton } from "./settings-button.tsx";

// The room password in the page (#31): the join form that asks for it, the PO's row in
// "Room settings", everyone else's "Password: On", and what the live region says.

const mocks = vi.hoisted(() => ({
  sendCommand: vi.fn(),
  commandSender: vi.fn(),
  enterRoomAgain: vi.fn(),
  setDisplayName: vi.fn(),
  fetch: vi.fn(),
}));
vi.mock("../realtime/room-connection.ts", () => ({
  sendCommand: mocks.sendCommand,
  commandSender: mocks.commandSender,
  enterRoomAgain: mocks.enterRoomAgain,
}));
vi.mock("../identity/identity.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../identity/identity.ts")>()),
  setDisplayName: mocks.setDisplayName,
}));

const CODE = "abcdefghij";
const PO = "po";
const ANA = "ana";
const ME = "me";
let version = 1;

function room(extra: Partial<RoomState> = {}): RoomState {
  const state = createRoom({ ownerId: PO });
  const participants: Record<string, Participant> = {
    [PO]: { name: "Pia", role: "voter", joinedAt: 1, connected: true },
    [ANA]: { name: "Ana", role: "voter", joinedAt: 2, connected: true },
  };
  return { ...state, participants, ...extra };
}

function show(next: RoomState, viewer: string) {
  act(() => {
    version += 1;
    useRoomStore.getState().receive(toSnapshot(next, viewer, { code: CODE, version, now: 0 }));
    useRoomStore.getState().setStatus("live");
  });
}

/** One answer of the server to `fetch`, as `Response`. */
function answer(status: number, body?: object, headers: Record<string, string> = {}) {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

/** The method, path and body of the n-th fetch call. */
function request(n: number) {
  const [path, init] = mocks.fetch.mock.calls[n] as [string, RequestInit | undefined];
  return { path, method: init?.method ?? "GET", body: init?.body };
}

beforeAll(async () => {
  await Promise.all([loadLanguage("fr"), loadLanguage("de"), import("./settings-panel.tsx")]);
}, 30_000);

beforeEach(() => {
  version = 1;
  vi.stubGlobal("fetch", mocks.fetch);
  useRoomStore.getState().open(CODE);
  mocks.commandSender.mockImplementation(
    () => (command: unknown) => mocks.sendCommand(command) as unknown,
  );
});

afterEach(async () => {
  cleanup();
  useRoomStore.getState().reset();
  useIdentityStore.getState().reset();
  for (const mock of Object.values(mocks)) mock.mockReset();
  vi.unstubAllGlobals();
  await act(() => changeLanguage("en"));
});

describe("the join form in a room with a password", () => {
  const lock = (reason: "required" | "changed") => act(() => useRoomStore.getState().lock(reason));

  it("asks for the password above the name, focused, with one Join button", async () => {
    render(<RoomView />);
    lock("required");
    const password = await screen.findByLabelText("Password");
    expect(password.getAttribute("type")).toBe("password");
    await waitFor(() => expect(document.activeElement).toBe(password));
    const name = screen.getByRole("textbox", { name: "Your name" });
    expect(password.compareDocumentPosition(name) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByText("This room has a password. Enter it to join.")).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "Join the room" })).toHaveLength(1);
    // The toggle shows it, and hides it again.
    const toggle = screen.getByRole("button", { name: "Show password" });
    fireEvent.click(toggle);
    expect(password.getAttribute("type")).toBe("text");
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(toggle);
    expect(password.getAttribute("type")).toBe("password");
  });

  it("says a wrong password, keeps the focus on the field and selects it", async () => {
    useIdentityStore.getState().setIdentity({ userId: ME, name: "Dan" });
    render(<RoomView />);
    lock("required");
    const password = (await screen.findByLabelText("Password")) as HTMLInputElement;
    fireEvent.click(screen.getByRole("button", { name: "Join the room" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Enter the room’s password.");
    expect(mocks.fetch).not.toHaveBeenCalled();

    mocks.fetch.mockResolvedValueOnce(answer(403, { code: "wrong_password" }));
    fireEvent.change(password, { target: { value: "nope" } });
    fireEvent.click(screen.getByRole("button", { name: "Join the room" }));
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toBe("That password is not right."),
    );
    expect(request(0)).toEqual({
      path: `/api/rooms/${CODE}/access`,
      method: "POST",
      body: JSON.stringify({ password: "nope" }),
    });
    expect(document.activeElement).toBe(password);
    expect([password.selectionStart, password.selectionEnd]).toEqual([0, 4]);
    expect(password.getAttribute("aria-invalid")).toBe("true");
    expect(mocks.enterRoomAgain).not.toHaveBeenCalled();

    mocks.fetch.mockResolvedValueOnce(
      answer(429, { code: "rate_limited" }, { "retry-after": "125" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Join the room" }));
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toBe("Too many tries. Try again in 3 minutes."),
    );
  });

  it("checks the right one, enters again, then joins: the form stays meanwhile", async () => {
    useIdentityStore.getState().setIdentity({ userId: ME, name: "Dan" });
    render(<RoomView />);
    lock("required");
    const password = await screen.findByLabelText("Password");
    fireEvent.change(password, { target: { value: "open sesame" } });
    mocks.fetch.mockResolvedValueOnce(answer(204));
    mocks.enterRoomAgain.mockImplementation(async () => {
      show(room({ hasPassword: true }), ME);
      return "ok";
    });
    mocks.sendCommand.mockResolvedValue({ ok: true, version: 9 });
    fireEvent.click(screen.getByRole("button", { name: "Join the room" }));
    await waitFor(() =>
      expect(mocks.sendCommand).toHaveBeenCalledWith({
        type: "join",
        payload: { name: "Dan", role: "voter" },
      }),
    );
    // Entered: the same form, without its password field now.
    expect(screen.queryByLabelText("Password")).toBeNull();
    expect(screen.getByRole("textbox", { name: "Your name" })).toBeTruthy();
  });

  it("says when the PO changed the password, and asks again if it changes meanwhile", async () => {
    render(<RoomView />);
    lock("changed");
    const password = await screen.findByLabelText("Password");
    expect(screen.getByText("The product owner changed the password.")).toBeTruthy();
    fireEvent.change(screen.getByRole("textbox", { name: "Your name" }), {
      target: { value: "Dan" },
    });
    fireEvent.change(password, { target: { value: "old one" } });
    mocks.fetch.mockResolvedValueOnce(answer(204));
    mocks.enterRoomAgain.mockResolvedValue("password_required");
    fireEvent.click(screen.getByRole("button", { name: "Join the room" }));
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toBe("The product owner changed the password."),
    );
    expect(mocks.sendCommand).not.toHaveBeenCalled();
  });

  it("asks a removed person for the password under the removal notice (AC 3)", async () => {
    render(<RoomView />);
    act(() => useRoomStore.getState().setRemoved(true));
    lock("required");
    const notice = await screen.findByText("The product owner removed you from this room.");
    const password = screen.getByLabelText("Password");
    expect(
      notice.compareDocumentPosition(password) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("asks for the password when the room got one while the form was open", async () => {
    render(<RoomView />);
    show(room(), ME);
    fireEvent.change(screen.getByRole("textbox", { name: "Your name" }), {
      target: { value: "Dan" },
    });
    mocks.sendCommand.mockResolvedValue({ ok: false, code: "password_required" });
    mocks.enterRoomAgain.mockImplementation(async () => {
      act(() => useRoomStore.getState().lock("required"));
      return "password_required";
    });
    fireEvent.click(screen.getByRole("button", { name: "Join the room" }));
    expect(await screen.findByLabelText("Password")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("the password row in Room settings", () => {
  async function openPanel(name: string) {
    fireEvent.click(screen.getByRole("button", { name }));
    return screen.findByRole("dialog", { name });
  }
  const passwordRow = (dialog: HTMLElement) => {
    const row = dialog.querySelector<HTMLElement>('[data-setting="hasPassword"]');
    if (!row) throw new Error("no password row");
    return row;
  };

  it("lets the PO set a password: refusals under the field, then the set state", async () => {
    render(<RoomSettingsButton />);
    show(room(), PO);
    const dialog = await openPanel("Room settings");
    const row = passwordRow(dialog);
    expect(
      within(row).getByText(
        "People already in the room stay. Anyone else enters it once on each device.",
      ),
    ).toBeTruthy();
    const input = within(row).getByLabelText("Password") as HTMLInputElement;
    expect(input.getAttribute("autocomplete")).toBe("new-password");

    mocks.fetch.mockResolvedValueOnce(answer(400, { code: "bad_password" }));
    fireEvent.change(input, { target: { value: "abc" } });
    fireEvent.click(within(row).getByRole("button", { name: "Set password" }));
    await waitFor(() =>
      expect(within(row).getByRole("alert").textContent).toBe(
        "A password needs 4 to 128 characters.",
      ),
    );
    expect(document.activeElement).toBe(input);

    mocks.fetch.mockResolvedValueOnce(answer(204));
    fireEvent.change(input, { target: { value: "open sesame" } });
    fireEvent.submit(input);
    await waitFor(() => expect(mocks.fetch).toHaveBeenCalledTimes(2));
    expect(request(1)).toEqual({
      path: `/api/rooms/${CODE}/password`,
      method: "PUT",
      body: JSON.stringify({ password: "open sesame" }),
    });
    show(room({ hasPassword: true }), PO);
    expect(await within(row).findByText("This room has a password.")).toBeTruthy();
    const change = within(row).getByRole("button", { name: "Change password" });
    await waitFor(() => expect(document.activeElement).toBe(change));
    expect(within(row).queryByLabelText("Show password")).toBeNull();
  });

  it("changes and removes it: Change opens the field with Cancel, Remove asks nothing", async () => {
    render(<RoomSettingsButton />);
    show(room({ hasPassword: true }), PO);
    const dialog = await openPanel("Room settings");
    const row = passwordRow(dialog);
    fireEvent.click(within(row).getByRole("button", { name: "Change password" }));
    const input = await within(row).findByLabelText("Password");
    await waitFor(() => expect(document.activeElement).toBe(input));
    fireEvent.click(within(row).getByRole("button", { name: "Cancel" }));
    const change = await within(row).findByRole("button", { name: "Change password" });
    await waitFor(() => expect(document.activeElement).toBe(change));

    mocks.fetch.mockResolvedValueOnce(answer(204));
    fireEvent.click(within(row).getByRole("button", { name: "Remove password" }));
    await waitFor(() => expect(mocks.fetch).toHaveBeenCalledTimes(1));
    expect(request(0)).toMatchObject({ path: `/api/rooms/${CODE}/password`, method: "DELETE" });
    show(room(), PO);
    const field = await within(row).findByLabelText("Password");
    await waitFor(() => expect(document.activeElement).toBe(field));
  });

  it("shows everyone else On or Off, never more", async () => {
    render(<RoomSettingsButton />);
    show(room({ hasPassword: true }), ANA);
    const dialog = await openPanel("Room rules");
    const row = passwordRow(dialog);
    expect(row.querySelector("[data-setting-value]")?.textContent).toBe("On");
    expect(within(row).queryByRole("textbox")).toBeNull();
    expect(within(row).queryByRole("button")).toBeNull();
    show(room(), ANA);
    await waitFor(() => expect(row.querySelector("[data-setting-value]")?.textContent).toBe("Off"));
  });
});

describe("what the live region says about the password", () => {
  const t = fixedT("en");

  /** The snapshots `viewer` gets as the PO sets, changes and removes the password. */
  function story(viewer: string) {
    let state = room();
    const snapshots: Snapshot[] = [toSnapshot(state, viewer, { code: CODE, version: 1, now: 0 })];
    const run = (command: Command) => {
      const result = apply(state, command, { actor: PO, now: 1 });
      if (!result.ok) throw new Error(result.error);
      state = result.state;
      const snapshot = toSnapshot(state, viewer, {
        code: CODE,
        version: snapshots.length + 1,
        now: 0,
        causes: result.causes,
      });
      snapshots.push(snapshot);
      return snapshot;
    };
    return { run, snapshots };
  }
  const said = (previous: Snapshot, next: Snapshot, language: "en" | "fr" | "de" = "en") =>
    describeEvents(fixedT(language), liveEvents(next.room, next.causes, previous.room));

  it("says each change once to everyone but the PO, in every language", () => {
    const { run, snapshots } = story(ANA);
    const set = run({ type: "password", on: true });
    expect(said(snapshots[0] as Snapshot, set)).toBe(
      "The product owner set a password for this room.",
    );
    const changed = run({ type: "password", on: true });
    expect(said(set, changed)).toBe("The product owner changed the room’s password.");
    expect(said(set, changed, "fr")).toBe("Le product owner a changé le mot de passe de la salle.");
    expect(said(set, changed, "de")).toBe("Der Product Owner hat das Passwort des Raums geändert.");
    const removed = run({ type: "password", on: false });
    expect(said(changed, removed)).toBe("The product owner removed the room’s password.");

    const po = story(PO);
    const own = po.run({ type: "password", on: true });
    expect(liveEvents(own.room, own.causes, (po.snapshots[0] as Snapshot).room)).toEqual([]);
  });

  it("still says a set or a removal after a reconnect, from the settings alone", () => {
    const { run, snapshots } = story(ANA);
    const set = run({ type: "password", on: true });
    expect(describeEvents(t, liveEvents(set.room, [], (snapshots[0] as Snapshot).room))).toBe(
      "The product owner set a password for this room.",
    );
    // A change without its cause is not news: the room had a password before too.
    expect(liveEvents(set.room, [], set.room)).toEqual([]);
  });

  it("merges a batch: set then removed says nothing, set then changed says set", () => {
    const { run, snapshots } = story(ANA);
    const first = snapshots[0] as Snapshot;
    const set = run({ type: "password", on: true });
    const changed = run({ type: "password", on: true });
    const removed = run({ type: "password", on: false });
    const events = (previous: Snapshot, next: Snapshot) =>
      liveEvents(next.room, next.causes, previous.room);
    const setThenChanged = mergeEvents(events(first, set), events(set, changed));
    expect(describeEvents(t, setThenChanged)).toBe(
      "The product owner set a password for this room.",
    );
    const all = mergeEvents(setThenChanged, events(changed, removed));
    expect(all).toEqual([]);
  });
});
