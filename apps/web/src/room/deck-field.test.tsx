import { apply, type Command, createRoom, type Participant, type RoomState } from "@pp/domain";
import { toSnapshot } from "@pp/protocol";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { changeLanguage } from "../i18n/i18n.ts";
import { useRoomStore } from "../stores/room-store.ts";
import { RoomSettingsButton } from "./settings-button.tsx";

// The deck field and the special cards in the PO's settings panel (#26), through the
// panel as the PO opens it.

const mocks = vi.hoisted(() => ({ sendCommand: vi.fn(), commandSender: vi.fn() }));
vi.mock("../realtime/room-connection.ts", () => ({
  sendCommand: mocks.sendCommand,
  commandSender: mocks.commandSender,
}));

const CODE = "abcdefghij";
const PO = "po";
const ANA = "ana";
let version = 1;

function newRoom(): RoomState {
  const room = createRoom({ ownerId: PO });
  const participants: Record<string, Participant> = {
    [PO]: { name: "Pia", role: "voter", joinedAt: 1, connected: true },
    [ANA]: { name: "Ana", role: "voter", joinedAt: 2, connected: true },
  };
  return { ...room, participants };
}

function run(state: RoomState, actor: string, command: Command): RoomState {
  const result = apply(state, command, { actor, now: 10 + version });
  if (!result.ok) throw new Error(result.error);
  return result.state;
}

/** Round 1 is open; Ana has voted when `voted`. */
function voting(voted: boolean): RoomState {
  const started = run(newRoom(), PO, { type: "startRound", subject: { kind: "none" } });
  return voted ? run(started, ANA, { type: "castVote", card: "5" }) : started;
}

function show(next: RoomState, viewer = PO) {
  act(() => {
    version += 1;
    useRoomStore.getState().receive(toSnapshot(next, viewer, { code: CODE, version, now: 0 }));
    useRoomStore.getState().setStatus("live");
  });
}

async function openPanel(state: RoomState, name = "Room settings") {
  render(<RoomSettingsButton />);
  show(state);
  fireEvent.click(screen.getByRole("button", { name }));
  return screen.findByRole("dialog", { name });
}

const sentPatches = () =>
  mocks.sendCommand.mock.calls.map(
    ([command]) => (command as { payload: { patch: unknown } }).payload.patch,
  );

const describedText = (element: HTMLElement) =>
  (element.getAttribute("aria-describedby") ?? "")
    .split(" ")
    .map((id) => document.getElementById(id)?.textContent ?? "")
    .join(" | ");

beforeAll(async () => {
  await import("./settings-panel.tsx");
}, 30_000);

beforeEach(() => {
  version = 1;
  useRoomStore.getState().open(CODE);
  mocks.commandSender.mockImplementation(
    () => (command: unknown) => mocks.sendCommand(command) as unknown,
  );
  mocks.sendCommand.mockReturnValue(new Promise(() => {}));
});

afterEach(async () => {
  cleanup();
  useRoomStore.getState().reset();
  mocks.sendCommand.mockReset();
  mocks.commandSender.mockReset();
  await act(() => changeLanguage("en"));
});

