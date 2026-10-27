import { createRoom, OWNER_CLAIM_AFTER_MS, type Participant, type RoomState } from "@pp/domain";
import { toSnapshot } from "@pp/protocol";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { changeLanguage } from "../i18n/i18n.ts";
import { useIdentityStore } from "../stores/identity-store.ts";
import { useRoomStore } from "../stores/room-store.ts";
import { CLAIM_REFUSAL_MS } from "./claim-banner.tsx";
import { RoomView } from "./room-view.tsx";

// The PO's powers (#30) on the room page: the actions in each person's popover and their
// questions, the claim banner and its timing, and the removed person's notice.

const mocks = vi.hoisted(() => ({ sendCommand: vi.fn(), commandSender: vi.fn() }));
vi.mock("../realtime/room-connection.ts", () => ({
  sendCommand: mocks.sendCommand,
  commandSender: mocks.commandSender,
}));

const CODE = "abcdefghij";
const ME = "me";
let version = 1;

type Person = [id: string, name: string, role: Participant["role"], extra?: Partial<Participant>];

function stateWith(
  owner: string,
  people: Person[],
  settings: Partial<RoomState["settings"]> = {},
): RoomState {
  const state = createRoom({ ownerId: owner });
  const participants: Record<string, Participant> = {};
  people.forEach(([id, name, role, extra], i) => {
    participants[id] = { name, role, joinedAt: i + 1, connected: true, ...extra };
  });
  return { ...state, settings: { ...state.settings, ...settings }, participants };
}

/** The server's next snapshot of `state`, as this viewer sees it, at the server's `now`. */
function show(state: RoomState, now = Date.now()) {
  act(() => {
    version += 1;
    useRoomStore.getState().receive(toSnapshot(state, ME, { code: CODE, version, now }));
    useRoomStore.getState().setStatus("live");
  });
}

async function showSeated(state: RoomState, now?: number) {
  show(state, now);
  await screen.findByRole("heading", { name: "You" });
}

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

const ana: Person = ["ua", "Ana", "voter"];
const ben: Person = ["ub", "Ben", "observer"];
const cleo: Person = ["uc", "Cleo", "voter"];
const meVoter: Person = [ME, "Me", "voter"];

/** Opens the popover of the person whose button is named `name`. */
function openPerson(name: string) {
  fireEvent.click(screen.getByRole("button", { name }));
  return screen.getByRole("dialog");
}

beforeAll(async () => {
  await import("./seated.tsx");
}, 30_000);

beforeEach(() => {
  vi.spyOn(window, "scrollTo").mockImplementation(() => {});
  version = 1;
  useRoomStore.getState().open(CODE);
  mocks.commandSender.mockImplementation(
    () => (command: unknown) => mocks.sendCommand(command) as unknown,
  );
});

afterEach(async () => {
  cleanup();
  useRoomStore.getState().reset();
  useIdentityStore.getState().reset();
  mocks.sendCommand.mockReset();
  mocks.commandSender.mockReset();
  vi.useRealTimers();
  vi.restoreAllMocks();
  await act(() => changeLanguage("en"));
});

