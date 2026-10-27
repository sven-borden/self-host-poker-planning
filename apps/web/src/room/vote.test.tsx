import {
  apply,
  type Command,
  createRoom,
  type Participant,
  type RoomSettings,
  type RoomState,
} from "@pp/domain";
import { toSnapshot } from "@pp/protocol";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useRoomStore } from "../stores/room-store.ts";
import { RoomView } from "./room-view.tsx";

// The hand and the table's centre on the room page (#18), against a fake server that runs
// the real domain: each command goes through `apply`, and the snapshot it produced is in
// the store before the ack resolves, as the real server does it.

const mocks = vi.hoisted(() => ({ sendCommand: vi.fn(), commandSender: vi.fn() }));
vi.mock("../realtime/room-connection.ts", () => ({
  sendCommand: mocks.sendCommand,
  commandSender: mocks.commandSender,
}));

const CODE = "abcdefghij";
const ME = "me";
let version = 1;
let server: RoomState;
/** Commands as the page sent them, in order. */
let sent: Array<{ type: string; payload?: unknown }>;
/** When set, each command waits for this before the server runs it. */
let gate: Promise<void> | null;

function stateWith(
  people: Array<[string, Participant["role"]]>,
  settings: Partial<RoomSettings> = {},
): RoomState {
  const state = createRoom({ ownerId: "po" });
  const participants: Record<string, Participant> = {};
  people.forEach(([id, role], i) => {
    participants[id] = { name: `Name ${id}`, role, joinedAt: i + 1, connected: true };
  });
  return { ...state, settings: { ...state.settings, ...settings }, participants };
}

function show(state: RoomState) {
  act(() => {
    version += 1;
    useRoomStore.getState().receive(toSnapshot(state, ME, { code: CODE, version, now: 0 }));
    useRoomStore.getState().setStatus("live");
  });
}

/** Runs a command as `actor` on the fake server and shows the result. */
function run(actor: string, command: Command) {
  const result = apply(server, command, { actor, now: 100 });
  if (!result.ok) return result.error;
  server = result.state;
  show(server);
  return null;
}

function toDomain(command: { type: string; payload?: Record<string, unknown> }): Command {
  return { type: command.type, ...command.payload } as Command;
}

async function serve(command: { type: string; payload?: Record<string, unknown> }) {
  sent.push(command);
  if (gate) await gate;
  const error = run(ME, toDomain(command));
  return error === null ? { ok: true, version } : { ok: false, code: error };
}

async function renderRoom(state: RoomState) {
  server = state;
  const router = createRouter({
    routeTree: createRootRoute({ component: RoomView }),
    history: createMemoryHistory({ initialEntries: [`/r/${CODE}`] }),
  });
  await act(async () => {
    render(<RouterProvider router={router} />);
    await router.load();
  });
  show(server);
  await screen.findByRole("heading", { name: "You" });
}

const hand = () => screen.getByRole("toolbar", { name: "Your cards" });
const card = (label: string) => within(hand()).getByRole("button", { name: label });
const pressed = () =>
  within(hand())
    .getAllByRole("button")
    .filter((b) => b.getAttribute("aria-pressed") === "true")
    .map((b) => b.getAttribute("aria-label"));
const handLive = () => document.querySelector("[data-hand-live]")?.textContent ?? "";
const centre = () => document.querySelector("[data-centre]")?.textContent ?? "";
const mySlot = () => document.querySelector("[data-slot-card][data-you] [data-face]");

const table: Array<[string, Participant["role"]]> = [
  ["po", "voter"],
  [ME, "voter"],
  ["ana", "voter"],
  ["obs", "observer"],
];
const voting = () => {
  const lobby = stateWith(table);
  const result = apply(
    lobby,
    { type: "startRound", subject: { kind: "none" } },
    {
      actor: "po",
      now: 50,
    },
  );
  if (!result.ok) throw new Error(result.error);
  return result.state;
};

