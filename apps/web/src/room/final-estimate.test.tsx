import { apply, type Command, createRoom, type Participant, type RoomState } from "@pp/domain";
import { toSnapshot } from "@pp/protocol";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { useRoomStore } from "../stores/room-store.ts";
import { PLACED_FOCUS_GUARD_MS } from "../table/hand.tsx";
import { RoomView } from "./room-view.tsx";

// The PO's final estimate and "Vote again" (#32) on the room page, against a fake server
// that runs the real domain, as vote.test.tsx does.

const mocks = vi.hoisted(() => ({ sendCommand: vi.fn(), commandSender: vi.fn() }));
vi.mock("../realtime/room-connection.ts", () => ({
  sendCommand: mocks.sendCommand,
  commandSender: mocks.commandSender,
}));

const CODE = "abcdefghij";
let version = 1;
let server: RoomState;
let viewer = "po";
let sent: Array<{ type: string; payload?: unknown }>;

function show(state: RoomState) {
  act(() => {
    version += 1;
    useRoomStore.getState().receive(toSnapshot(state, viewer, { code: CODE, version, now: 0 }));
    useRoomStore.getState().setStatus("live");
  });
}

function run(actor: string, command: Command) {
  const result = apply(server, command, { actor, now: 100 });
  if (!result.ok) return result.error;
  server = result.state;
  show(server);
  return null;
}

async function serve(command: { type: string; payload?: Record<string, unknown> }) {
  sent.push(command);
  const error = run(viewer, { type: command.type, ...command.payload } as Command);
  return error === null ? { ok: true, version } : { ok: false, code: error };
}

/** The PO, Ana and Ben voting on "Login page" with `deck`; Ana and Ben played `cards`. */
function revealedRound(cards: [string, string], deck: "fib" | "tshirt" = "fib"): RoomState {
  let state = createRoom({ ownerId: "po" });
  const participants: Record<string, Participant> = {};
  ["po", "ana", "ben"].forEach((id, i) => {
    participants[id] = { name: `Name ${id}`, role: "voter", joinedAt: i + 1, connected: true };
  });
  state = {
    ...state,
    participants,
    settings: { ...state.settings, poVotes: false, deck: { kind: "preset", id: deck } },
  };
  const step = (actor: string, command: Command) => {
    const result = apply(state, command, { actor, now: 50 });
    if (!result.ok) throw new Error(result.error);
    state = result.state;
  };
  step("po", { type: "startRound", subject: { kind: "title", text: "Login page" } });
  step("ana", { type: "castVote", card: cards[0] });
  step("ben", { type: "castVote", card: cards[1] });
  return state;
}

