import { apply, type Command, createRoom, type Participant, type RoomState } from "@pp/domain";
import { type HistoryRoundView, toSnapshot } from "@pp/protocol";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { changeLanguage } from "../i18n/i18n.ts";
import { useRoomStore } from "../stores/room-store.ts";
import { RoomHistoryButton } from "./history-button.tsx";
import { forgetSummaryRounds } from "./history-summary.tsx";

const mocks = vi.hoisted(() => ({ requestHistory: vi.fn() }));
vi.mock("../realtime/room-connection.ts", () => ({ requestHistory: mocks.requestHistory }));
// The summary's pace (8 at once, then 2 a second) is tested in history-pace.test.ts; here
// pages come as fast as the mock answers.
vi.mock("./history-pace.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./history-pace.ts")>();
  return { ...actual, historyPace: actual.createPacer({ burst: 1000, perSecond: 1000 }) };
});

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

/** The list's requests (no `limit`) and the summary's (50 a page), counted apart. */
const callsWith = (summary: boolean) =>
  mocks.requestHistory.mock.calls.filter(
    ([request]) => ((request as { limit?: number } | undefined)?.limit !== undefined) === summary,
  ).length;
const listCalls = () => callsWith(false);
const summaryCalls = () => callsWith(true);

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
  forgetSummaryRounds();
  await act(() => changeLanguage("en"));
});

describe("the History button", () => {
  it("shows for everyone in the room, never on the join form", () => {
    render(<RoomHistoryButton roomName="Team Sky" />);
    show(newRoom(), "stranger");
    expect(screen.queryByRole("button", { name: "History" })).toBeNull();
    show(newRoom(), ANA);
    expect(screen.getByRole("button", { name: "History" })).toHaveProperty("ariaExpanded", "false");
  });
});

describe("the history panel", () => {
  it("lists the rounds newest first: number, subject, final, distribution, voting time and end", async () => {
    mocks.requestHistory.mockResolvedValue(page([named, anonymous]));
    render(<RoomHistoryButton roomName="Team Sky" />);
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
    render(<RoomHistoryButton roomName="Team Sky" />);
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
    render(<RoomHistoryButton roomName="Team Sky" />);
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
    render(<RoomHistoryButton roomName="Team Sky" />);
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
    render(<RoomHistoryButton roomName="Team Sky" />);
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
    render(<RoomHistoryButton roomName="Team Sky" />);
    let room = step(newRoom(), PO, { type: "startRound", subject: { kind: "none" } });
    show(room, ANA);
    const dialog = await openPanel();
    await within(dialog).findByRole("list", { name: "Finished rounds" });
    expect(listCalls()).toBe(1);
    await waitFor(() => expect(summaryCalls()).toBe(1));

    // A vote changes nothing here.
    room = step(room, ANA, { type: "castVote", card: "5", round: 1 });
    show(room, ANA);
    room = step(room, PO, { type: "castVote", card: "8", round: 1 });
    show(room, ANA);
    expect(listCalls()).toBe(1);
    expect(summaryCalls()).toBe(1);
    // The final, then the next round: each asks again (the list and the summary), and the
    // new row shows.
    room = step(room, PO, { type: "setFinal", card: "8" });
    show(room, ANA);
    await waitFor(() => expect(listCalls()).toBe(2));
    await waitFor(() => expect(summaryCalls()).toBe(2));
    mocks.requestHistory.mockResolvedValue(page([named, anonymous]));
    show(step(room, PO, { type: "startRound", subject: { kind: "none" } }), ANA);
    await waitFor(() => expect(listCalls()).toBe(3));
    await waitFor(() => expect(summaryCalls()).toBe(3));
    await waitFor(() => expect(rowOf(dialog, 2)).toBeTruthy());
  });

  it("shows earlier rounds on demand and moves the focus to the first of them", async () => {
    mocks.requestHistory.mockImplementation(async (request?: { before?: number }) =>
      request?.before === 2 ? page([anonymous]) : page([named], 2),
    );
    render(<RoomHistoryButton roomName="Team Sky" />);
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
    // The list's first request fails; the summary's (50 a page) does not.
    let failed = false;
    mocks.requestHistory.mockImplementation(async (request?: { limit?: number }) => {
      if (request?.limit === undefined && !failed) {
        failed = true;
        return { ok: false, code: "offline" };
      }
      return page([named]);
    });
    render(<RoomHistoryButton roomName="Team Sky" />);
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
    render(<RoomHistoryButton roomName="Team Sky" />);
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
    render(<RoomHistoryButton roomName="Team Sky" />);
    show(newRoom(), ANA);
    fireEvent.click(screen.getByRole("button", { name: "Historique" }));
    const dialog = await screen.findByRole("dialog", { name: "Historique" });
    const row = await waitFor(() => rowOf(dialog, 2));
    expect(within(row).getByRole("heading", { name: "Tour 2" })).toBeTruthy();
    expect(row.textContent).toContain("Le vote a duré 2 minutes 13 secondes.");
    expect(row.querySelector("[data-history-final]")?.textContent).toContain("Finale");
    cleanup();
    await act(() => changeLanguage("de"));
    render(<RoomHistoryButton roomName="Team Sky" />);
    fireEvent.click(screen.getByRole("button", { name: "Verlauf" }));
    const german = await screen.findByRole("dialog", { name: "Verlauf" });
    const germanRow = await waitFor(() => rowOf(german, 2));
    expect(germanRow.textContent).toContain("Runde 2");
    expect(germanRow.textContent).toContain("Die Abstimmung dauerte 2 Minuten 13 Sekunden.");
    expect(within(german).getByRole("button", { name: "Stimmen der Runde 2" })).toBeTruthy();
  });
});