beforeEach(() => {
  vi.spyOn(window, "scrollTo").mockImplementation(() => {});
  version = 1;
  sent = [];
  gate = null;
  useRoomStore.getState().open(CODE);
  mocks.sendCommand.mockImplementation(serve);
  mocks.commandSender.mockImplementation(() => serve);
});

afterEach(() => {
  cleanup();
  useRoomStore.getState().reset();
  mocks.sendCommand.mockReset();
  mocks.commandSender.mockReset();
  vi.restoreAllMocks();
});

describe("the hand", () => {
  it("votes, changes and takes back, and tells the viewer each time", async () => {
    await renderRoom(voting());
    expect(pressed()).toEqual([]);
    expect(centre()).toBe("0/3 voted so far");

    fireEvent.click(card("5"));
    await waitFor(() => expect(handLive()).toBe("You voted 5."));
    expect(pressed()).toEqual(["5"]);
    expect(sent).toEqual([{ type: "castVote", payload: { card: "5" } }]);
    expect(mySlot()?.getAttribute("data-face")).toBe("down");
    expect(centre()).toBe("1/3 voted so far");

    fireEvent.click(card("8"));
    await waitFor(() => expect(handLive()).toBe("You voted 8."));
    expect(pressed()).toEqual(["8"]);

    fireEvent.click(card("8"));
    await waitFor(() => expect(handLive()).toBe("Vote taken back."));
    expect(pressed()).toEqual([]);
    expect(sent.at(-1)).toEqual({ type: "retractVote" });
    expect(mySlot()?.getAttribute("data-face")).toBe("empty");
    expect(server.round?.votes).toEqual({});
  });

  it("shows the pick before the server confirms it", async () => {
    await renderRoom(voting());
    let open = () => {};
    gate = new Promise((resolve) => {
      open = resolve;
    });
    fireEvent.click(card("13"));
    expect(pressed()).toEqual(["13"]);
    expect(mySlot()?.getAttribute("data-face")).toBe("down");
    expect(centre()).toBe("1/3 voted so far");
    // Nobody else has it yet; a snapshot meanwhile (Ana votes) keeps the pick shown.
    run("ana", { type: "castVote", card: "2" });
    expect(pressed()).toEqual(["13"]);
    expect(handLive()).toBe("");
    await act(async () => open());
    await waitFor(() => expect(handLive()).toBe("You voted 13."));
    expect(server.round?.votes[ME]).toEqual({ card: "13" });
  });

  it("keeps up with a fast double click: one vote, then taken back", async () => {
    await renderRoom(voting());
    let open = () => {};
    gate = new Promise((resolve) => {
      open = resolve;
    });
    fireEvent.click(card("3"));
    fireEvent.click(card("3"));
    expect(pressed()).toEqual([]);
    await act(async () => open());
    await waitFor(() => expect(handLive()).toBe("Vote taken back."));
    expect(sent.map((c) => c.type)).toEqual(["castVote", "retractVote"]);
    expect(server.round?.votes).toEqual({});
    expect(pressed()).toEqual([]);
  });

  it("rolls back a vote the server refuses after the reveal, and says why", async () => {
    await renderRoom(voting());
    fireEvent.click(card("5"));
    await waitFor(() => expect(handLive()).toBe("You voted 5."));
    let open = () => {};
    gate = new Promise((resolve) => {
      open = resolve;
    });
    fireEvent.click(card("8"));
    expect(pressed()).toEqual(["8"]);
    // The PO reveals before the change arrives.
    run("po", { type: "reveal" });
    await act(async () => open());
    await screen.findByText("The cards are already revealed, so votes can no longer change.");
    expect(pressed()).toEqual(["5"]);
    expect(card("8").getAttribute("aria-disabled")).toBe("true");
    // Disabled: a press sends nothing.
    fireEvent.click(card("3"));
    expect(sent).toHaveLength(2);
    expect(screen.getByText(/The cards are revealed/).textContent).toBe(
      "The cards are revealed. Votes can no longer change in this round.",
    );
  });

  it("rolls back when the room is offline", async () => {
    await renderRoom(voting());
    mocks.commandSender.mockImplementation(() => async () => ({ ok: false, code: "offline" }));
    fireEvent.click(card("5"));
    await screen.findByText(/connection to the server was lost/);
    expect(pressed()).toEqual([]);
    expect(mySlot()?.getAttribute("data-face")).toBe("empty");
  });

  it("moves through the cards with the arrow keys, one tab stop", async () => {
    await renderRoom(voting());
    const stops = () =>
      within(hand())
        .getAllByRole("button")
        .filter((b) => b.tabIndex === 0)
        .map((b) => b.getAttribute("aria-label"));
    expect(stops()).toEqual(["0"]);
    card("0").focus();
    fireEvent.keyDown(card("0"), { key: "ArrowRight" });
    expect(document.activeElement).toBe(card("1"));
    expect(stops()).toEqual(["1"]);
    fireEvent.keyDown(card("1"), { key: "ArrowLeft" });
    fireEvent.keyDown(card("0"), { key: "ArrowLeft" });
    expect(document.activeElement).toBe(card("needs a break"));
    fireEvent.keyDown(card("needs a break"), { key: "Home" });
    expect(document.activeElement).toBe(card("0"));
    fireEvent.keyDown(card("0"), { key: "End" });
    expect(document.activeElement).toBe(card("needs a break"));
    fireEvent.keyDown(card("needs a break"), { key: "ArrowDown" });
    expect(document.activeElement).toBe(card("0"));
    fireEvent.keyDown(card("0"), { key: "x" });
    expect(document.activeElement).toBe(card("0"));
    // Specials are named: ? is "unsure".
    expect(card("unsure").getAttribute("aria-pressed")).toBe("false");
  });

  it("is waiting in the lobby and hidden from observers and from a PO who does not vote", async () => {
    await renderRoom(stateWith(table));
    expect(card("5").getAttribute("aria-disabled")).toBe("true");
    expect(
      screen.getByText("Your cards open when the product owner starts the round."),
    ).toBeTruthy();
    expect(centre()).toBe("Waiting for the PO");
    fireEvent.click(card("5"));
    expect(sent).toEqual([]);

    cleanup();
    await renderRoom(
      stateWith([
        ["po", "voter"],
        [ME, "observer"],
      ]),
    );
    expect(screen.queryByRole("toolbar")).toBeNull();
  });
});

