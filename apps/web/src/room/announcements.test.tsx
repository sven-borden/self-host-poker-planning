import { apply, type Command, createRoom, type RoomState } from "@pp/domain";
import { type Snapshot, toSnapshot } from "@pp/protocol";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { changeLanguage, fixedT, loadLanguage } from "../i18n/i18n.ts";
import { useRoomStore } from "../stores/room-store.ts";
import { describeEvents, type LiveEvent, liveEvents, mergeEvents } from "./announcements.ts";
import { LIVE_MAX_WAIT_MS, LIVE_QUIET_MS, LiveAnnouncer } from "./live-announcer.tsx";

const CODE = "abcdefghij";

/** A room run through `apply`, with the snapshot each step gives `viewer`. */
function story(viewer = "me") {
  let state: RoomState = createRoom({ ownerId: "me" });
  let version = 1;
  const snapshots: Snapshot[] = [];
  const run = (actor: string, command: Command) => {
    const result = apply(state, command, { actor, now: 1000 + version });
    if (!result.ok) throw new Error(result.error);
    state = result.state;
    version += 1;
    const snapshot = toSnapshot(state, viewer, {
      code: CODE,
      version,
      now: 0,
      causes: result.causes,
    });
    snapshots.push(snapshot);
    return snapshot;
  };
  return { run, snapshots };
}

const t = fixedT("en");
const said = (events: LiveEvent[]) => describeEvents(t, events);
/** The result of a round where only Ana voted, 13. */
const ana13 = { kind: "suggested", card: "13", agreement: 1, mostVoted: false } as const;