describe("the PO's actions in a popover", () => {
  it("are the PO's only, on everyone but the PO", async () => {
    await renderView();
    await showSeated(stateWith(ME, [meVoter, ana, ben]));
    expect(
      within(openPerson("Ana")).getByRole("button", { name: "Make product owner" }),
    ).toBeTruthy();
    cleanup();

    await renderView();
    await showSeated(stateWith("ua", [meVoter, ana, ben]));
    const popover = openPerson("Ana, product owner");
    expect(within(popover).queryByRole("button")).toBeNull();
    expect(popover.textContent).toContain("Product owner");
  });

  it("hand over: asks first, with the focus on the question; Cancel gives it back", async () => {
    await renderView();
    await showSeated(stateWith(ME, [meVoter, ana, ben]));
    const popover = openPerson("Ana");
    const make = within(popover).getByRole("button", { name: "Make product owner" });
    fireEvent.click(make);
    const question = within(popover).getByRole("group", {
      name: "Hand the product owner role to Ana? You become a voter.",
    });
    expect(document.activeElement).toBe(question);
    expect(mocks.sendCommand).not.toHaveBeenCalled();
    fireEvent.click(within(question).getByRole("button", { name: "Cancel" }));
    expect(within(popover).queryByRole("group")).toBeNull();
    expect(document.activeElement).toBe(
      within(popover).getByRole("button", { name: "Make product owner" }),
    );
  });

  it("hand over: sends transferOwner and closes the popover once the server agreed", async () => {
    await renderView();
    const before = stateWith(ME, [meVoter, ana, ben]);
    await showSeated(before);
    mocks.sendCommand.mockImplementationOnce(async () => {
      // The snapshot comes before the ack: the viewer is no longer the PO.
      show({ ...before, ownerId: "ua" });
      return { ok: true, version };
    });
    const popover = openPerson("Ana");
    fireEvent.click(within(popover).getByRole("button", { name: "Make product owner" }));
    fireEvent.click(within(popover).getByRole("button", { name: "Hand over" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(mocks.sendCommand).toHaveBeenCalledWith({
      type: "transferOwner",
      payload: { to: "ua" },
    });
    // The crown moved: Ana's seat says so, and the viewer's controls went with it.
    expect(screen.getByRole("button", { name: "Ana, product owner" })).toBeTruthy();
  });

  it("says what the hand-over means when the PO does not vote, and from an observer PO", async () => {
    await renderView();
    await showSeated(stateWith(ME, [[ME, "Me", "observer"], ana, ben], { poVotes: false }));
    const popover = openPerson("Ana");
    fireEvent.click(within(popover).getByRole("button", { name: "Make product owner" }));
    const question = within(popover).getByRole("group", {
      name: "Hand the product owner role to Ana? You stay an observer.",
    });
    expect(question.getAttribute("aria-describedby")).toBeTruthy();
    expect(question.textContent).toContain(
      "The product owner does not vote in this room, so Ana stops voting.",
    );
    cleanup();

    // An observer taking over has no cards to put down.
    await renderView();
    await showSeated(stateWith(ME, [meVoter, ana, ben], { poVotes: false }));
    const row = openPerson("Ben");
    fireEvent.click(within(row).getByRole("button", { name: "Make product owner" }));
    expect(within(row).getByRole("group").textContent).not.toContain("stops voting");
  });

  it("offers no hand-over to someone away, and shows a refusal under the question", async () => {
    await renderView();
    await showSeated(stateWith(ME, [meVoter, ["ua", "Ana", "voter", { awaySince: 1 }], ben]));
    const popover = openPerson("Ana, away");
    expect(within(popover).queryByRole("button", { name: "Make product owner" })).toBeNull();
    fireEvent.click(within(popover).getByRole("button", { name: "Remove from the room" }));
    mocks.sendCommand.mockResolvedValueOnce({ ok: false, code: "not_owner" });
    fireEvent.click(within(popover).getByRole("button", { name: "Remove" }));
    expect(await within(popover).findByRole("alert")).toHaveProperty(
      "textContent",
      "Only the product owner can do that.",
    );
  });

  it("remove: asks, sends kick, and the focus goes to the seat that took the place", async () => {
    await renderView();
    const before = stateWith(ME, [meVoter, ana, cleo]);
    await showSeated(before);
    mocks.sendCommand.mockImplementationOnce(async () => {
      const { ua: _, ...rest } = before.participants;
      show({ ...before, participants: rest });
      return { ok: true, version };
    });
    const popover = openPerson("Ana");
    fireEvent.click(within(popover).getByRole("button", { name: "Remove from the room" }));
    const question = within(popover).getByRole("group", {
      name: "Remove Ana from the room? They can join again with the link.",
    });
    expect(document.activeElement).toBe(question);
    fireEvent.click(within(question).getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Ana" })).toBeNull());
    expect(mocks.sendCommand).toHaveBeenCalledWith({ type: "kick", payload: { who: "ua" } });
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole("button", { name: "Cleo" })),
    );
  });

  it("treats unknown_participant on a removal as done", async () => {
    await renderView();
    await showSeated(stateWith(ME, [meVoter, ana]));
    mocks.sendCommand.mockResolvedValueOnce({ ok: false, code: "unknown_participant" });
    const popover = openPerson("Ana");
    fireEvent.click(within(popover).getByRole("button", { name: "Remove from the room" }));
    fireEvent.click(within(popover).getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });
});

describe("the claim banner", () => {
  const claimButton = () => screen.queryByRole("button", { name: "Claim the product owner role" });

  it("stays hidden while the PO is here, and for the PO", async () => {
    await renderView();
    await showSeated(stateWith("ua", [meVoter, ana]));
    expect(claimButton()).toBeNull();
    expect(document.querySelector("[data-claim]")).toBeNull();
  });

  it("shows at once when the PO is not in the room", async () => {
    await renderView();
    await showSeated(stateWith("gone", [meVoter, ana]));
    // The banner's line is a polite live region, there before the banner shows.
    expect(document.querySelector("[data-claim] [role=status]")?.textContent).toBe(
      "The product owner is not in the room.",
    );
    expect(claimButton()).toBeTruthy();
  });

  it("opens two minutes after the PO went away, by the server's clock", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const server = Date.now() + 3_600_000; // The server's clock runs an hour ahead.
    const awaySince = server - OWNER_CLAIM_AFTER_MS + 5_000;
    await renderView();
    await showSeated(stateWith("ua", [meVoter, ["ua", "Ana", "voter", { awaySince }]]), server);
    expect(claimButton()).toBeNull();
    act(() => vi.advanceTimersByTime(4_000));
    expect(claimButton()).toBeNull();
    act(() => vi.advanceTimersByTime(1_100));
    expect(claimButton()).toBeTruthy();
    expect(screen.getByText("Ana, the product owner, is away.")).toBeTruthy();
  });

  it("claims, and the new PO's subject field takes the focus", async () => {
    await renderView();
    const before = stateWith("gone", [meVoter, ana]);
    await showSeated(before);
    mocks.sendCommand.mockImplementationOnce(async () => {
      show({ ...before, ownerId: ME });
      return { ok: true, version };
    });
    fireEvent.click(claimButton() as HTMLElement);
    await waitFor(() => expect(claimButton()).toBeNull());
    expect(mocks.sendCommand).toHaveBeenCalledWith({ type: "claimOwner" });
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole("textbox", { name: "Subject of the next round" }),
      ),
    );
  });

  it("says Not yet and hides the button for a while when the PO is still here", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await renderView();
    await showSeated(stateWith("gone", [meVoter, ana]));
    mocks.sendCommand.mockResolvedValueOnce({ ok: false, code: "owner_present" });
    fireEvent.click(claimButton() as HTMLElement);
    expect((await screen.findByRole("alert")).textContent).toBe(
      "Not yet: the product owner has been away for less than 2 minutes.",
    );
    expect(claimButton()).toBeNull();
    act(() => vi.advanceTimersByTime(CLAIM_REFUSAL_MS + 10));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(claimButton()).toBeTruthy();
  });

  it("says nothing when someone else claimed first", async () => {
    await renderView();
    const before = stateWith("gone", [meVoter, ana]);
    await showSeated(before);
    mocks.sendCommand.mockImplementationOnce(async () => {
      show({ ...before, ownerId: "ua" });
      return { ok: false, code: "owner_present" };
    });
    fireEvent.click(claimButton() as HTMLElement);
    await waitFor(() => expect(claimButton()).toBeNull());
    expect(screen.queryByRole("alert")).toBeNull();
    expect(document.querySelector("[data-claim]")).toBeNull();
  });
});