async function renderRoom(state: RoomState, as = "po") {
  viewer = as;
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

const picker = () => screen.getByRole("group", { name: "Final estimate" });
const radio = (name: string) => within(picker()).getByRole("radio", { name });
const checked = () =>
  within(picker())
    .getAllByRole("radio")
    .filter((r) => (r as HTMLInputElement).checked)
    .map((r) => r.getAttribute("aria-label"));
const recordButton = () => document.querySelector<HTMLButtonElement>("[data-record-final]");
const centreFinal = () => document.querySelector("[data-centre-final]");

beforeAll(async () => {
  await import("./seated.tsx");
  const { loadResults } = await import("./results-chunk.tsx");
  expect(await loadResults()).not.toBeNull();
}, 30_000);

beforeEach(() => {
  vi.spyOn(window, "scrollTo").mockImplementation(() => {});
  version = 1;
  sent = [];
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

describe("the final estimate (#32)", () => {
  it("preselects the suggestion, records it with one press, and shows it to everyone", async () => {
    // 3 and 8 average 5.5: the suggestion is 5.
    await renderRoom(revealedRound(["3", "8"]));
    expect(checked()).toEqual(["5, suggested"]);
    expect(recordButton()?.textContent).toBe("Record 5");
    // Nothing is recorded by itself.
    expect(server.round?.final).toBeUndefined();
    expect(centreFinal()).toBeNull();

    fireEvent.click(recordButton() as HTMLElement);
    await waitFor(() => expect(server.round?.final).toBe("5"));
    expect(sent).toEqual([{ type: "setFinal", payload: { card: "5" } }]);
    expect(recordButton()?.textContent).toBe("Recorded");
    expect(recordButton()?.getAttribute("aria-disabled")).toBe("true");
    expect(centreFinal()?.textContent).toContain("Final estimate: 5.");
    // A second press sends nothing.
    fireEvent.click(recordButton() as HTMLElement);
    expect(sent).toHaveLength(1);
  });

  it("lets the PO pick another card and change the final while the round stays revealed", async () => {
    await renderRoom(revealedRound(["3", "8"]));
    fireEvent.click(radio("8"));
    expect(checked()).toEqual(["8"]);
    expect(recordButton()?.textContent).toBe("Record 8");
    fireEvent.click(recordButton() as HTMLElement);
    await waitFor(() => expect(server.round?.final).toBe("8"));
    fireEvent.click(radio("13"));
    fireEvent.click(recordButton() as HTMLElement);
    await waitFor(() => expect(server.round?.final).toBe("13"));
    expect(server.round?.phase).toBe("revealed");
    expect(checked()).toEqual(["13"]);
    // The specials are never offered.
    expect(within(picker()).queryByRole("radio", { name: "unsure" })).toBeNull();
  });

  it("preselects nothing on a tie: the tied cards are marked and the PO picks", async () => {
    await renderRoom(revealedRound(["M", "L"], "tshirt"));
    expect(checked()).toEqual([]);
    expect(radio("M, tied")).toBeTruthy();
    expect(radio("L, tied")).toBeTruthy();
    expect(document.querySelectorAll("[data-tie-mark]")).toHaveLength(2);
    expect(recordButton()?.textContent).toBe("Record");
    expect(recordButton()?.getAttribute("aria-disabled")).toBe("true");
    expect(screen.getByText("Pick the final estimate, then record it.")).toBeTruthy();
    fireEvent.click(recordButton() as HTMLElement);
    expect(sent).toEqual([]);
    fireEvent.click(radio("L, tied"));
    fireEvent.click(recordButton() as HTMLElement);
    await waitFor(() => expect(server.round?.final).toBe("L"));
  });

  it("ignores a held Enter's repeats on the record button", async () => {
    await renderRoom(revealedRound(["3", "8"]));
    const button = recordButton() as HTMLElement;
    const repeat = fireEvent.keyDown(button, { key: "Enter", repeat: true });
    expect(repeat).toBe(false);
    expect(fireEvent.keyDown(button, { key: "Enter" })).toBe(true);
  });

  it("ignores Enter and Space just after the page, not the person, put the focus in the bar", async () => {
    vi.useFakeTimers({ toFake: ["performance"] });
    try {
      await renderRoom(revealedRound(["3", "8"]));
      const button = recordButton() as HTMLElement;
      // The focus came from nowhere ("Reveal cards" left with it): a second Enter on its way
      // must not record the suggestion.
      fireEvent.focus(button, { relatedTarget: null });
      expect(fireEvent.keyDown(button, { key: "Enter" })).toBe(false);
      expect(fireEvent.keyDown(button, { key: " " })).toBe(false);
      expect(fireEvent.keyUp(button, { key: " " })).toBe(false);
      // The same on the picker and the other buttons.
      const nextRound = screen.getByRole("button", { name: "Next round" });
      expect(fireEvent.keyDown(nextRound, { key: "Enter" })).toBe(false);
      expect(fireEvent.keyDown(radio("5, suggested"), { key: " " })).toBe(false);
      expect(fireEvent.keyUp(radio("5, suggested"), { key: " " })).toBe(false);
      vi.advanceTimersByTime(PLACED_FOCUS_GUARD_MS);
      expect(fireEvent.keyDown(button, { key: "Enter" })).toBe(true);
      expect(fireEvent.keyDown(button, { key: " " })).toBe(true);
      expect(fireEvent.keyUp(button, { key: " " })).toBe(true);
      // The person moved the focus from another element: no wait.
      fireEvent.focus(nextRound, { relatedTarget: button });
      expect(fireEvent.keyDown(nextRound, { key: "Enter" })).toBe(true);
    } finally {
      vi.useRealTimers();
    }
    expect(sent).toEqual([]);
  });

  it('sends "Next round" pressed while a record is on its way behind it, in order', async () => {
    await renderRoom(revealedRound(["3", "8"]));
    fireEvent.click(recordButton() as HTMLElement);
    fireEvent.click(screen.getByRole("button", { name: "Next round" }));
    await waitFor(() => expect(server.round?.number).toBe(2));
    expect(sent.map((command) => command.type)).toEqual(["setFinal", "startRound"]);
  });

  it('starts one round for a double press on "Vote again"', async () => {
    await renderRoom(revealedRound(["3", "8"]));
    const again = screen.getByRole("button", { name: "Vote again" });
    fireEvent.click(again);
    fireEvent.click(again);
    await waitFor(() => expect(server.round?.number).toBe(2));
    expect(sent).toEqual([{ type: "revote" }]);
  });

  it("votes again on the same subject: a new round, the votes cleared, the focus on the hand", async () => {
    let state = revealedRound(["3", "8"]);
    state = { ...state, settings: { ...state.settings, poVotes: true } };
    await renderRoom(state);
    screen.getByRole("button", { name: "Vote again" }).focus();
    fireEvent.click(screen.getByRole("button", { name: "Vote again" }));
    await waitFor(() => expect(server.round?.number).toBe(2));
    expect(sent).toEqual([{ type: "revote" }]);
    expect(server.round).toMatchObject({
      phase: "voting",
      subject: { kind: "title", text: "Login page" },
      votes: {},
    });
    expect(document.querySelector("[data-decision]")).toBeNull();
    const hand = screen.getByRole("toolbar", { name: "Your cards" });
    await waitFor(() => expect(hand.contains(document.activeElement)).toBe(true));
  });

  it("gives a voter no picker and no buttons, and shows them the recorded final", async () => {
    await renderRoom(revealedRound(["3", "8"]), "ana");
    expect(screen.queryByRole("group", { name: "Final estimate" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Next round" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Vote again" })).toBeNull();
    run("po", { type: "setFinal", card: "8" });
    await waitFor(() => expect(centreFinal()?.getAttribute("data-centre-final")).toBe("8"));
  });

  it("shows a refused final under the table", async () => {
    await renderRoom(revealedRound(["3", "8"]));
    // The round moved on elsewhere (another tab of the PO's): the server refuses.
    mocks.commandSender.mockImplementation(() => async () => ({ ok: false, code: "not_revealed" }));
    fireEvent.click(recordButton() as HTMLElement);
    expect(await screen.findByRole("alert")).toHaveProperty(
      "textContent",
      "Reveal the cards first.",
    );
  });
});

describe("the final estimate after a change (#29)", () => {
  const note = () => document.querySelector("[data-decision-note]");
  /** Ana and Ben voted 3 and 8 (suggested 5) in a room that allows changes. */
  const changeable = () => {
    const state = revealedRound(["3", "8"]);
    return { ...state, settings: { ...state.settings, allowChangeAfterReveal: true } };
  };

  it("keeps the recorded final, says the votes moved and preselects the new suggestion", async () => {
    await renderRoom(changeable());
    fireEvent.click(recordButton() as HTMLElement);
    await waitFor(() => expect(server.round?.final).toBe("5"));
    expect(note()).toBeNull();
    // Ben changes to 13: 3 and 13 suggest 8.
    run("ben", { type: "castVote", card: "13" });
    expect(server.round?.final).toBe("5");
    expect(centreFinal()?.textContent).toContain("Final estimate: 5.");
    expect(note()?.textContent).toBe("Votes changed since you recorded 5.");
    // A phone's docked action row carries its own copy, as its first line.
    const dock = document.querySelector("[data-decision-actions] [data-decision-note='dock']");
    expect(dock?.textContent).toBe("Votes changed since you recorded 5.");
    expect(dock?.parentElement?.firstElementChild).toBe(dock);
    expect(checked()).toEqual(["8, suggested"]);
    expect(recordButton()?.textContent).toBe("Record 8");
    expect(recordButton()?.getAttribute("aria-describedby")).toBe(note()?.id);
    expect(picker().getAttribute("aria-describedby")).toContain(note()?.id);
    // Nothing is recorded until the PO acts.
    expect(sent).toHaveLength(1);
    fireEvent.click(recordButton() as HTMLElement);
    await waitFor(() => expect(server.round?.final).toBe("8"));
    expect(note()).toBeNull();
    expect(recordButton()?.textContent).toBe("Recorded");
  });

  it("says nothing while the suggestion holds, and lets the PO keep the old final", async () => {
    await renderRoom(changeable());
    fireEvent.click(recordButton() as HTMLElement);
    await waitFor(() => expect(server.round?.final).toBe("5"));
    // 2 and 8 still suggest 5: nothing to say.
    run("ana", { type: "castVote", card: "2" });
    expect(note()).toBeNull();
    expect(checked()).toEqual(["5, suggested"]);
    // 2 and 13 suggest 8.
    run("ben", { type: "castVote", card: "13" });
    expect(note()?.textContent).toBe("Votes changed since you recorded 5.");
    // The PO picks 5 again: it is the final already, and nothing is sent.
    fireEvent.click(radio("5"));
    expect(recordButton()?.textContent).toBe("Recorded");
    // Back where it was when recorded: the note goes.
    run("ben", { type: "castVote", card: "8" });
    expect(note()).toBeNull();
  });

  it("preselects nothing when the change makes a tie, and says why under the bar", async () => {
    const state = revealedRound(["M", "L"], "tshirt");
    await renderRoom({
      ...state,
      settings: { ...state.settings, allowChangeAfterReveal: true },
    });
    // M and L tie: the PO picks L and records it.
    fireEvent.click(radio("L, tied"));
    fireEvent.click(recordButton() as HTMLElement);
    await waitFor(() => expect(server.round?.final).toBe("L"));
    run("ana", { type: "castVote", card: "L" });
    expect(note()).toBeNull();
    run("ana", { type: "castVote", card: "S" });
    expect(note()?.textContent).toBe("Votes changed since you recorded L.");
    expect(checked()).toEqual([]);
    expect(recordButton()?.textContent).toBe("Record");
  });
});
