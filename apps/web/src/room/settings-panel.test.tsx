import { apply, createRoom, DEFAULT_SETTINGS, type Participant, type RoomState } from "@pp/domain";
import { toSnapshot } from "@pp/protocol";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { changeLanguage } from "../i18n/i18n.ts";
import { useRoomStore } from "../stores/room-store.ts";
import { LiveAnnouncer } from "./live-announcer.tsx";
import { RoomSettingsButton } from "./settings-button.tsx";
import { type ControlProps, GROUPS, type SettingGroup, SettingsPanel } from "./settings-panel.tsx";
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
    // Anyone but the PO lands on the title, at the panel's top.
    await waitFor(() =>
      expect(document.activeElement).toBe(
        within(dialog).getByRole("heading", { name: "Room rules" }),
      ),
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
    expect(within(dialog).getAllByRole("switch")).toHaveLength(8);
    expect(checked("Not sure")).toBe(true);
    expect(checked("Need a break")).toBe(true);
    expect(checked("Too big to estimate")).toBe(false);
    expect(checked("Reveal when everyone has voted")).toBe(DEFAULT_SETTINGS.revealWhenAllVoted);
    expect(checked("Anonymous voting")).toBe(!DEFAULT_SETTINGS.revealNames);
    expect(checked("The product owner votes too")).toBe(DEFAULT_SETTINGS.poVotes);
    expect(checked("Observers take one of the 16 places")).toBe(DEFAULT_SETTINGS.observersCount);
    // The deck is a radio group (#26), the timer too (#27); the others are read until their issue adds a control.
    const deck = within(dialog).getByRole("radiogroup", { name: "Deck" });
    expect(within(deck).getByRole("radio", { name: "Fibonacci" })).toHaveProperty("checked", true);
    // The timer (#27): no timer, and the cards turn over when one ends.
    expect(checked("Reveal when the timer ends")).toBe(DEFAULT_SETTINGS.timer.revealAtEnd);
    expect(within(row(dialog, "timer")).getByRole("radio", { name: "Off" })).toHaveProperty(
      "checked",
      true,
    );
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
    // A second press while it is on its way sends nothing; the switch keeps the focus.
    expect(anonymous.getAttribute("aria-disabled")).toBe("true");
    anonymous.focus();
    fireEvent.click(anonymous);
    expect(mocks.sendCommand).toHaveBeenCalledTimes(1);
    expect(anonymous.getAttribute("aria-checked")).toBe("true");
    expect(document.activeElement).toBe(anonymous);
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

  it("sets the timer for each round: a preset, a custom length, and the reveal at its end (#27)", async () => {
    mocks.sendCommand.mockResolvedValue({ ok: true, version: 2 });
    render(<RoomSettingsButton />);
    show(newRoom(), PO);
    const dialog = await openPanel("Room settings");
    const timer = row(dialog, "timer");
    expect(timer.getAttribute("data-layout")).toBe("block");
    expect(within(timer).getByText("Timer for each round")).toBeTruthy();
    // The hint says a change applies from the next round, as the domain does.
    expect(timer.textContent).toContain("A change applies from the next round.");
    const lengths = within(timer)
      .getAllByRole("radio")
      .map((radio) => radio.closest("label")?.textContent);
    expect(lengths).toEqual(["Off", "30\u{a0}s", "60\u{a0}s", "2\u{a0}min", "Custom"]);
    await act(async () =>
      fireEvent.click(within(timer).getByRole("radio", { name: "2\u{a0}min" })),
    );
    expect(mocks.sendCommand).toHaveBeenLastCalledWith({
      type: "updateSettings",
      payload: { patch: { timer: { seconds: 120 } } },
    });

    // Custom: nothing is sent until a valid length is set.
    const calls = mocks.sendCommand.mock.calls.length;
    fireEvent.click(within(timer).getByRole("radio", { name: "Custom" }));
    const field = within(timer).getByRole("textbox", { name: "Custom length" });
    fireEvent.change(field, { target: { value: "61:00" } });
    fireEvent.click(within(timer).getByRole("button", { name: "Set" }));
    expect(within(timer).getByRole("alert").textContent).toContain("5 seconds to 60 minutes");
    expect(mocks.sendCommand).toHaveBeenCalledTimes(calls);
    fireEvent.change(field, { target: { value: "2:30" } });
    await act(async () => fireEvent.click(within(timer).getByRole("button", { name: "Set" })));
    expect(mocks.sendCommand).toHaveBeenLastCalledWith({
      type: "updateSettings",
      payload: { patch: { timer: { seconds: 150 } } },
    });

    const atEnd = within(timer).getByRole("switch", { name: "Reveal when the timer ends" });
    expect(atEnd.getAttribute("aria-checked")).toBe("true");
    await act(async () => fireEvent.click(atEnd));
    expect(mocks.sendCommand).toHaveBeenLastCalledWith({
      type: "updateSettings",
      payload: { patch: { timer: { revealAtEnd: false } } },
    });
  });

  it("shows a custom length as a custom choice, and the timer in words to everyone else (#27)", async () => {
    render(<RoomSettingsButton />);
    const custom = {
      ...newRoom(),
      settings: { ...DEFAULT_SETTINGS, timer: { seconds: 90, revealAtEnd: false } },
    };
    show(custom, PO);
    const dialog = await openPanel("Room settings");
    expect(within(row(dialog, "timer")).getByRole("radio", { name: "Custom" })).toHaveProperty(
      "checked",
      true,
    );
    expect(
      within(row(dialog, "timer")).getByRole("textbox", { name: "Custom length" }),
    ).toHaveProperty("value", "90");
    show(custom, ANA);
    expect(shownValue(dialog, "timer")).toBe("1 minute 30 seconds");
    expect(row(dialog, "timer").querySelector("[data-setting-detail]")?.textContent).toBe(
      "When it ends, everyone sees that time is up.",
    );
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
    // The PO lands on the first control: the deck in use (#26).
    await waitFor(() =>
      expect(document.activeElement).toBe(within(dialog).getByRole("radio", { name: "Fibonacci" })),
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
    expect(within(dialog).getAllByRole("switch")).toHaveLength(8);
    show({ ...state, ownerId: ANA }, PO);
    expect(within(dialog).queryAllByRole("switch")).toEqual([]);
    expect(within(dialog).queryAllByRole("radio")).toEqual([]);
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

describe("when the connection drops", () => {
  it("gives up a pending change at once, rolls it back and says so until the room is back", async () => {
    mocks.sendCommand.mockReturnValue(new Promise(() => {}));
    render(<RoomSettingsButton />);
    show(newRoom(), PO);
    const dialog = await openPanel("Room settings");
    const poVotes = within(dialog).getByRole("switch", { name: "The product owner votes too" });
    fireEvent.click(poVotes);
    expect(poVotes.getAttribute("aria-checked")).toBe("false");
    act(() => useRoomStore.getState().setStatus("reconnecting"));
    expect(poVotes.getAttribute("aria-checked")).toBe("true");
    expect(poVotes.hasAttribute("aria-busy")).toBe(false);
    expect(within(dialog).getByRole("alert").textContent).toBe(
      "Not saved: the connection dropped.",
    );
    // A change while the connection is down fails the same way, without a send.
    fireEvent.click(within(dialog).getByRole("switch", { name: "Anonymous voting" }));
    expect(mocks.sendCommand).toHaveBeenCalledTimes(1);
    expect(within(row(dialog, "revealNames")).getByRole("alert").textContent).toBe(
      "Not saved: the connection dropped.",
    );
    // Back online: the message goes.
    act(() => useRoomStore.getState().setStatus("live"));
    expect(within(dialog).queryByRole("alert")).toBeNull();
  });
});

describe("the table's live region while the panel is open", () => {
  /** The PO's change, as Ana's next snapshot shows it. */
  const poChanges = (patch: Partial<RoomState["settings"]>) =>
    show({ ...state, settings: { ...state.settings, ...patch } }, ANA);
  const tableLive = () => document.querySelector<HTMLElement>("[data-table-live]");

  it("says each announcement once: in the panel while it is open, at the table once it is closed", async () => {
    render(
      <>
        <RoomSettingsButton />
        <LiveAnnouncer />
      </>,
    );
    show(newRoom(), ANA);
    const dialog = await openPanel("Room rules");
    poChanges({ revealNames: false });
    const inPanel = dialog.querySelector<HTMLElement>("[data-panel-live]");
    expect(inPanel?.getAttribute("role")).toBe("status");
    await waitFor(
      () => expect(inPanel?.textContent).toBe("Anonymous voting starts with round 1."),
      { timeout: 3000 },
    );
    // The page behind the modal is hidden from screen readers, its region with it.
    expect(tableLive()?.closest("[aria-hidden='true']")).not.toBeNull();

    fireEvent.keyDown(document.activeElement ?? dialog, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    poChanges({ poVotes: false });
    await waitFor(
      () => expect(tableLive()?.textContent).toBe("The product owner no longer votes."),
      { timeout: 3000 },
    );
    expect(tableLive()?.closest("[aria-hidden='true']")).toBeNull();
    expect(document.querySelector("[data-panel-live]")).toBeNull();
  });
});

/** A radio group, as #28 would add for who can reveal. */
function WhoCanReveal({ room, settings, change, pending, id, labelId, describedBy }: ControlProps) {
  return (
    <div
      id={id}
      role="radiogroup"
      aria-labelledby={labelId}
      aria-describedby={describedBy}
      data-phase={room.round?.phase ?? "lobby"}
    >
      {(["po", "anyone"] as const).map((who) => (
        <label key={who}>
          <input
            type="radio"
            name="who-can-reveal"
            checked={settings.whoCanReveal === who}
            aria-disabled={pending || undefined}
            onChange={() => change({ whoCanReveal: who })}
          />
          {who}
        </label>
      ))}
    </div>
  );
}

describe("the plug-in contract (#26 to #29)", () => {
  const LOCKED = "Locked while the round is anonymous.";
  const groups: SettingGroup[] = [
    {
      id: "test",
      title: () => "Test",
      fields: [
        {
          key: "whoCanReveal",
          label: () => "Who can reveal",
          hint: () => "Pick one.",
          value: (_t, s) => s.whoCanReveal,
          layout: "block",
          Control: WhoCanReveal,
          refusals: { not_owner: () => "Only Pia decides who reveals." },
        },
        {
          key: "allowChangeAfterReveal",
          label: () => "Change after the reveal",
          hint: () => "Votes stay open.",
          value: (_t, s) => String(s.allowChangeAfterReveal),
          toggle: {
            read: (s) => s.allowChangeAfterReveal,
            write: (on) => ({ allowChangeAfterReveal: on }),
            locked: (room) => (room.round?.anonymous ? LOCKED : null),
          },
        },
      ],
    },
  ];

  /** A room whose round 1 runs anonymously. */
  function anonymousRound(): RoomState {
    const started = apply(
      { ...newRoom(), settings: { ...DEFAULT_SETTINGS, revealNames: false } },
      { type: "startRound", subject: { kind: "none" } },
      { actor: PO, now: 1 },
    );
    if (!started.ok) throw new Error(started.error);
    return started.state;
  }

  it("takes a radio group across the row and a locked switch, with no change to the panel", async () => {
    mocks.sendCommand.mockResolvedValue({ ok: false, code: "not_owner" });
    show(anonymousRound(), PO);
    render(
      <SettingsPanel
        open
        onOpenChange={() => {}}
        returnFocus={{ current: null }}
        groups={groups}
      />,
    );
    const dialog = await screen.findByRole("dialog", { name: "Room settings" });

    // The radio group is named by the setting's label, gets the room and the whole row.
    const radios = within(dialog).getByRole("radiogroup", { name: "Who can reveal" });
    expect(radios.getAttribute("data-phase")).toBe("voting");
    expect(row(dialog, "whoCanReveal").getAttribute("data-layout")).toBe("block");
    expect(
      document.getElementById(radios.getAttribute("aria-describedby") ?? "")?.textContent,
    ).toBe("Pick one.");
    // The panel's first control takes the focus on opening.
    await waitFor(() =>
      expect(document.activeElement).toBe(within(radios).getAllByRole("radio")[0]),
    );
    fireEvent.click(within(radios).getByRole("radio", { name: "anyone" }));
    expect(mocks.sendCommand).toHaveBeenCalledWith({
      type: "updateSettings",
      payload: { patch: { whoCanReveal: "anyone" } },
    });
    // The field's own words for a refusal.
    const alert = await within(dialog).findByRole("alert");
    expect(alert.textContent).toBe("Only Pia decides who reveals.");
    expect(radios.getAttribute("aria-describedby")).toContain(alert.id);

    // The locked switch says why, stays focusable and sends nothing.
    const change = within(dialog).getByRole("switch", { name: "Change after the reveal" });
    expect(row(dialog, "allowChangeAfterReveal").getAttribute("data-layout")).toBe("inline");
    expect(change.getAttribute("aria-disabled")).toBe("true");
    const reasons = (change.getAttribute("aria-describedby") ?? "")
      .split(" ")
      .map((id) => document.getElementById(id)?.textContent);
    expect(reasons).toContain(LOCKED);
    fireEvent.click(change);
    expect(mocks.sendCommand).toHaveBeenCalledTimes(1);
    expect(change.getAttribute("aria-checked")).toBe("false");
  });
});