describe("a PO who does not vote", () => {
  it("has no hand; after a hand-over the old PO gets one and the new one loses theirs", async () => {
    await renderView();
    const before = stateWith(ME, [meVoter, ana], { poVotes: false });
    await showSeated(before);
    expect(screen.queryByRole("toolbar", { name: "Your cards" })).toBeNull();
    expect(screen.getByText("As the product owner, you do not vote in this room.")).toBeTruthy();
    show({ ...before, ownerId: "ua" });
    expect(screen.getByRole("toolbar", { name: "Your cards" })).toBeTruthy();
  });
});

describe("removed by the PO", () => {
  it("shows the join form with the notice, the name field focused, until they join again", async () => {
    useIdentityStore.getState().setIdentity({ userId: ME, name: "Me" });
    await renderView();
    const seated = stateWith("ua", [meVoter, ana]);
    await showSeated(seated);
    const { me: _, ...rest } = seated.participants;
    show({ ...seated, participants: rest });
    act(() => useRoomStore.getState().setRemoved(true));
    const notice = await screen.findByRole("alert");
    expect(notice.textContent).toBe("The product owner removed you from this room.");
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "Your name" })),
    );
    await showSeated(seated);
    expect(useRoomStore.getState().removed).toBe(false);
    expect(document.querySelector("[data-room-removed]")).toBeNull();
  });
});
