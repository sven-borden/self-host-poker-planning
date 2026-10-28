import { apply, type Command, createRoom, type Participant, type RoomState } from "@pp/domain";
import { type HistoryRoundView, toSnapshot } from "@pp/protocol";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { changeLanguage } from "../i18n/i18n.ts";
import { useRoomStore } from "../stores/room-store.ts";
import { RoomHistoryButton } from "./history-button.tsx";

const mocks = vi.hoisted(() => ({ requestHistory: vi.fn() }));
vi.mock("../realtime/room-connection.ts", () => ({ requestHistory: mocks.requestHistory }));

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

function step(state: RoomState, actor: string, command: Command): RoomState {
  const result = apply(state, command, { actor, now: 10 });
  if (!result.ok) throw new Error(result.error);
  return result.state;
}

function show(next: RoomState, viewer: string) {
  act(() => {
    version += 1;
    useRoomStore.getState().receive(toSnapshot(next, viewer, { code: CODE, version, now: 0 }));
    useRoomStore.getState().setStatus("live");
  });
}

const stats = (distribution: { card: string; count: number }[], suggested: string | null) => ({
  distribution,
  core: [],
  mode: null,
  agreement: 0.5,
  spread: null,
  consensus: false,
  average: null,
  median: null,
  suggested,
});

const NOW = Date.now();

const named: HistoryRoundView = {
  number: 2,
  subject: { kind: "title", text: "Login page" },
  final: "5",
  stats: stats(
    [
      { card: "3", count: 1 },
      { card: "5", count: 2 },
    ],
    "5",
  ),
  startedAt: NOW - 200_000,
  revealedAt: NOW - 200_000 + 133_000,
  finishedAt: NOW - 1_000,
  votes: {
    kind: "named",
    votes: [
      { name: "Ana", card: "5" },
      { name: "Ben", card: "3", changedAfterReveal: true },
      { name: null, card: "5" },
    ],
  },
};

const anonymous: HistoryRoundView = {
  number: 1,
  subject: { kind: "link", url: "https://acme.atlassian.net/browse/PAY-482", key: "PAY-482" },
  final: null,
  stats: stats(
    [
      { card: "8", count: 1 },
      { card: "☕", count: 1 },
    ],
    "8",
  ),
  startedAt: NOW - 400_000,
  revealedAt: NOW - 400_000 + 42_000,
  finishedAt: NOW - 300_000,
  votes: { kind: "anonymous", cards: ["8", "☕"] },
};

const page = (rounds: HistoryRoundView[], next?: number) =>
  next === undefined ? { ok: true, rounds } : { ok: true, rounds, next };

async function openPanel() {
  fireEvent.click(screen.getByRole("button", { name: "History" }));
  return screen.findByRole("dialog", { name: "History" });
}

const rowOf = (dialog: HTMLElement, number: number) => {
  const found = dialog.querySelector<HTMLElement>(`[data-history-round="${number}"]`);
  if (!found) throw new Error(`no row ${number}`);
  return found;
};

beforeAll(async () => {
  await import("./history-panel.tsx");
}, 30_000);

beforeEach(() => {
  version = 1;
  useRoomStore.getState().open(CODE);
});

afterEach(async () => {
  cleanup();
  useRoomStore.getState().reset();
  mocks.requestHistory.mockReset();
  await act(() => changeLanguage("en"));
});

describe("the History button", () => {
  it("shows for everyone in the room, never on the join form", () => {
    render(<RoomHistoryButton />);
    show(newRoom(), "stranger");
    expect(screen.queryByRole("button", { name: "History" })).toBeNull();
    show(newRoom(), ANA);
    expect(screen.getByRole("button", { name: "History" })).toHaveProperty("ariaExpanded", "false");
  });
});

