import { apply, createRoom, DEFAULT_SETTINGS, type Participant, type RoomState } from "@pp/domain";
import { toSnapshot } from "@pp/protocol";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { changeLanguage } from "../i18n/i18n.ts";
import { useRoomStore } from "../stores/room-store.ts";
import { RoomSettingsButton } from "./settings-button.tsx";
import { GROUPS } from "./settings-panel.tsx";
import { SETTING_KEYS } from "./settings-words.ts";

const mocks = vi.hoisted(() => ({ sendCommand: vi.fn(), commandSender: vi.fn() }));
vi.mock("../realtime/room-connection.ts", () => ({
  sendCommand: mocks.sendCommand,
  commandSender: mocks.commandSender,
}));

const CODE = "abcdefghij";
const PO = "po";
const ANA = "ana";
let version = 1;
let state: RoomState;

/** A new room (ADR-011's defaults) with its PO and Ana at the table. */
function newRoom(): RoomState {
  const room = createRoom({ ownerId: PO });
  const participants: Record<string, Participant> = {
    [PO]: { name: "Pia", role: "voter", joinedAt: 1, connected: true },
    [ANA]: { name: "Ana", role: "voter", joinedAt: 2, connected: true },
  };
  return { ...room, participants };
}

/** The server's next snapshot of `next`, as `viewer` sees it. */
function show(next: RoomState, viewer: string) {
  state = next;
  act(() => {
    version += 1;
    useRoomStore.getState().receive(toSnapshot(next, viewer, { code: CODE, version, now: 0 }));
    useRoomStore.getState().setStatus("live");
  });
}

/** Opens the panel from the header's button and waits for its chunk. */
async function openPanel(name: string) {
  fireEvent.click(screen.getByRole("button", { name }));
  return screen.findByRole("dialog", { name });
}

const row = (dialog: HTMLElement, key: string) => {
  const found = dialog.querySelector<HTMLElement>(`[data-setting="${key}"]`);
  if (!found) throw new Error(`no row for ${key}`);
  return found;
};
const shownValue = (dialog: HTMLElement, key: string) =>
  row(dialog, key).querySelector("[data-setting-value]")?.textContent;

beforeAll(async () => {
  await import("./settings-panel.tsx");
}, 30_000);

beforeEach(() => {
  version = 1;
  useRoomStore.getState().open(CODE);
  mocks.commandSender.mockImplementation(
    () => (command: unknown) => mocks.sendCommand(command) as unknown,
  );
});

afterEach(async () => {
  cleanup();
  useRoomStore.getState().reset();
  mocks.sendCommand.mockReset();
  mocks.commandSender.mockReset();
  await act(() => changeLanguage("en"));
});

