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
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { useRoomStore } from "../stores/room-store.ts";
import { PLACED_FOCUS_GUARD_MS } from "../table/hand.tsx";
import { RoomView } from "./room-view.tsx";
import { isRevealKey } from "./round-centre.tsx";

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
/** The centre's status line (the PO's buttons beside it are not part of it). */
const centre = () =>
  (document.querySelector("[data-centre-status]") ?? document.querySelector("[data-centre]"))
    ?.textContent ?? "";
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

// The table is a lazy chunk; load it once up front, so no test's wait pays for its transform.
beforeAll(async () => {
  await import("./seated.tsx");
  // The results' module, through its loader: a reveal then draws it at once.
  const { loadResults } = await import("./results-chunk.tsx");
  expect(await loadResults()).not.toBeNull();
}, 30_000);

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
    await waitFor(() => expect(handLive()).toBe("Your vote: 5."));
    expect(pressed()).toEqual(["5"]);
    expect(sent).toEqual([{ type: "castVote", payload: { card: "5", round: 1, restart: 0 } }]);
    expect(mySlot()?.getAttribute("data-face")).toBe("down");
    expect(centre()).toBe("1/3 voted so far");

    fireEvent.click(card("8"));
    await waitFor(() => expect(handLive()).toBe("Your vote: 8."));
    expect(pressed()).toEqual(["8"]);

    fireEvent.click(card("8"));
    await waitFor(() => expect(handLive()).toBe("Vote taken back."));
    expect(pressed()).toEqual([]);
    expect(sent.at(-1)).toEqual({ type: "retractVote", payload: { round: 1, restart: 0 } });
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
    await waitFor(() => expect(handLive()).toBe("Your vote: 13."));
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
    await waitFor(() => expect(handLive()).toBe("Your vote: 5."));
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
    // The next round starts: the refusal belonged to the last one.
    run("po", { type: "startRound", subject: { kind: "none" } });
    expect(screen.queryByText(/already revealed/)).toBeNull();
    expect(pressed()).toEqual([]);
  });

  it("rolls back without a word when the next round started before the vote arrived", async () => {
    await renderRoom(voting());
    let open = () => {};
    gate = new Promise((resolve) => {
      open = resolve;
    });
    fireEvent.click(card("8"));
    expect(pressed()).toEqual(["8"]);
    run("po", { type: "startRound", subject: { kind: "none" } });
    await act(async () => open());
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toEqual({ type: "castVote", payload: { card: "8", round: 1, restart: 0 } });
    expect(server.round?.number).toBe(2);
    expect(server.round?.votes).toEqual({});
    expect(pressed()).toEqual([]);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(handLive()).toBe("");
  });

  it("says the vote that ends the round, though the reveal follows at once", async () => {
    await renderRoom(voting());
    run("po", { type: "castVote", card: "3" });
    run("ana", { type: "castVote", card: "5" });
    fireEvent.click(card("needs a break"));
    await waitFor(() => expect(handLive()).toBe("Your vote: needs a break."));
    expect(server.round?.phase).toBe("revealed");
  });

  it("says a take-back refused after the reveal as a refused vote", async () => {
    await renderRoom(voting());
    fireEvent.click(card("5"));
    await waitFor(() => expect(handLive()).toBe("Your vote: 5."));
    let open = () => {};
    gate = new Promise((resolve) => {
      open = resolve;
    });
    fireEvent.click(card("5"));
    run("po", { type: "reveal" });
    await act(async () => open());
    await screen.findByText("The cards are already revealed, so votes can no longer change.");
    expect(pressed()).toEqual(["5"]);
  });

  it("counts a double click once, and ignores a held Enter's repeats", async () => {
    await renderRoom(voting());
    fireEvent.click(card("5"), { detail: 1 });
    fireEvent.click(card("5"), { detail: 2 });
    await waitFor(() => expect(handLive()).toBe("Your vote: 5."));
    expect(sent).toHaveLength(1);
    expect(pressed()).toEqual(["5"]);
    // A repeated keydown is cancelled, so the button never clicks; the first one is not.
    expect(fireEvent.keyDown(card("5"), { key: "Enter", repeat: true })).toBe(false);
    expect(fireEvent.keyDown(card("5"), { key: " ", repeat: true })).toBe(false);
    expect(fireEvent.keyDown(card("5"), { key: "Enter" })).toBe(true);
  });

  it("ignores Enter and Space just after the page, not the person, focused the hand", async () => {
    vi.useFakeTimers({ toFake: ["performance"] });
    try {
      await renderRoom(voting());
      // The focus came from nowhere (the start button left with it): a key on its way is dropped.
      fireEvent.focus(card("0"), { relatedTarget: null });
      expect(fireEvent.keyDown(card("0"), { key: "Enter" })).toBe(false);
      expect(fireEvent.keyDown(card("0"), { key: " " })).toBe(false);
      expect(fireEvent.keyUp(card("0"), { key: " " })).toBe(false);
      // Arrows still move.
      expect(fireEvent.keyDown(card("0"), { key: "ArrowRight" })).toBe(false);
      expect(document.activeElement).toBe(card("1"));
      vi.advanceTimersByTime(PLACED_FOCUS_GUARD_MS);
      expect(fireEvent.keyDown(card("1"), { key: "Enter" })).toBe(true);
      expect(fireEvent.keyDown(card("1"), { key: " " })).toBe(true);
      expect(fireEvent.keyUp(card("1"), { key: " " })).toBe(true);
      // The person moved the focus from another element: no wait.
      fireEvent.focus(card("2"), { relatedTarget: card("1") });
      expect(fireEvent.keyDown(card("2"), { key: "Enter" })).toBe(true);
    } finally {
      vi.useRealTimers();
    }
    expect(sent).toEqual([]);
  });

  it("moves the focus to the nearest card when a deck change removes the focused one", async () => {
    await renderRoom(voting());
    card("needs a break").focus();
    run("po", { type: "updateSettings", patch: { specials: [] } });
    expect(within(hand()).queryByRole("button", { name: "needs a break" })).toBeNull();
    const buttons = within(hand()).getAllByRole("button");
    expect(document.activeElement).toBe(buttons.at(-1));
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

  it("centres the card the arrow keys focus in the hand, never scrolling the page (#22)", async () => {
    await renderRoom(voting());
    const bar = hand();
    // A 200 px hand whose cards stand 52 px apart, scrolled by scrollLeft.
    vi.spyOn(bar, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 200, 90));
    for (const [i, button] of within(bar).getAllByRole("button").entries()) {
      vi.spyOn(button, "getBoundingClientRect").mockImplementation(
        () => new DOMRect(12 + i * 52 - bar.scrollLeft, 20, 44, 64),
      );
    }
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    card("0").focus();
    fireEvent.keyDown(card("0"), { key: "ArrowRight" });
    fireEvent.keyDown(card("1"), { key: "ArrowRight" });
    fireEvent.keyDown(card("2"), { key: "ArrowRight" });
    expect(document.activeElement).toBe(card("3"));
    expect(focus).toHaveBeenLastCalledWith({ preventScroll: true });
    // "3" sat at 168 to 212, past the fade at 168: now its middle is the hand's.
    const at = card("3").getBoundingClientRect();
    expect(at.left + at.width / 2).toBe(100);
    focus.mockRestore();
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
    // The button is gone: the focus goes to the hand's tab stop.
    await waitFor(() => expect(document.activeElement).toBe(card("0")));
    run(ME, { type: "reveal" });
    screen.getByRole("button", { name: "Next round" }).focus();
    fireEvent.click(screen.getByRole("button", { name: "Next round" }));
    await waitFor(() => expect(server.round?.number).toBe(2));
    await waitFor(() => expect(document.activeElement).toBe(card("0")));
  });

  it("tells the PO in the lobby that starting the round opens their cards", async () => {
    await renderRoom({ ...stateWith(table), ownerId: ME });
    expect(screen.getByText("Start voting to play your cards.")).toBeTruthy();
    expect(screen.getByText("At the table, voting")).toBeTruthy();
  });

  it("gives a PO who does not vote the centre's status as focus, and no thinking seat", async () => {
    const owner = { ...stateWith(table, { poVotes: false }), ownerId: ME };
    await renderRoom(owner);
    expect(screen.getByText("At the table, not voting")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Start voting" }));
    await waitFor(() => expect(centre()).toBe("0/2 voted so far"));
    await waitFor(() =>
      expect(document.activeElement).toBe(document.querySelector("[data-centre-status]")),
    );
    expect(document.querySelector("[data-seat][data-you]")?.textContent).not.toMatch(/Thinking/);
  });

  it("says the PO does not vote, and shows a refused start", async () => {
    const owner = { ...stateWith(table, { poVotes: false }), ownerId: ME };
    await renderRoom(owner);
    expect(screen.getByText("As the product owner, you do not vote in this room.")).toBeTruthy();
    expect(screen.queryByRole("toolbar")).toBeNull();
    mocks.commandSender.mockImplementation(() => async () => ({ ok: false, code: "not_owner" }));
    fireEvent.click(screen.getByRole("button", { name: "Start voting" }));
    await screen.findByText("Only the product owner can do that.");
  });

  it("tells everyone else the result of the reveal", async () => {
    const revealed = apply(voting(), { type: "reveal" }, { actor: "po", now: 60 });
    if (!revealed.ok) throw new Error(revealed.error);
    await renderRoom(revealed.state);
    // Nobody voted: nothing to count (#20).
    await waitFor(() => expect(centre()).toBe("Nothing to count."));
    expect(screen.queryByRole("button", { name: "Next round" })).toBeNull();
  });
});