describe("the history panel", () => {
  it("lists the rounds newest first: number, subject, final, distribution, voting time and end", async () => {
    mocks.requestHistory.mockResolvedValue(page([named, anonymous]));
    render(<RoomHistoryButton />);
    show(step(newRoom(), PO, { type: "startRound", subject: { kind: "none" } }), ANA);
    const dialog = await openPanel();
    await waitFor(() =>
      expect(document.activeElement).toBe(within(dialog).getByRole("heading", { name: "History" })),
    );
    const list = await within(dialog).findByRole("list", { name: "Finished rounds" });
    expect(mocks.requestHistory).toHaveBeenCalledWith();
    const rows = within(list).getAllByRole("listitem", { name: /^Round/ });
    expect(rows.map((row) => row.getAttribute("data-history-round"))).toEqual(["2", "1"]);

    const second = rowOf(dialog, 2);
    expect(within(second).getByRole("heading", { name: "Round 2" })).toBeTruthy();
    expect(second.querySelector("[data-history-subject='title']")?.textContent).toBe("Login page");
    expect(second.querySelector("[data-history-final]")?.textContent).toContain(
      "Final estimate: 5.",
    );
    const perCard = within(second).getByRole("list", { name: "Votes per card" });
    expect([...perCard.querySelectorAll(".sr-only")].map((s) => s.textContent)).toEqual([
      "3: 1 vote",
      "5: 2 votes",
    ]);
    const duration = second.querySelector("[data-history-duration]");
    expect(duration?.getAttribute("data-history-duration")).toBe("133");
    expect(duration?.textContent).toContain("2\u{a0}min 13\u{a0}s");
    expect(duration?.textContent).toContain("Voting took 2 minutes 13 seconds.");
    const time = second.querySelector("time");
    expect(time?.getAttribute("datetime")).toBe(new Date(named.finishedAt).toISOString());
    expect(second.textContent).toContain(`Ended at ${time?.textContent}.`);

    const first = rowOf(dialog, 1);
    const link = within(first).getByRole("link", { name: "PAY-482 (opens in a new tab)" });
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
    const noFinal = first.querySelector("[data-history-final]");
    expect(noFinal?.textContent).toBe("FinalNoneNo final estimate.");
    expect(first.querySelector("[data-history-duration]")?.textContent).toContain("42\u{a0}s");
    expect(within(first).getByRole("list", { name: "Votes per card" }).textContent).toContain(
      "needs a break: 1 vote",
    );
  });

  it("opens a named round's votes with names and cards, and an anonymous one's cards alone", async () => {
    mocks.requestHistory.mockResolvedValue(page([named, anonymous]));
    render(<RoomHistoryButton />);
    show(newRoom(), PO);
    const dialog = await openPanel();
    await within(dialog).findByRole("list", { name: "Finished rounds" });

    const toggle = within(dialog).getByRole("button", { name: "Votes of round 2" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    const votes = document.getElementById(toggle.getAttribute("aria-controls") ?? "");
    expect(votes?.hidden).toBe(true);
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(votes?.hidden).toBe(false);
    expect([...(votes?.querySelectorAll("li .sr-only") ?? [])].map((s) => s.textContent)).toEqual([
      "Ana: 5",
      "Ben: 3, changed after the reveal",
      "Someone who left: 5",
    ]);
    expect(votes?.querySelectorAll("[data-history-changed]")).toHaveLength(1);
    fireEvent.click(toggle);
    expect(votes?.hidden).toBe(true);

    const anonymousToggle = within(dialog).getByRole("button", { name: "Votes of round 1" });
    fireEvent.click(anonymousToggle);
    const cards = document.getElementById(anonymousToggle.getAttribute("aria-controls") ?? "");
    expect(cards?.textContent).toContain("Anonymous round");
    expect(cards?.textContent?.match(/Anonymous round/g)).toHaveLength(1);
    expect(
      within(cards as HTMLElement)
        .getAllByRole("listitem")
        .map((li) => li.textContent),
    ).toEqual(["88", "needs a break"]);
    for (const name of ["Ana", "Ben", "Pia"]) {
      expect(rowOf(dialog, 1).textContent).not.toContain(name);
    }
  });

  it("says so when no round is finished yet", async () => {
    mocks.requestHistory.mockResolvedValue(page([]));
    render(<RoomHistoryButton />);
    show(newRoom(), ANA);
    const dialog = await openPanel();
    expect(await within(dialog).findByText(/^No rounds yet\./)).toBeTruthy();
    expect(dialog.querySelector("[data-history-empty]")?.textContent).toBe(
      "No rounds yet. A round appears here once the next round starts.",
    );
  });

  it("says No votes for a round nobody voted in, with nothing to open", async () => {
    const silent: HistoryRoundView = {
      ...anonymous,
      number: 3,
      stats: stats([], null),
      votes: { kind: "named", votes: [] },
    };
    const silentAnonymous: HistoryRoundView = {
      ...silent,
      number: 4,
      votes: { kind: "anonymous", cards: [] },
    };
    mocks.requestHistory.mockResolvedValue(page([silentAnonymous, silent, named]));
    render(<RoomHistoryButton />);
    show(newRoom(), ANA);
    const dialog = await openPanel();
    await within(dialog).findByRole("list", { name: "Finished rounds" });
    for (const number of [4, 3]) {
      const row = rowOf(dialog, number);
      expect(row.querySelector("[data-history-no-votes]")?.textContent).toBe("No votes");
      expect(row.querySelector("[data-history-toggle]")).toBeNull();
      expect(row.querySelector("[data-history-votes]")).toBeNull();
    }
    expect(rowOf(dialog, 2).querySelector("[data-history-no-votes]")).toBeNull();
    expect(within(dialog).getByRole("button", { name: "Votes of round 2" })).toBeTruthy();
  });

  it("gives a voting time from an hour on in hours and minutes", async () => {
    const long = (number: number, seconds: number): HistoryRoundView => ({
      ...named,
      number,
      startedAt: NOW - 10_000_000,
      revealedAt: NOW - 10_000_000 + seconds * 1000,
    });
    mocks.requestHistory.mockResolvedValue(page([long(3, 3725), long(2, 7200)]));
    render(<RoomHistoryButton />);
    show(newRoom(), ANA);
    const dialog = await openPanel();
    await within(dialog).findByRole("list", { name: "Finished rounds" });
    const duration = (number: number) =>
      rowOf(dialog, number).querySelector("[data-history-duration]")?.textContent;
    expect(duration(3)).toBe("1\u{a0}h 2\u{a0}minVoting took 1 hour 2 minutes.");
    expect(duration(2)).toBe("2\u{a0}h 0\u{a0}minVoting took 2 hours.");
  });

  it("fetches the first page again when a round starts or the table's round gets its final", async () => {
    mocks.requestHistory.mockResolvedValue(page([anonymous]));
    render(<RoomHistoryButton />);
    let room = step(newRoom(), PO, { type: "startRound", subject: { kind: "none" } });
    show(room, ANA);
    const dialog = await openPanel();
    await within(dialog).findByRole("list", { name: "Finished rounds" });
    expect(mocks.requestHistory).toHaveBeenCalledTimes(1);

    // A vote changes nothing here.
    room = step(room, ANA, { type: "castVote", card: "5", round: 1 });
    show(room, ANA);
    room = step(room, PO, { type: "castVote", card: "8", round: 1 });
    show(room, ANA);
    expect(mocks.requestHistory).toHaveBeenCalledTimes(1);
    // The final, then the next round: each asks again, and the new row shows.
    room = step(room, PO, { type: "setFinal", card: "8" });
    show(room, ANA);
    await waitFor(() => expect(mocks.requestHistory).toHaveBeenCalledTimes(2));
    mocks.requestHistory.mockResolvedValue(page([named, anonymous]));
    show(step(room, PO, { type: "startRound", subject: { kind: "none" } }), ANA);
    await waitFor(() => expect(mocks.requestHistory).toHaveBeenCalledTimes(3));
    await waitFor(() => expect(rowOf(dialog, 2)).toBeTruthy());
  });

  it("shows earlier rounds on demand and moves the focus to the first of them", async () => {
    mocks.requestHistory.mockImplementation(async (request?: { before?: number }) =>
      request?.before === 2 ? page([anonymous]) : page([named], 2),
    );
    render(<RoomHistoryButton />);
    show(newRoom(), ANA);
    const dialog = await openPanel();
    const more = await within(dialog).findByRole("button", { name: "Show earlier rounds" });
    fireEvent.click(more);
    await waitFor(() =>
      expect(document.activeElement).toBe(
        within(dialog).getByRole("button", { name: "Votes of round 1" }),
      ),
    );
    expect(mocks.requestHistory).toHaveBeenLastCalledWith({ before: 2 });
    expect(within(dialog).queryByRole("button", { name: "Show earlier rounds" })).toBeNull();
  });

  it("says when the rounds could not load, and tries again", async () => {
    mocks.requestHistory.mockResolvedValueOnce({ ok: false, code: "offline" });
    mocks.requestHistory.mockResolvedValueOnce(page([named]));
    render(<RoomHistoryButton />);
    show(newRoom(), ANA);
    const dialog = await openPanel();
    expect(await within(dialog).findByRole("alert")).toHaveProperty(
      "textContent",
      "Could not load the rounds. Try again.",
    );
    fireEvent.click(within(dialog).getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(rowOf(dialog, 2)).toBeTruthy());
  });

  it("closes on Escape and gives the focus back to History", async () => {
    mocks.requestHistory.mockResolvedValue(page([named]));
    render(<RoomHistoryButton />);
    show(newRoom(), ANA);
    const dialog = await openPanel();
    await within(dialog).findByRole("list", { name: "Finished rounds" });
    fireEvent.keyDown(document.activeElement ?? dialog, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "History" }));
  });

  it("speaks French and German", async () => {
    mocks.requestHistory.mockResolvedValue(page([named]));
    await act(() => changeLanguage("fr"));
    render(<RoomHistoryButton />);
    show(newRoom(), ANA);
    fireEvent.click(screen.getByRole("button", { name: "Historique" }));
    const dialog = await screen.findByRole("dialog", { name: "Historique" });
    const row = await waitFor(() => rowOf(dialog, 2));
    expect(within(row).getByRole("heading", { name: "Tour 2" })).toBeTruthy();
    expect(row.textContent).toContain("Le vote a duré 2 minutes 13 secondes.");
    expect(row.querySelector("[data-history-final]")?.textContent).toContain("Finale");
    cleanup();
    await act(() => changeLanguage("de"));
    render(<RoomHistoryButton />);
    fireEvent.click(screen.getByRole("button", { name: "Verlauf" }));
    const german = await screen.findByRole("dialog", { name: "Verlauf" });
    const germanRow = await waitFor(() => rowOf(german, 2));
    expect(germanRow.textContent).toContain("Runde 2");
    expect(germanRow.textContent).toContain("Die Abstimmung dauerte 2 Minuten 13 Sekunden.");
    expect(within(german).getByRole("button", { name: "Stimmen der Runde 2" })).toBeTruthy();
  });
});