describe("the table's centre", () => {
  it("lets the PO start voting, and again after a reveal", async () => {
    const owner = { ...stateWith(table), ownerId: ME };
    await renderRoom(owner);
    fireEvent.click(screen.getByRole("button", { name: "Start voting" }));
    await waitFor(() => expect(centre()).toBe("0/3 voted so far"));
    expect(sent).toEqual([{ type: "startRound", payload: { subject: { kind: "none" } } }]);
    run(ME, { type: "reveal" });
    fireEvent.click(screen.getByRole("button", { name: "Next round" }));
    await waitFor(() => expect(server.round?.number).toBe(2));
  });

  it("says the PO does not vote, and shows a refused start", async () => {
    const owner = { ...stateWith(table, { poVotes: false }), ownerId: ME };
    await renderRoom(owner);
    expect(screen.getByText("As the product owner, you do not vote in this room.")).toBeTruthy();
    expect(screen.queryByRole("toolbar")).toBeNull();
    mocks.sendCommand.mockImplementation(async () => ({ ok: false, code: "not_owner" }));
    fireEvent.click(screen.getByRole("button", { name: "Start voting" }));
    await screen.findByText("Only the product owner can do that.");
  });

  it("tells everyone else the cards are revealed", async () => {
    const revealed = apply(voting(), { type: "reveal" }, { actor: "po", now: 60 });
    if (!revealed.ok) throw new Error(revealed.error);
    await renderRoom(revealed.state);
    expect(centre()).toBe("Cards revealed");
    expect(screen.queryByRole("button", { name: "Next round" })).toBeNull();
  });
});