describe("the summary and the exports", () => {
  const summaryOf = (dialog: HTMLElement) =>
    waitFor(() => {
      const found = dialog.querySelector<HTMLElement>("[data-history-summary]");
      if (!found) throw new Error("no summary");
      return found;
    });
  const figure = (summary: HTMLElement, name: string) =>
    summary.querySelector(`[data-summary-stat=${name}]`)?.textContent;
  const TWO_DAYS = 2 * 24 * 3600 * 1000;

  it("sums today's rounds by default, and every round on demand", async () => {
    const old: HistoryRoundView = { ...anonymous, finishedAt: NOW - TWO_DAYS };
    mocks.requestHistory.mockResolvedValue(page([named, old]));
    render(<RoomHistoryButton roomName="Team Sky" />);
    show(newRoom(), ANA);
    const dialog = await openPanel();
    const summary = await summaryOf(dialog);
    expect(within(summary).getByRole("radio", { name: "Today" })).toHaveProperty("checked", true);
    expect(figure(summary, "rounds")).toBe("Rounds1");
    expect(figure(summary, "total")).toBe("Total of final estimates5");
    expect(figure(summary, "agreement")).toBe("Average agreementno value");
    expect(figure(summary, "time")).toBe(
      "Average voting time2\u{a0}min 13\u{a0}s2 minutes 13 seconds",
    );
    fireEvent.click(within(summary).getByRole("radio", { name: "All rounds" }));
    expect(figure(summary, "rounds")).toBe("Rounds2");
    expect(figure(summary, "total")).toBe(
      "Total of final estimates51 round without a numeric estimate",
    );
    // The summary read every round, 50 a page.
    expect(mocks.requestHistory).toHaveBeenCalledWith({ limit: 50 });
  });

  it("copies the lines for Jira or Azure DevOps, and shows them when the clipboard is refused", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    const keyed: HistoryRoundView = { ...anonymous, final: "3" };
    mocks.requestHistory.mockResolvedValue(page([named, keyed]));
    render(<RoomHistoryButton roomName="Team Sky" />);
    show(newRoom(), ANA);
    const dialog = await openPanel();
    const summary = await summaryOf(dialog);
    const exportButton = within(summary).getByRole("button", { name: "Export" });
    const pick = async (name: string) => {
      await waitFor(() => expect(exportButton).toHaveProperty("disabled", false));
      fireEvent.keyDown(exportButton, { key: "Enter" });
      fireEvent.click(await screen.findByRole("menuitem", { name }));
    };
    const status = () => summary.querySelector("[data-export-status]")?.textContent;

    await pick("Copy for Jira or Azure DevOps");
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("PAY-482 3"));
    await waitFor(() =>
      expect(status()).toBe(
        "1 line copied for Jira or Azure DevOps. 1 round skipped: no key or no final estimate.",
      ),
    );

    writeText.mockRejectedValue(new Error("refused"));
    await pick("Copy for Jira or Azure DevOps");
    const field = await within(summary).findByRole("textbox", { name: "Text to copy" });
    expect(field).toHaveProperty("value", "PAY-482 3");
    expect(field).toHaveProperty("readOnly", true);
    await waitFor(() => expect(document.activeElement).toBe(field));
    expect(status()).toMatch(/^The browser did not allow copying\./);
    Reflect.deleteProperty(navigator, "clipboard");
  });

  /** Rounds `from` down to `to`, newest first, ended at `finishedAt`. */
  const rounds = (from: number, to: number, finishedAt: number): HistoryRoundView[] =>
    Array.from({ length: from - to + 1 }, (_, i) => ({ ...named, number: from - i, finishedAt }));
  /** A history of `pages`, keyed by the `before` that asks for each (undefined: the first). */
  const history =
    (pages: Map<number | undefined, ReturnType<typeof page>>) =>
    async (request?: { before?: number }) =>
      pages.get(request?.before) ?? page([]);
  const beforeOf = () =>
    mocks.requestHistory.mock.calls
      .map(([request]) => request as { before?: number; limit?: number } | undefined)
      .filter((request) => request?.limit !== undefined)
      .map((request) => request?.before);

  it("reads every page, 50 at a time, and counts the rounds of all of them", async () => {
    const old = NOW - TWO_DAYS;
    mocks.requestHistory.mockImplementation(
      history(
        new Map([
          [undefined, page(rounds(120, 71, old), 71)],
          [71, page(rounds(70, 21, old), 21)],
          [21, page(rounds(20, 1, old))],
        ]),
      ),
    );
    render(<RoomHistoryButton roomName="Team Sky" />);
    show(newRoom(), ANA);
    const summary = await summaryOf(await openPanel());
    await waitFor(() => expect(figure(summary, "rounds")).toBe("Rounds120"));
    expect(within(summary).getByRole("radio", { name: "All rounds" })).toHaveProperty(
      "checked",
      true,
    );
    expect(beforeOf()).toEqual([undefined, 71, 21]);
    expect(summary.querySelector("[data-summary-capped]")).toBeNull();
  });

  it("stops at 1,000 rounds and says older ones are left out", async () => {
    const old = NOW - TWO_DAYS;
    // An endless history: every page has an earlier one.
    mocks.requestHistory.mockImplementation(async (request?: { before?: number }) => {
      const top = (request?.before ?? 5001) - 1;
      return page(rounds(top, top - 49, old), top - 49);
    });
    render(<RoomHistoryButton roomName="Team Sky" />);
    show(newRoom(), ANA);
    const summary = await summaryOf(await openPanel());
    await waitFor(() => expect(figure(summary, "rounds")).toBe("Rounds1,000"));
    expect(summaryCalls()).toBe(20);
    expect(summary.querySelector("[data-summary-capped]")?.textContent).toBe(
      "Only the latest 1,000 rounds are counted.",
    );
  });

  it("reads for Today down to a round of yesterday, and on for All rounds", async () => {
    const old = NOW - TWO_DAYS;
    mocks.requestHistory.mockImplementation(
      history(
        new Map([
          [undefined, page(rounds(150, 101, NOW - 1_000), 101)],
          [101, page([...rounds(100, 91, NOW - 1_000), ...rounds(90, 51, old)], 51)],
          [51, page(rounds(50, 1, old))],
        ]),
      ),
    );
    render(<RoomHistoryButton roomName="Team Sky" />);
    show(newRoom(), ANA);
    const summary = await summaryOf(await openPanel());
    await waitFor(() => expect(figure(summary, "rounds")).toBe("Rounds60"));
    expect(within(summary).getByRole("radio", { name: "Today" })).toHaveProperty("checked", true);
    expect(beforeOf()).toEqual([undefined, 101]);
    fireEvent.click(within(summary).getByRole("radio", { name: "All rounds" }));
    await waitFor(() => expect(figure(summary, "rounds")).toBe("Rounds150"));
    expect(beforeOf()).toEqual([undefined, 101, 51]);
  });

  it("says it is counting until the pages are in, stops when the panel closes, and keeps the rounds", async () => {
    const old = NOW - TWO_DAYS;
    let answer: (value: ReturnType<typeof page>) => void = () => {};
    const pages = new Map([
      [undefined, page(rounds(150, 101, old), 101)],
      [51, page(rounds(50, 1, old))],
    ]);
    mocks.requestHistory.mockImplementation(async (request?: { before?: number }) =>
      request?.before === 101
        ? new Promise((resolve) => {
            answer = resolve;
          })
        : (pages.get(request?.before) ?? page([])),
    );
    render(<RoomHistoryButton roomName="Team Sky" />);
    show(newRoom(), ANA);
    let dialog = await openPanel();
    let summary = await summaryOf(dialog);
    await waitFor(() => expect(beforeOf()).toEqual([undefined, 101]));
    // Only the first page is in: no figures yet, and nothing to export.
    expect(summary.querySelector("[data-summary-counting]")?.textContent).toBe(
      "Counting the rounds…",
    );
    expect(summary.querySelector("[data-summary-stat]")).toBeNull();
    expect(within(summary).getByRole("button", { name: "Export" })).toHaveProperty(
      "disabled",
      true,
    );

    // Closed: the page that comes in after is dropped, and no further page is asked for.
    fireEvent.keyDown(document.activeElement ?? dialog, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await act(async () => answer(page(rounds(100, 51, old), 51)));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(beforeOf()).toEqual([undefined, 101]);

    // Reopened: the first page again, then on from where the held rounds end.
    mocks.requestHistory.mockImplementation(
      history(new Map([...pages, [101, page(rounds(100, 51, old), 51)]])),
    );
    dialog = await openPanel();
    summary = await summaryOf(dialog);
    await waitFor(() => expect(figure(summary, "rounds")).toBe("Rounds150"));
    expect(beforeOf()).toEqual([undefined, 101, undefined, 101, 51]);
    fireEvent.keyDown(document.activeElement ?? dialog, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    // Reopened with every round held: the first page alone, and the figures at once.
    dialog = await openPanel();
    summary = await summaryOf(dialog);
    expect(figure(summary, "rounds")).toBe("Rounds150");
    await waitFor(() => expect(summaryCalls()).toBe(6));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(beforeOf()).toEqual([undefined, 101, undefined, 101, 51, undefined]);
  });

  it("focuses and selects the text to copy when the page has no clipboard", async () => {
    Reflect.deleteProperty(navigator, "clipboard");
    expect(navigator.clipboard).toBeUndefined();
    mocks.requestHistory.mockResolvedValue(page([named, { ...anonymous, final: "3" }]));
    render(<RoomHistoryButton roomName="Team Sky" />);
    show(newRoom(), ANA);
    const summary = await summaryOf(await openPanel());
    const exportButton = within(summary).getByRole("button", { name: "Export" });
    await waitFor(() => expect(exportButton).toHaveProperty("disabled", false));
    fireEvent.keyDown(exportButton, { key: "Enter" });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Copy Markdown" }));
    const field = await within(summary).findByRole<HTMLTextAreaElement>("textbox", {
      name: "Text to copy",
    });
    // Radix gives the focus back in a timeout once the menu closed: after it, the field
    // still holds it, with all its text selected.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(document.activeElement).toBe(field);
    expect(field.value).toMatch(/^# Poker Planning: Team Sky/);
    expect(field.selectionStart).toBe(0);
    expect(field.selectionEnd).toBe(field.value.length);

    // A download afterwards gives the focus back to Export, as the menu does.
    fireEvent.keyDown(exportButton, { key: "Enter" });
    const saved = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:x");
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    fireEvent.click(await screen.findByRole("menuitem", { name: "Download CSV" }));
    await waitFor(() => expect(document.activeElement).toBe(exportButton));
    saved.mockRestore();
    click.mockRestore();
  });
});