describe("liveEvents", () => {
  it("names joins, leaves, away and back, and first votes; never the viewer's own", () => {
    const { run } = story();
    run("me", { type: "join", name: "Me", role: "voter" });
    const joined = run("ana", { type: "join", name: "Ana", role: "voter" });
    expect(liveEvents(joined.room, joined.causes, null)).toEqual([
      { kind: "joined", who: "ana", name: "Ana" },
    ]);
    run("me", { type: "startRound", subject: { kind: "none" } });
    const before = run("ben", { type: "join", name: "Ben", role: "voter" });
    const mine = run("me", { type: "castVote", card: "5" });
    expect(liveEvents(mine.room, mine.causes, before.room)).toEqual([]);
    const voted = run("ana", { type: "castVote", card: "8" });
    expect(liveEvents(voted.room, voted.causes, mine.room)).toEqual([
      { kind: "voted", who: "ana", name: "Ana" },
    ]);
    // A changed card is not news.
    const changed = run("ana", { type: "castVote", card: "13" });
    expect(liveEvents(changed.room, changed.causes, voted.room)).toEqual([]);
    const away = run(":server", { type: "presence", who: "ben", connected: false });
    // Everyone present has voted once Ben is away: the round reveals itself.
    expect(said(liveEvents(away.room, away.causes, changed.room))).toBe(
      "Ben is away. Cards revealed. Suggested 8. Agreement 50%.",
    );
    const back = run(":server", { type: "presence", who: "ben", connected: true });
    expect(said(liveEvents(back.room, back.causes, away.room))).toBe("Ben is back.");
    const left = run("ben", { type: "leave" });
    expect(said(liveEvents(left.room, left.causes, back.room))).toBe("Ben left.");
    const kicked = run("me", { type: "kick", who: "ana" });
    expect(said(liveEvents(kicked.room, kicked.causes, left.room))).toBe("Ana left.");
  });

  it("says a new round started, to everyone, before the rest of its batch", () => {
    const { run } = story("ana");
    run("me", { type: "join", name: "Me", role: "voter" });
    const lobby = run("ana", { type: "join", name: "Ana", role: "voter" });
    const started = run("me", { type: "startRound", subject: { kind: "none" } });
    const events = liveEvents(started.room, started.causes, lobby.room);
    expect(events).toEqual([{ kind: "roundStarted", who: "", name: "" }]);
    const joined = { kind: "joined" as const, who: "ben", name: "Ben" };
    expect(said(mergeEvents([joined], [...events, ...events]))).toBe("Voting started. Ben joined.");
    const mine = story("me");
    mine.run("me", { type: "join", name: "Me", role: "voter" });
    const own = mine.run("me", { type: "startRound", subject: { kind: "none" } });
    expect(said(liveEvents(own.room, own.causes, null))).toBe("Voting started.");
  });

  it("never says a card, and stays quiet on causes it does not announce", () => {
    const { run } = story("ana");
    run("me", { type: "join", name: "Me", role: "voter" });
    run("ana", { type: "join", name: "Ana", role: "voter" });
    run("me", { type: "startRound", subject: { kind: "none" } });
    const before = run("ana", { type: "castVote", card: "13" });
    const revealed = run("me", { type: "castVote", card: "21" });
    const text = said(liveEvents(revealed.room, revealed.causes, before.room));
    // The last vote revealed the round: the reveal and its result are said (#20), which
    // belong to nobody; whose card is what is never said.
    expect(text).toBe("Me voted. Cards revealed. Suggested 13. Agreement 50%.");
    expect(text).not.toMatch(/21/);
    const final = run("me", { type: "setFinal", card: "13" });
    expect(liveEvents(final.room, final.causes, revealed.room)).toEqual([]);
  });

  it("says the reveal once, to everyone, the PO who forced it too (#19)", () => {
    const { run } = story("me");
    run("me", { type: "join", name: "Me", role: "voter" });
    run("ana", { type: "join", name: "Ana", role: "voter" });
    run("me", { type: "startRound", subject: { kind: "none" } });
    const voted = run("ana", { type: "castVote", card: "13" });
    const forced = run("me", { type: "reveal" });
    const events = liveEvents(forced.room, forced.causes, voted.room);
    expect(events).toEqual([{ kind: "revealed", who: "", name: "", summary: ana13 }]);
    expect(said(mergeEvents(events, events))).toBe("Cards revealed. Suggested 13. Agreement 100%.");
    // A new round in the same batch makes the reveal moot.
    const next = run("me", { type: "startRound", subject: { kind: "none" } });
    const both = mergeEvents(events, liveEvents(next.room, next.causes, forced.room));
    expect(said(both)).toBe("Voting started.");
  });

  it("says the result with the reveal: a consensus, the most voted size, or nothing to count (#20)", () => {
    const round = (settings: Partial<RoomState["settings"]>, cards: string[]) => {
      const { run } = story("me");
      run("me", { type: "join", name: "Me", role: "voter" });
      cards.forEach((_, i) => {
        run(`p${i}`, { type: "join", name: `P${i}`, role: "voter" });
      });
      if (Object.keys(settings).length > 0) run("me", { type: "updateSettings", patch: settings });
      run("me", { type: "startRound", subject: { kind: "none" } });
      let last = run("me", { type: "castVote", card: cards[0] ?? "?" });
      const before = last;
      cards.slice(1).forEach((card, i) => {
        last = run(`p${i}`, { type: "castVote", card });
      });
      const forced = run("me", { type: "reveal" });
      return said(
        liveEvents(forced.room, forced.causes, before.room).filter((e) => e.kind === "revealed"),
      );
    };
    expect(round({}, ["8", "8", "8"])).toBe("Cards revealed. Consensus on 8.");
    expect(round({}, ["?", "☕"])).toBe("Cards revealed. Nothing to count.");
    expect(round({ deck: { kind: "preset", id: "tshirt" } }, ["M", "L", "M", "S"])).toBe(
      "Cards revealed. Most voted M. Agreement 50%.",
    );
  });

  it("says a reveal it missed while away from the server, once, from the phase it shows", () => {
    const { run } = story("ana");
    run("me", { type: "join", name: "Me", role: "voter" });
    run("ana", { type: "join", name: "Ana", role: "voter" });
    run("me", { type: "startRound", subject: { kind: "none" } });
    const voting = run("ana", { type: "castVote", card: "13" });
    const forced = run("me", { type: "reveal" });
    // The snapshot a reconnect brings: no causes, the round now revealed.
    expect(liveEvents(forced.room, [], voting.room)).toEqual([
      { kind: "revealed", who: "", name: "", summary: ana13 },
    ]);
    // With the cause too, still once.
    expect(liveEvents(forced.room, forced.causes, voting.room)).toEqual([
      { kind: "revealed", who: "", name: "", summary: ana13 },
    ]);
    // Already revealed before, a first look, or a later round: nothing to say.
    expect(liveEvents(forced.room, [], forced.room)).toEqual([]);
    expect(liveEvents(forced.room, [], null)).toEqual([]);
    run("me", { type: "startRound", subject: { kind: "none" } });
    const later = run("me", { type: "reveal" });
    expect(liveEvents(later.room, [], voting.room)).toEqual([]);
  });
});

describe("batching", () => {
  const ev = (kind: LiveEvent["kind"], who: string): LiveEvent => ({ kind, who, name: who });

  it("counts a burst and names a single person, in a fixed order", () => {
    const votes = ["Ana", "Ben", "Cleo"].map((who) => ev("voted", who));
    expect(said([...votes, ev("joined", "Dan")])).toBe("Dan joined. 3 people voted.");
    expect(said([ev("left", "Ana"), ev("left", "Ben")])).toBe("2 people left.");
    expect(said([ev("away", "Ana"), ev("away", "Ben"), ev("back", "Cleo")])).toBe(
      "2 people are away. Cleo is back.",
    );
    expect(said([ev("joined", "A"), ev("joined", "B"), ev("back", "C"), ev("back", "D")])).toBe(
      "2 people joined. 2 people are back.",
    );
    expect(said([])).toBe("");
  });

  it("drops repeats and events that undo each other", () => {
    let pending = mergeEvents([], [ev("away", "Ana"), ev("voted", "Ben")]);
    pending = mergeEvents(pending, [ev("voted", "Ben"), ev("back", "Ana")]);
    expect(pending).toEqual([ev("voted", "Ben")]);
    expect(mergeEvents([ev("joined", "Cy")], [ev("left", "Cy")])).toEqual([]);
  });

  it("uses each language's plural rules", async () => {
    await Promise.all([loadLanguage("fr"), loadLanguage("de")]);
    const burst = ["a", "b", "c"].map((who) => ev("voted", who));
    expect(describeEvents(fixedT("fr"), burst)).toBe("3 personnes ont voté.");
    expect(describeEvents(fixedT("de"), burst)).toBe("3 Personen haben abgestimmt.");
    expect(describeEvents(fixedT("de"), [ev("away", "Ana")])).toBe("Ana ist abwesend.");
  });
});