describe("the deck field", () => {
  it("lists the presets with their cards; a choice alone sends nothing, its button applies it", async () => {
    const dialog = await openPanel(newRoom());
    const deck = within(dialog).getByRole("radiogroup", { name: "Deck" });
    const radios = within(deck).getAllByRole("radio");
    expect(radios.map((radio) => radio.getAttribute("value"))).toEqual([
      "fib",
      "mfib",
      "tshirt",
      "pow2",
      "seq",
      "custom",
    ]);
    const fib = within(deck).getByRole("radio", { name: "Fibonacci" });
    expect(describedText(fib)).toBe("In use | 0 1 2 3 5 8 13 21");
    const tshirt = within(deck).getByRole("radio", { name: "T-shirt sizes" });
    expect(describedText(tshirt)).toBe("XS S M L XL XXL");
    expect(within(dialog).getByText("New cards apply from round 1.")).toBeTruthy();

    fireEvent.click(tshirt);
    expect(mocks.sendCommand).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "Use “T-shirt sizes”" }));
    expect(sentPatches()).toEqual([{ deck: { kind: "preset", id: "tshirt" } }]);
    // The button goes with the change; the focus stays on the deck chosen.
    expect(within(dialog).queryByRole("button", { name: "Use “T-shirt sizes”" })).toBeNull();
    expect(document.activeElement).toBe(tshirt);
  });

  it("gives everyone else the deck to read, with no control", async () => {
    render(<RoomSettingsButton />);
    show(newRoom(), ANA);
    fireEvent.click(screen.getByRole("button", { name: "Room rules" }));
    const dialog = await screen.findByRole("dialog", { name: "Room rules" });
    expect(within(dialog).queryAllByRole("radio")).toEqual([]);
    expect(within(dialog).queryAllByRole("textbox")).toEqual([]);
    expect(within(dialog).queryAllByRole("switch")).toEqual([]);
    expect(dialog.querySelector("[data-setting='deck'] [data-setting-value]")?.textContent).toBe(
      "Fibonacci",
    );
  });

  it("builds a custom deck: a live preview, the count, and the cards sent as typed", async () => {
    const dialog = await openPanel(newRoom());
    fireEvent.click(within(dialog).getByRole("radio", { name: "Custom deck" }));
    const field = within(dialog).getByRole("textbox", { name: "Cards, separated by commas" });
    expect(describedText(field)).toContain("write a decimal with a point: 0.5");
    fireEvent.change(field, { target: { value: "0.5, 1, 1.5, 2.5," } });
    const preview = dialog.querySelector("[data-deck-preview]");
    expect(preview?.getAttribute("aria-hidden")).toBe("true");
    expect(
      [...(preview?.querySelectorAll("[data-mini-card]") ?? [])].map((c) => c.textContent),
    ).toEqual(["0.5", "1", "1.5", "2.5"]);
    expect(dialog.querySelector("[data-deck-count]")?.textContent).toBe("4 cards");
    expect(field.getAttribute("aria-invalid")).toBeNull();
    fireEvent.click(within(dialog).getByRole("button", { name: "Use these cards" }));
    expect(sentPatches()).toEqual([
      { deck: { kind: "custom", cards: ["0.5", "1", "1.5", "2.5"] } },
    ]);
  });

  it("names the card at fault, and sends nothing until the deck is right (AC 1)", async () => {
    const dialog = await openPanel(newRoom());
    fireEvent.click(within(dialog).getByRole("radio", { name: "Custom deck" }));
    const field = within(dialog).getByRole("textbox", { name: "Cards, separated by commas" });
    const use = within(dialog).getByRole("button", { name: "Use these cards" });
    // An empty field is no error until the PO tries to use it.
    expect(dialog.querySelector("[data-deck-problem]")).toBeNull();
    fireEvent.click(use);
    expect(dialog.querySelector("[data-deck-problem]")?.textContent).toBe(
      "Type at least one card.",
    );
    expect(document.activeElement).toBe(field);

    fireEvent.change(field, { target: { value: "1, Large, 3" } });
    const problem = dialog.querySelector("[data-deck-problem]");
    expect(problem?.textContent).toBe("“Large” is too long: a card holds at most 4 characters.");
    expect(field.getAttribute("aria-invalid")).toBe("true");
    expect(describedText(field)).toContain("“Large” is too long");
    expect(dialog.querySelector("[data-fault]")?.textContent).toBe("Large");
    fireEvent.click(use);
    fireEvent.keyDown(field, { key: "Enter" });
    expect(mocks.sendCommand).not.toHaveBeenCalled();

    fireEvent.change(field, { target: { value: "1, , 3" } });
    expect(dialog.querySelector("[data-deck-problem]")?.textContent).toBe(
      "Card 2 is empty. Remove the extra comma.",
    );
    fireEvent.change(field, { target: { value: "🐜, 🐈, 🐘" } });
    expect(dialog.querySelector("[data-deck-problem]")).toBeNull();
    fireEvent.keyDown(field, { key: "Enter" });
    expect(sentPatches()).toEqual([{ deck: { kind: "custom", cards: ["🐜", "🐈", "🐘"] } }]);
  });

  it("opens with the room's custom deck in the field", async () => {
    const custom = run(newRoom(), PO, {
      type: "updateSettings",
      patch: { deck: { kind: "custom", cards: ["1", "2", "Big"] } },
    });
    const dialog = await openPanel(custom);
    const radio = within(dialog).getByRole("radio", { name: "Custom deck" });
    expect(radio).toHaveProperty("checked", true);
    expect(describedText(radio)).toBe("In use");
    expect(
      within(dialog).getByRole("textbox", { name: "Cards, separated by commas" }),
    ).toHaveProperty("value", "1, 2, Big");
  });

  it("generates a range with a comma or a point, into the field the PO can still edit", async () => {
    const dialog = await openPanel(newRoom());
    fireEvent.click(within(dialog).getByRole("radio", { name: "Custom deck" }));
    const toggle = within(dialog).getByRole("button", { name: "Generate a range" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    const start = within(dialog).getByRole("textbox", { name: "Start" });
    const end = within(dialog).getByRole("textbox", { name: "End" });
    const step = within(dialog).getByRole("textbox", { name: "Step" });
    expect([start, end, step].map((input) => (input as HTMLInputElement).value)).toEqual([
      "0",
      "5",
      "0.5",
    ]);
    expect(step.getAttribute("inputmode")).toBe("decimal");
    fireEvent.change(end, { target: { value: "2" } });
    fireEvent.change(step, { target: { value: "0,5" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Fill in the cards" }));
    const field = within(dialog).getByRole("textbox", { name: "Cards, separated by commas" });
    expect(field).toHaveProperty("value", "0, 0.5, 1, 1.5, 2");
    expect(within(dialog).getByText("5 cards filled in. Check them, then use them.")).toBeTruthy();
    expect(mocks.sendCommand).not.toHaveBeenCalled();

    fireEvent.change(step, { target: { value: "0" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Fill in the cards" }));
    const alert = dialog.querySelector("[data-range-problem]");
    expect(alert?.getAttribute("role")).toBe("alert");
    expect(alert?.textContent).toBe("The step must be more than 0.");
    expect(describedText(step)).toContain("The step must be more than 0.");
    expect(field).toHaveProperty("value", "0, 0.5, 1, 1.5, 2");
  });

  it("shows the range's decimals as the reader writes them", async () => {
    await act(() => changeLanguage("fr"));
    const dialog = await openPanel(newRoom(), "Réglages de la salle");
    fireEvent.click(within(dialog).getByRole("radio", { name: "Jeu personnalisé" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Générer une suite" }));
    expect(within(dialog).getByRole("textbox", { name: "Pas" })).toHaveProperty("value", "0,5");
    expect(within(dialog).getByRole("radio", { name: "Fibonacci modifié" })).toBeTruthy();
  });
});

describe("a deck change during Voting", () => {
  it("applies at once while nobody has voted", async () => {
    const dialog = await openPanel(voting(false));
    expect(
      within(dialog).getByText(
        "New cards restart round 1: its votes are cleared, its subject stays.",
      ),
    ).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("radio", { name: "Powers of 2" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Use “Powers of 2”" }));
    expect(sentPatches()).toEqual([{ deck: { kind: "preset", id: "pow2" } }]);
    expect(dialog.querySelector("[data-restart-question]")).toBeNull();
  });

  it("asks first once someone voted: Cancel keeps the round, the restart sends the deck", async () => {
    const dialog = await openPanel(voting(true));
    fireEvent.click(within(dialog).getByRole("radio", { name: "T-shirt sizes" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Use “T-shirt sizes”" }));
    expect(mocks.sendCommand).not.toHaveBeenCalled();
    const question = within(dialog).getByRole("group", {
      name: "Changing the deck restarts round 1. The vote cast so far is cleared; the subject stays.",
    });
    expect(document.activeElement).toBe(question);
    fireEvent.click(within(question).getByRole("button", { name: "Cancel" }));
    expect(dialog.querySelector("[data-restart-question]")).toBeNull();
    expect(mocks.sendCommand).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(document.activeElement).toBe(
        within(dialog).getByRole("button", { name: "Use “T-shirt sizes”" }),
      ),
    );

    fireEvent.click(within(dialog).getByRole("button", { name: "Use “T-shirt sizes”" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Restart with “T-shirt sizes”" }));
    expect(sentPatches()).toEqual([{ deck: { kind: "preset", id: "tshirt" } }]);
    expect(document.activeElement).toBe(
      within(dialog).getByRole("radio", { name: "T-shirt sizes" }),
    );
  });

  it("counts the votes in the question, in every language", async () => {
    const two = run(voting(true), PO, { type: "castVote", card: "8", round: 1 });
    // Both voted: the round revealed itself. Start round 2 and let Ana and Pia vote with
    // auto-reveal off.
    const manual = run(
      run(two, PO, { type: "updateSettings", patch: { revealWhenAllVoted: false } }),
      PO,
      {
        type: "startRound",
        subject: { kind: "none" },
      },
    );
    const votes = run(run(manual, ANA, { type: "castVote", card: "3" }), PO, {
      type: "castVote",
      card: "5",
    });
    await act(() => changeLanguage("de"));
    const dialog = await openPanel(votes, "Raumeinstellungen");
    fireEvent.click(within(dialog).getByRole("radio", { name: "Eigenes Kartendeck" }));
    const field = within(dialog).getByRole("textbox", { name: "Karten, durch Kommas getrennt" });
    fireEvent.change(field, { target: { value: "1, 2, Big" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Diese Karten verwenden" }));
    expect(
      within(dialog).getByRole("group", {
        name: "Ein neues Kartendeck startet Runde 2 neu. Die 2 bisher abgegebenen Stimmen werden gelöscht, das Thema bleibt.",
      }),
    ).toBeTruthy();
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Mit einem eigenen Kartendeck neu starten" }),
    );
    expect(sentPatches()).toEqual([{ deck: { kind: "custom", cards: ["1", "2", "Big"] } }]);
  });
});

describe("the custom deck's question and problems (#89 review)", () => {
  const customField = (dialog: HTMLElement) => {
    fireEvent.click(within(dialog).getByRole("radio", { name: "Custom deck" }));
    return within(dialog).getByRole("textbox", { name: "Cards, separated by commas" });
  };

  it("drops the question when the cards it asks about change, and applies the cards in the field", async () => {
    const dialog = await openPanel(voting(true));
    const field = customField(dialog);
    fireEvent.change(field, { target: { value: "1, 2, Big" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Use these cards" }));
    expect(dialog.querySelector("[data-restart-question]")).not.toBeNull();
    fireEvent.change(field, { target: { value: "1, 2, Huge" } });
    expect(dialog.querySelector("[data-restart-question]")).toBeNull();
    fireEvent.click(within(dialog).getByRole("button", { name: "Use these cards" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Restart with a custom deck" }));
    expect(sentPatches()).toEqual([{ deck: { kind: "custom", cards: ["1", "2", "Huge"] } }]);
  });

  it("says a faulty deck aloud once the PO tries to apply it, and stays quiet while typing", async () => {
    const dialog = await openPanel(newRoom());
    const field = customField(dialog);
    fireEvent.change(field, { target: { value: "1, Large" } });
    const problem = dialog.querySelector("[data-deck-problem]");
    expect(problem?.getAttribute("role")).toBeNull();
    fireEvent.keyDown(field, { key: "Enter" });
    expect(within(dialog).getByRole("alert").textContent).toContain("Large");
    expect(mocks.sendCommand).not.toHaveBeenCalled();
  });

  it("does nothing, and asks nothing, for the room's own custom deck", async () => {
    const custom = run(newRoom(), PO, {
      type: "updateSettings",
      patch: { deck: { kind: "custom", cards: ["1", "2", "3"] } },
    });
    const started = run(custom, PO, { type: "startRound", subject: { kind: "none" } });
    const dialog = await openPanel(run(started, ANA, { type: "castVote", card: "2" }));
    const use = within(dialog).getByRole("button", { name: "Use these cards" });
    expect(use.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(use);
    expect(dialog.querySelector("[data-restart-question]")).toBeNull();
    expect(mocks.sendCommand).not.toHaveBeenCalled();
  });

  it("gives the focus to the apply button when the question goes with the votes", async () => {
    const state = voting(true);
    const dialog = await openPanel(state);
    fireEvent.click(within(dialog).getByRole("radio", { name: "T-shirt sizes" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Use “T-shirt sizes”" }));
    expect(document.activeElement?.closest("[data-restart-question]")).not.toBeNull();
    show(run(state, ANA, { type: "retractVote" }));
    expect(dialog.querySelector("[data-restart-question]")).toBeNull();
    expect(document.activeElement).toBe(
      within(dialog).getByRole("button", { name: "Use “T-shirt sizes”" }),
    );
  });

  it("previews at most a deck's 20 cards, and counts them all", async () => {
    const dialog = await openPanel(newRoom());
    const field = customField(dialog);
    const cards = Array.from({ length: 25 }, (_, i) => String(i + 1));
    fireEvent.change(field, { target: { value: cards.join(", ") } });
    expect(dialog.querySelectorAll("[data-deck-preview] > *")).toHaveLength(20);
    expect(dialog.querySelector("[data-deck-count]")?.textContent).toBe("25 cards");
  });

  it("passes the panel's description on to the deck's radio group", async () => {
    const dialog = await openPanel(newRoom());
    const deck = within(dialog).getByRole("radiogroup", { name: "Deck" });
    const ids = (deck.getAttribute("aria-describedby") ?? "").split(" ").filter(Boolean);
    expect(ids.length).toBeGreaterThan(0);
    for (const id of ids) expect(document.getElementById(id)).not.toBeNull();
  });
});

describe("the special cards", () => {
  it("are three switches with their meaning, each sending the whole set in order", async () => {
    const dialog = await openPanel(newRoom());
    const field = dialog.querySelector<HTMLElement>("[data-setting='specials']");
    if (!field) throw new Error("no specials field");
    const switches = within(field).getAllByRole("switch");
    expect(switches.map((s) => s.getAttribute("aria-checked"))).toEqual(["true", "true", "false"]);
    expect(within(field).getByRole("group", { name: "Special cards" })).toBeTruthy();
    fireEvent.click(within(field).getByRole("switch", { name: "Too big to estimate" }));
    expect(sentPatches()).toEqual([{ specials: ["?", "☕", "∞"] }]);
  });

  it("ask before restarting a round with votes, and give the focus back on Cancel", async () => {
    const dialog = await openPanel(voting(true));
    const unsure = within(dialog).getByRole("switch", { name: "Not sure" });
    fireEvent.click(unsure);
    expect(mocks.sendCommand).not.toHaveBeenCalled();
    expect(unsure.getAttribute("aria-checked")).toBe("true");
    const question = within(dialog).getByRole("group", {
      name: "Changing the special cards restarts round 1. The vote cast so far is cleared; the subject stays.",
    });
    expect(document.activeElement).toBe(question);
    fireEvent.click(within(question).getByRole("button", { name: "Cancel" }));
    expect(document.activeElement).toBe(unsure);
    fireEvent.click(unsure);
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Restart with the new special cards" }),
    );
    expect(sentPatches()).toEqual([{ specials: ["☕"] }]);
    expect(document.activeElement).toBe(unsure);
  });
});