describe("the next round with a subject (#21)", () => {
  const field = () => screen.getByRole("textbox", { name: "Subject of the next round" });
  const subjectLine = () => document.querySelector("[data-round-subject]")?.textContent ?? "";
  const type = (value: string) => fireEvent.change(field(), { target: { value } });
  const submit = () => fireEvent.submit(field().closest("form") as HTMLFormElement);

  it("starts the first round with a title, then the next one with a Jira link, from the field", async () => {
    await renderRoom({ ...stateWith(table), ownerId: ME });
    expect(screen.getByText(/Leave it empty for Round 1/)).toBeTruthy();
    // No round yet: nothing above the table.
    expect(document.querySelector("[data-round-subject]")).toBeNull();
    type("  Split invoices   by currency ");
    fireEvent.click(screen.getByRole("button", { name: "Start voting" }));
    await waitFor(() => expect(centre()).toBe("0/3 voted so far"));
    expect(sent).toEqual([
      {
        type: "startRound",
        payload: { subject: { kind: "title", text: "Split invoices by currency" } },
      },
    ]);
    expect(subjectLine()).toBe("Round 1Split invoices by currency");
    expect(document.querySelector("bdi[data-subject-title]")).toBeTruthy();
    // The draft is cleared, and the field stays while the round votes.
    expect((field() as HTMLInputElement).value).toBe("");
    expect(screen.getByText("Round 2 will start with this subject after the reveal.")).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(card("0")));
    // Enter while Voting starts nothing: the PO prepares the next ticket.
    const url = "https://acme.atlassian.net/browse/PAY-482";
    type(url);
    submit();
    await act(async () => {});
    expect(sent).toHaveLength(1);
    fireEvent.click(card("5"));
    run("ana", { type: "castVote", card: "8", round: 1 });
    run("po", { type: "castVote", card: "8", round: 1 });
    await waitFor(() => expect(server.round?.phase).toBe("revealed"));
    // After the reveal, Enter in the field starts the round, and the focus stays in the field.
    field().focus();
    submit();
    await waitFor(() => expect(server.round?.number).toBe(2));
    // A second Enter, while Voting, does nothing: no vote, no new round.
    submit();
    await act(async () => {});
    expect(sent.filter((command) => command.type === "startRound")).toHaveLength(2);
    expect(sent.at(-1)).toEqual({
      type: "startRound",
      payload: { subject: { kind: "link", url } },
    });
    // The server read the key: the chip shows it, the votes are cleared.
    const link = await screen.findByRole("link", { name: "PAY-482 (opens in a new tab)" });
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
    expect(server.round?.votes).toEqual({});
    expect(pressed()).toEqual([]);
    await act(async () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
    expect(document.activeElement).toBe(field());
  });

  it("refuses a title over 200 characters and a bad link in the browser, without sending (AC 1, AC 3)", async () => {
    await renderRoom({ ...stateWith(table), ownerId: ME });
    const badLink = "Only http and https links work, without a user name or password.";
    const cases: Array<[string, string]> = [
      ["x".repeat(201), "A title can have at most 200 characters."],
      ["javascript:alert(1)", badLink],
      ["data:text/html,x", badLink],
      ["http://user:pass@example.com/", badLink],
    ];
    for (const [draft, message] of cases) {
      type(draft);
      expect(field().getAttribute("aria-invalid")).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: "Start voting" }));
      expect((await screen.findByRole("alert")).textContent).toBe(message);
      expect(field().getAttribute("aria-invalid")).toBe("true");
      expect(document.activeElement).toBe(field());
      // Nothing was cut: the draft is still all there.
      expect((field() as HTMLInputElement).value).toBe(draft);
    }
    expect(sent).toEqual([]);
    // Typing clears the refusal; 200 characters start the round.
    type("x".repeat(200));
    expect(screen.queryByRole("alert")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Start voting" }));
    await waitFor(() =>
      expect(server.round?.subject).toEqual({ kind: "title", text: "x".repeat(200) }),
    );
  });

  it("shows the server's bad_subject under the field", async () => {
    await renderRoom({ ...stateWith(table), ownerId: ME });
    mocks.commandSender.mockImplementation(() => async () => ({ ok: false, code: "bad_subject" }));
    type("Checkout");
    fireEvent.click(screen.getByRole("button", { name: "Start voting" }));
    expect((await screen.findByRole("alert")).textContent).toBe(
      "The round’s subject is not valid. Check the title or the link and try again.",
    );
    expect(document.activeElement).toBe(field());
  });

  it("shows everyone else the subject, and no field", async () => {
    const started = apply(
      stateWith(table),
      {
        type: "startRound",
        subject: { kind: "link", url: "https://dev.azure.com/acme/Pay/_workitems/edit/12345" },
      },
      { actor: "po", now: 50 },
    );
    if (!started.ok) throw new Error(started.error);
    await renderRoom(started.state);
    expect(screen.queryByRole("textbox", { name: "Subject of the next round" })).toBeNull();
    expect(screen.getByRole("link", { name: "#12345 (opens in a new tab)" })).toBeTruthy();
    expect(subjectLine()).toMatch(/^Round 1#12345/);
  });
});