describe("the settings panel", () => {
  it("lists every setting once", () => {
    const keys = GROUPS.flatMap((group) => group.fields.map((field) => field.key));
    expect(keys).toEqual([...SETTING_KEYS]);
  });

  it("shows a new room's settings as ADR-011 sets them, read-only for everyone but the PO (AC 3)", async () => {
    expect(newRoom().settings).toEqual(DEFAULT_SETTINGS);
    render(<RoomSettingsButton />);
    show(newRoom(), ANA);
    const dialog = await openPanel("Room rules");
    expect(within(dialog).queryAllByRole("switch")).toEqual([]);
    expect(dialog.querySelector("[data-settings-panel]")?.getAttribute("data-settings-panel")).toBe(
      "rules",
    );
    expect(Object.fromEntries(SETTING_KEYS.map((key) => [key, shownValue(dialog, key)]))).toEqual({
      deck: "Fibonacci",
      specials: "? and ☕",
      timer: "Off",
      revealWhenAllVoted: "On",
      whoCanReveal: "The product owner",
      revealNames: "Off",
      allowChangeAfterReveal: "Not allowed",
      poVotes: "On",
      observersCount: "On",
    });
    expect(row(dialog, "deck").querySelector("[data-setting-detail]")?.textContent).toBe(
      "0, 1, 2, 3, 5, 8, 13, 21",
    );
    expect(row(dialog, "specials").querySelector("[data-setting-detail]")?.textContent).toBe(
      "? unsure · ☕ needs a break",
    );
    // Anyone but the PO lands on "Close".
    await waitFor(() =>
      expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "Close" })),
    );
    // The explanation under each setting; changes after the reveal never apply anonymously.
    expect(row(dialog, "allowChangeAfterReveal").textContent).toContain(
      "Never in an anonymous round",
    );
  });

  it("gives the PO a switch for each setting the room already shows, set as ADR-011 says (AC 3)", async () => {
    render(<RoomSettingsButton />);
    show(newRoom(), PO);
    const dialog = await openPanel("Room settings");
    const checked = (name: string) =>
      within(dialog).getByRole("switch", { name }).getAttribute("aria-checked") === "true";
    expect(within(dialog).getAllByRole("switch")).toHaveLength(4);
    expect(checked("Reveal when everyone has voted")).toBe(DEFAULT_SETTINGS.revealWhenAllVoted);
    expect(checked("Anonymous voting")).toBe(!DEFAULT_SETTINGS.revealNames);
    expect(checked("The product owner votes too")).toBe(DEFAULT_SETTINGS.poVotes);
    expect(checked("Observers take one of the 16 places")).toBe(DEFAULT_SETTINGS.observersCount);
    // The others are read until their issue adds a control.
    expect(shownValue(dialog, "deck")).toBe("Fibonacci");
    expect(shownValue(dialog, "timer")).toBe("Off");
    expect(shownValue(dialog, "whoCanReveal")).toBe("The product owner");
    expect(shownValue(dialog, "allowChangeAfterReveal")).toBe("Not allowed");
    const anonymous = within(dialog).getByRole("switch", { name: "Anonymous voting" });
    expect(anonymous.getAttribute("aria-describedby")).toBeTruthy();
    expect(
      document.getElementById(anonymous.getAttribute("aria-describedby") ?? "")?.textContent,
    ).toBe("The results show the cards without names. A change applies from the next round.");
  });

  it("sends only the changed key, shows it pending until the snapshot confirms it", async () => {
    let answer: (ack: unknown) => void = () => {};
    mocks.sendCommand.mockReturnValue(new Promise((resolve) => (answer = resolve)));
    render(<RoomSettingsButton />);
    show(newRoom(), PO);
    const dialog = await openPanel("Room settings");
    const anonymous = within(dialog).getByRole("switch", { name: "Anonymous voting" });
    fireEvent.click(anonymous);
    expect(mocks.sendCommand).toHaveBeenCalledWith({
      type: "updateSettings",
      payload: { patch: { revealNames: false } },
    });
    expect(anonymous.getAttribute("aria-checked")).toBe("true");
    expect(anonymous.getAttribute("aria-busy")).toBe("true");
    expect(within(row(dialog, "revealNames")).getByText("Saving…")).toBeTruthy();
    // A second press while it is on its way sends nothing.
    fireEvent.click(anonymous);
    expect(mocks.sendCommand).toHaveBeenCalledTimes(1);
    // The server broadcasts, then acks.
    const result = apply(
      state,
      { type: "updateSettings", patch: { revealNames: false } },
      {
        actor: PO,
        now: 5,
      },
    );
    if (!result.ok) throw new Error(result.error);
    show(result.state, PO);
    await act(async () => answer({ ok: true, version }));
    expect(anonymous.getAttribute("aria-checked")).toBe("true");
    expect(anonymous.hasAttribute("aria-busy")).toBe(false);
    expect(within(row(dialog, "revealNames")).queryByText("Saving…")).toBeNull();
  });

  it("says this round keeps its names when anonymity applies from the next one", async () => {
    render(<RoomSettingsButton />);
    const started = apply(
      newRoom(),
      { type: "startRound", subject: { kind: "none" } },
      { actor: PO, now: 1 },
    );
    if (!started.ok) throw new Error(started.error);
    const changed = apply(
      started.state,
      { type: "updateSettings", patch: { revealNames: false } },
      { actor: PO, now: 2 },
    );
    if (!changed.ok) throw new Error(changed.error);
    show(changed.state, ANA);
    const dialog = await openPanel("Room rules");
    expect(row(dialog, "revealNames").querySelector("[data-setting-detail]")?.textContent).toBe(
      "This round still shows names.",
    );
  });

  it("rolls back a refusal and says why: observers past 16 people", async () => {
    mocks.sendCommand.mockResolvedValue({ ok: false, code: "room_full" });
    render(<RoomSettingsButton />);
    show({ ...newRoom(), settings: { ...newRoom().settings, observersCount: false } }, PO);
    const dialog = await openPanel("Room settings");
    const observers = within(dialog).getByRole("switch", {
      name: "Observers take one of the 16 places",
    });
    fireEvent.click(observers);
    expect(observers.getAttribute("aria-checked")).toBe("true");
    const alert = await within(dialog).findByRole("alert");
    expect(alert.textContent).toBe(
      "More than 16 people are here with the observers. Observers can count again once there are 16 or fewer.",
    );
    expect(observers.getAttribute("aria-checked")).toBe("false");
    expect(observers.getAttribute("aria-describedby")).toContain(alert.id);
    // Any other refusal says the server's code in words.
    mocks.sendCommand.mockResolvedValue({ ok: false, code: "not_owner" });
    fireEvent.click(within(dialog).getByRole("switch", { name: "The product owner votes too" }));
    expect((await within(dialog).findByRole("alert")).textContent).toBe(
      "Only the product owner can do that.",
    );
  });

  it("traps the focus, closes on Esc and gives the focus back to the header's button", async () => {
    render(<RoomSettingsButton />);
    show(newRoom(), PO);
    const button = screen.getByRole("button", { name: "Room settings" });
    expect(button.getAttribute("aria-haspopup")).toBe("dialog");
    button.focus();
    const dialog = await openPanel("Room settings");
    expect(button.getAttribute("aria-expanded")).toBe("true");
    // The PO lands on the first control.
    await waitFor(() =>
      expect(document.activeElement).toBe(
        within(dialog).getByRole("switch", { name: "Reveal when everyone has voted" }),
      ),
    );
    fireEvent.keyDown(document.activeElement ?? dialog, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.activeElement).toBe(button);
    expect(button.getAttribute("aria-expanded")).toBe("false");
  });

  it("follows the room: the PO's settings turn into rules when the role moves on", async () => {
    render(<RoomSettingsButton />);
    show(newRoom(), PO);
    const dialog = await openPanel("Room settings");
    expect(within(dialog).getAllByRole("switch")).toHaveLength(4);
    show({ ...state, ownerId: ANA }, PO);
    expect(within(dialog).queryAllByRole("switch")).toEqual([]);
    expect(within(dialog).getByRole("heading", { name: "Room rules" })).toBeTruthy();
  });

  it("speaks French and German", async () => {
    render(<RoomSettingsButton />);
    show(newRoom(), PO);
    await act(() => changeLanguage("fr"));
    const dialog = await openPanel("Réglages de la salle");
    expect(within(dialog).getByRole("switch", { name: "Vote anonyme" })).toBeTruthy();
    await act(() => changeLanguage("de"));
    expect(within(dialog).getByRole("switch", { name: "Anonyme Abstimmung" })).toBeTruthy();
  });

  it("shows nothing before the first snapshot or once the room has failed", () => {
    render(<RoomSettingsButton />);
    expect(screen.queryByRole("button")).toBeNull();
    show(newRoom(), ANA);
    expect(screen.getByRole("button", { name: "Room rules" })).toBeTruthy();
    act(() => useRoomStore.getState().fail("kicked"));
    expect(screen.queryByRole("button")).toBeNull();
  });
});