describe("LiveAnnouncer", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useRoomStore.getState().open(CODE);
  });
  afterEach(async () => {
    cleanup();
    vi.useRealTimers();
    useRoomStore.getState().reset();
    await act(() => changeLanguage("en"));
  });

  const region = () => document.querySelector("[data-table-live]");

  it("says one sentence for ten votes in a second, and a name for one", () => {
    const { run } = story();
    run("me", { type: "join", name: "Me", role: "voter" });
    for (let i = 0; i < 10; i++) run(`p${i}`, { type: "join", name: `P${i}`, role: "voter" });
    const start = run("me", { type: "startRound", subject: { kind: "none" } });
    act(() => {
      useRoomStore.getState().receive(start);
    });
    render(<LiveAnnouncer />);
    expect(region()?.getAttribute("role")).toBe("status");
    for (let i = 0; i < 10; i++) {
      const snapshot = run(`p${i}`, { type: "castVote", card: "5" });
      act(() => {
        useRoomStore.getState().receive(snapshot);
        vi.advanceTimersByTime(90);
      });
    }
    expect(region()?.textContent).toBe("");
    act(() => {
      vi.advanceTimersByTime(LIVE_QUIET_MS);
    });
    expect(region()?.textContent).toBe("10 people voted.");
    expect(region()?.textContent).not.toContain("5");
  });

  it("speaks a steady stream at least every so often", () => {
    const { run } = story();
    run("me", { type: "join", name: "Me", role: "voter" });
    act(() => {
      useRoomStore.getState().receive(run("me", { type: "rename", name: "Mo" }));
    });
    render(<LiveAnnouncer />);
    let i = 0;
    const until = LIVE_MAX_WAIT_MS + 100;
    for (let elapsed = 0; elapsed < until; elapsed += 300) {
      const snapshot = run(`p${i}`, { type: "join", name: `P${i}`, role: "voter" });
      i += 1;
      act(() => {
        useRoomStore.getState().receive(snapshot);
        vi.advanceTimersByTime(300);
      });
    }
    expect(region()?.textContent).toMatch(/^\d people joined\.$/);
  });

  it("says the reveal a reconnect brings, though its snapshot has no causes", () => {
    const { run } = story("ana");
    run("me", { type: "join", name: "Me", role: "voter" });
    run("ana", { type: "join", name: "Ana", role: "voter" });
    run("me", { type: "startRound", subject: { kind: "none" } });
    act(() => {
      useRoomStore.getState().receive(run("ana", { type: "castVote", card: "13" }));
    });
    render(<LiveAnnouncer />);
    const revealed = run("me", { type: "reveal" });
    act(() => {
      useRoomStore.getState().receive({ ...revealed, causes: [] });
      vi.advanceTimersByTime(LIVE_QUIET_MS);
    });
    expect(region()?.textContent).toBe("Cards revealed. Suggested 13. Agreement 100%.");
  });

  it("says the same words again as a new announcement", () => {
    const { run } = story();
    run("me", { type: "join", name: "Me", role: "voter" });
    run("ana", { type: "join", name: "Ana", role: "voter" });
    act(() => {
      useRoomStore.getState().receive(run("me", { type: "rename", name: "Mo" }));
    });
    render(<LiveAnnouncer />);
    const first = run(":server", { type: "presence", who: "ana", connected: false });
    act(() => {
      useRoomStore.getState().receive(first);
      vi.advanceTimersByTime(LIVE_QUIET_MS);
    });
    const span = region()?.firstElementChild;
    expect(span?.textContent).toBe("Ana is away.");
    act(() => {
      useRoomStore
        .getState()
        .receive(run(":server", { type: "presence", who: "ana", connected: true }));
      vi.advanceTimersByTime(LIVE_QUIET_MS);
    });
    act(() => {
      useRoomStore
        .getState()
        .receive(run(":server", { type: "presence", who: "ana", connected: false }));
      vi.advanceTimersByTime(LIVE_QUIET_MS);
    });
    expect(region()?.textContent).toBe("Ana is away.");
    expect(region()?.firstElementChild).not.toBe(span);
  });
});