describe("the reveal (#19)", () => {
  /** A voting round where the viewer is the PO; Ana voted 8. */
  function ownerRound(settings: Partial<RoomSettings> = {}): RoomState {
    let state: RoomState = { ...stateWith(table, settings), ownerId: ME };
    const started = apply(
      state,
      { type: "startRound", subject: { kind: "none" } },
      {
        actor: ME,
        now: 50,
      },
    );
    if (!started.ok) throw new Error(started.error);
    state = started.state;
    const voted = apply(state, { type: "castVote", card: "8" }, { actor: "ana", now: 60 });
    if (!voted.ok) throw new Error(voted.error);
    return voted.state;
  }
  const revealButton = () => screen.queryByRole("button", { name: "Reveal cards" });
  const press = (key: string, init: KeyboardEventInit = {}, target: Element = document.body) =>
    fireEvent.keyDown(target, { key, ...init });

  it("gives the PO a reveal button, also on the key R, and nobody else", async () => {
    await renderRoom(ownerRound());
    expect(centre()).toBe("1/3 voted so far");
    expect(revealButton()?.getAttribute("aria-keyshortcuts")).toBe("R");
    revealButton()?.focus();
    fireEvent.click(revealButton() as HTMLElement);
    await waitFor(() => expect(server.round?.phase).toBe("revealed"));
    expect(sent).toEqual([{ type: "reveal" }]);
    expect(revealButton()).toBeNull();
    // The button left with the focus: it goes on to the next round's button.
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole("button", { name: "Next round" })),
    );
    expect(card("8").getAttribute("aria-disabled")).toBe("true");
    expect(
      screen.getByText("The cards are revealed. Votes can no longer change in this round."),
    ).toBeTruthy();

    cleanup();
    sent = [];
    await renderRoom(voting());
    expect(centre()).toBe("0/3 voted so far");
    expect(revealButton()).toBeNull();
    press("r");
    expect(sent).toEqual([]);
  });

  it("reveals on R alone, only on the table or the hand (WCAG 2.1.4)", async () => {
    await renderRoom(ownerRound());
    const table = document.querySelector("[data-room-table]") as HTMLElement;
    /** Elements the page could hold inside the table, where R must not reveal. */
    const inside = (html: string) => {
      const holder = document.createElement("div");
      holder.innerHTML = html;
      table.append(holder);
      return holder;
    };
    const field = inside("<input>").firstElementChild as Element;
    const widgets = [
      "<div role='menu'><button>x</button></div>",
      "<div role='menubar'><button>x</button></div>",
      "<ul role='listbox'><li tabindex='0'>x</li></ul>",
      "<div role='dialog'><button>x</button></div>",
      "<div role='alertdialog'><button>x</button></div>",
    ].map((html) => inside(html).querySelector("button, li") as Element);
    // Out of scope: the page itself and the header (its Language and Theme menus).
    const header = document.createElement("button");
    document.body.append(header);
    try {
      press("r");
      press("r", {}, header);
      press("r", {}, field);
      for (const widget of widgets) press("r", {}, widget);
      const button = revealButton() as HTMLElement;
      press("R", { ctrlKey: true }, button);
      press("r", { metaKey: true }, button);
      press("r", { altKey: true }, button);
      press("R", { shiftKey: true }, button);
      press("r", { repeat: true }, button);
      press("r", { isComposing: true }, button);
      press("e", {}, button);
      expect(sent).toEqual([]);

      // In scope: the centre's button, a seat, a card of the hand.
      const seen: boolean[] = [];
      const record = (event: KeyboardEvent) => {
        seen.push(isRevealKey(event));
        event.preventDefault();
      };
      document.addEventListener("keydown", record, { capture: true });
      press("r", {}, button);
      press("R", {}, document.querySelector("[data-seat] button") as Element);
      press("r", {}, card("5"));
      document.removeEventListener("keydown", record, { capture: true });
      expect(seen).toEqual([true, true, true]);
      expect(sent).toEqual([]);

      press("r", {}, card("5"));
      await waitFor(() => expect(server.round?.phase).toBe("revealed"));
      expect(sent).toEqual([{ type: "reveal" }]);
    } finally {
      header.remove();
    }
  });

  it("says on the button where R works", async () => {
    await renderRoom(ownerRound());
    expect(revealButton()?.getAttribute("aria-keyshortcuts")).toBe("R");
    expect(revealButton()?.getAttribute("title")).toBe(
      "Key R, while the focus is on the table or your cards",
    );
  });

  it("shows a refused reveal, but not one the last vote made moot", async () => {
    await renderRoom(ownerRound());
    mocks.commandSender.mockImplementation(() => async () => ({ ok: false, code: "not_allowed" }));
    fireEvent.click(revealButton() as HTMLElement);
    await screen.findByText("This room’s settings do not let you do that.");
    mocks.commandSender.mockImplementation(() => async () => ({ ok: false, code: "not_voting" }));
    fireEvent.click(revealButton() as HTMLElement);
    await waitFor(() =>
      expect(screen.queryByText("This room’s settings do not let you do that.")).toBeNull(),
    );
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("shows the automatic reveal as the forced one", async () => {
    await renderRoom(ownerRound());
    fireEvent.click(card("5"));
    await waitFor(() => expect(handLive()).toBe("Your vote: 5."));
    run("po", { type: "castVote", card: "3" });
    expect(server.round?.phase).toBe("revealed");
    expect(revealButton()).toBeNull();
    expect(screen.getByRole("button", { name: "Next round" })).toBeTruthy();
    expect(mySlot()?.getAttribute("data-face")).toBe("up");
    const seat = (name: string) =>
      [...document.querySelectorAll("[data-seat]")].find((s) => s.textContent?.includes(name));
    expect(seat("Name ana")?.textContent).toContain("Name ana, card 8");
    expect(card("5").getAttribute("aria-disabled")).toBe("true");
  });

  it("shows a named round's result in the centre, the panel and the seats (#20)", async () => {
    await renderRoom(ownerRound());
    fireEvent.click(card("5"));
    await waitFor(() => expect(handLive()).toBe("Your vote: 5."));
    run("po", { type: "castVote", card: "3" });
    // 3, 5 and 8: the average 5.33 is nearest 5, one vote in three.
    const sentence = await waitFor(() => {
      const text = document.querySelector("[data-centre-result] .sr-only")?.textContent;
      expect(text).toBeTruthy();
      return text;
    });
    expect(sentence).toBe("Suggested 5. Agreement 33%.");
    expect(screen.getByRole("button", { name: "Next round" })).toBeTruthy();
    const panel = await screen.findByRole("region", { name: "Results" });
    const stat = (key: string) => panel.querySelector(`[data-stat='${key}'] dd`)?.textContent;
    expect([stat("average"), stat("median"), stat("agreement"), stat("spread")]).toEqual([
      "5.3",
      "5",
      "33%",
      "3–83 to 8",
    ]);
    const extremes = within(panel).getByRole("list", { name: "Lowest and highest cards" });
    expect(
      within(extremes)
        .getAllByRole("listitem")
        .map((item) => item.querySelector(".sr-only")?.textContent),
    ).toEqual(["Lowest card 3: Name po", "Highest card 8: Name ana"]);
    const seat = (label: string) => screen.getByRole("button", { name: label });
    expect(
      seat("Name po, card 3, lowest card").querySelector("[data-badge='lowest']"),
    ).toBeTruthy();
    expect(
      seat("Name ana, card 8, highest card").querySelector("[data-badge='highest']"),
    ).toBeTruthy();
    expect(document.querySelectorAll("[data-badge='lowest'], [data-badge='highest']")).toHaveLength(
      // The seats and the panel's list; the columns mark them too.
      6,
    );
  });

  it("shows an anonymous round's cards in the results' columns, tied to nobody (#20)", async () => {
    await renderRoom(ownerRound({ revealNames: false }));
    expect(document.querySelector("[data-results-panel]")).toBeNull();
    fireEvent.click(card("5"));
    await waitFor(() => expect(handLive()).toBe("Your vote: 5."));
    run("po", { type: "castVote", card: "?" });
    const columns = await screen.findByRole("list", { name: "Votes per card" });
    const spoken = (item: HTMLElement) => item.querySelector(".sr-only")?.textContent;
    expect(within(columns).getAllByRole("listitem").map(spoken)).toEqual([
      "5: 1 vote",
      "8: 1 vote",
    ]);
    const uncounted = screen.getByRole("list", { name: "Not counted" });
    expect(within(uncounted).getAllByRole("listitem").map(spoken)).toEqual(["unsure: 1 vote"]);
    // Nothing in the panel names a person or points at one, and nobody is lowest or highest.
    const html = document.querySelector("[data-results-panel]")?.outerHTML ?? "";
    expect(html).toContain('data-results-panel="anonymous"');
    for (const leak of ["Name", "data-you", "data-seat", "data-extreme", "Lowest", "Highest"]) {
      expect(html).not.toContain(leak);
    }
    expect(document.querySelector("[data-badge='lowest'], [data-badge='highest']")).toBeNull();
    expect(document.querySelector("[data-results]")).toBeNull();
    // The seats keep only who voted; their cards left for the row.
    expect(document.querySelectorAll("[data-face='gone']")).toHaveLength(3);
    expect(document.querySelectorAll("[data-face='up']")).toHaveLength(0);
  });

  it("names a voter who left after a named reveal, under the table", async () => {
    await renderRoom(ownerRound());
    run(ME, { type: "reveal" });
    expect(document.querySelector("[data-results]")).toBeNull();
    run("ana", { type: "leave" });
    const left = await screen.findByRole("list", { name: "Not at the table" });
    expect(left.textContent).toContain("Name ana, card 8");
    // A departed vote the server sent without a name still shows its card.
    const round = useRoomStore.getState().snapshot?.room.round;
    if (round?.phase !== "revealed" || round.anonymous) throw new Error("named reveal expected");
    act(() => {
      const snapshot = useRoomStore.getState().snapshot;
      if (!snapshot) return;
      useRoomStore.getState().receive({
        ...snapshot,
        version: snapshot.version + 1,
        room: {
          ...snapshot.room,
          round: { ...round, votes: round.votes.map(({ name: _, ...vote }) => vote) },
        },
      });
    });
    await waitFor(() => expect(left.textContent).toContain("Someone who left, card 8"));
  });

  it("shows the card of a voter who became an observer after a named reveal", async () => {
    await renderRoom(ownerRound());
    run(ME, { type: "reveal" });
    expect(run("ana", { type: "setRole", role: "observer" })).toBeNull();
    const row = await screen.findByRole("list", { name: "Not at the table" });
    const items = within(row).getAllByRole("listitem");
    expect(items.map((item) => item.querySelector(".sr-only")?.textContent)).toEqual([
      "Name ana, card 8",
    ]);
    // One accessible name: the visible name is hidden from assistive tech, whole on hover.
    const visible = items[0]?.querySelector("[aria-hidden='true'][title]");
    expect(visible?.getAttribute("title")).toBe("Name ana");
    expect(document.querySelectorAll("[data-face='up']")).toHaveLength(0);
  });

  it("shows the card of a voter who left and came back as an observer", async () => {
    await renderRoom(ownerRound());
    run(ME, { type: "reveal" });
    run("ana", { type: "leave" });
    expect(run("ana", { type: "join", name: "Ana again", role: "observer" })).toBeNull();
    const row = await screen.findByRole("list", { name: "Not at the table" });
    expect(row.textContent).toMatch(/, card 8$/);
    expect(within(row).getAllByRole("listitem")).toHaveLength(1);
  });

  it("lists nobody off the table in an anonymous reveal: its row holds every card", async () => {
    await renderRoom(ownerRound({ revealNames: false }));
    run(ME, { type: "reveal" });
    run("ana", { type: "setRole", role: "observer" });
    expect(screen.queryByRole("list", { name: "Not at the table" })).toBeNull();
    const columns = await screen.findByRole("list", { name: "Votes per card" });
    expect(columns.outerHTML).not.toContain("Name");
  });
});
