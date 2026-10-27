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
    expect(events).toEqual([
      { kind: "roundStarted", who: "", name: "", round: started.room.round },
    ]);
    const joined = { kind: "joined" as const, who: "ben", name: "Ben" };
    expect(said(mergeEvents([joined], [...events, ...events]))).toBe(
      "Voting started: Round 1. Ben joined.",
    );
    const mine = story("me");
    mine.run("me", { type: "join", name: "Me", role: "voter" });
    const own = mine.run("me", { type: "startRound", subject: { kind: "none" } });
    expect(said(liveEvents(own.room, own.causes, null))).toBe("Voting started: Round 1.");
  });

  it("says the new round's subject: its key, its title, or its number (#21)", () => {
    const { run } = story("ana");
    run("me", { type: "join", name: "Me", role: "voter" });
    run("ana", { type: "join", name: "Ana", role: "voter" });
    const subjects: Array<[unknown, string]> = [
      [{ kind: "link", url: "https://acme.atlassian.net/browse/PAY-482" }, "PAY-482"],
      [{ kind: "link", url: "https://dev.azure.com/acme/Pay/_workitems/edit/12345" }, "#12345"],
      [{ kind: "title", text: "Checkout, split invoices" }, "Checkout, split invoices"],
      // A link without a key would read badly aloud: the round's number instead.
      [{ kind: "link", url: "https://example.com/specs/42" }, "Round 4"],
      [{ kind: "none" }, "Round 5"],
    ];
    let batch: LiveEvent[] = [];
    for (const [subject, name] of subjects) {
      const started = run("me", { type: "startRound", subject } as Command);
      const events = liveEvents(started.room, started.causes, null);
      expect(said(events)).toBe(`Voting started: ${name}.`);
      batch = mergeEvents(batch, events);
    }
    // Several new rounds in one batch: the last one is said.
    expect(said(batch)).toBe("Voting started: Round 5.");
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
    // A rename is not news for the live region.
    const quiet = run("me", { type: "rename", name: "Mo" });
    expect(liveEvents(quiet.room, quiet.causes, revealed.room)).toEqual([]);
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
    expect(said(both)).toBe("Voting started: Round 2.");
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

describe("the final estimate and the re-vote (#32)", () => {
  /** Me (the PO) and Ana in a named round on "Login", revealed: Ana 8, me 5. */
  function revealedStory(viewer = "ana") {
    const { run } = story(viewer);
    run("me", { type: "join", name: "Me", role: "voter" });
    run("ana", { type: "join", name: "Ana", role: "voter" });
    run("me", { type: "startRound", subject: { kind: "title", text: "Login" } });
    run("ana", { type: "castVote", card: "8" });
    const revealed = run("me", { type: "castVote", card: "5" });
    return { run, revealed };
  }

  it("says a recorded final, then a changed one, to everyone, the PO too", () => {
    for (const viewer of ["ana", "me"]) {
      const { run, revealed } = revealedStory(viewer);
      const recorded = run("me", { type: "setFinal", card: "8" });
      expect(said(liveEvents(recorded.room, recorded.causes, revealed.room))).toBe(
        "The product owner recorded 8 as the final estimate.",
      );
      const changed = run("me", { type: "setFinal", card: "13" });
      expect(said(liveEvents(changed.room, changed.causes, recorded.room))).toBe(
        "The product owner changed the final estimate to 13.",
      );
    }
  });

  it("says a re-vote as a new vote on the same subject", () => {
    const { run, revealed } = revealedStory();
    const again = run("me", { type: "revote" });
    expect(said(liveEvents(again.room, again.causes, revealed.room))).toBe(
      "The product owner started a new vote on the same subject.",
    );
    // A next round with the same title is a next round.
    const next = run("me", { type: "startRound", subject: { kind: "title", text: "Login" } });
    expect(said(liveEvents(next.room, next.causes, again.room))).toBe("Voting started: Login.");
  });

  it("says that a re-vote is anonymous, as a next round does", () => {
    const { run } = revealedStory();
    const quiet = run("me", { type: "updateSettings", patch: { revealNames: false } });
    const again = run("me", { type: "revote" });
    expect(said(liveEvents(again.room, again.causes, quiet.room))).toBe(
      "The product owner started a new anonymous vote on the same subject.",
    );
  });

  it("says two finals in one batch once, with the later card, and drops one a new round made moot", () => {
    const { run, revealed } = revealedStory();
    const first = run("me", { type: "setFinal", card: "8" });
    const second = run("me", { type: "setFinal", card: "5" });
    const batch = mergeEvents(
      liveEvents(first.room, first.causes, revealed.room),
      liveEvents(second.room, second.causes, first.room),
    );
    expect(said(batch)).toBe("The product owner recorded 5 as the final estimate.");
    const next = run("me", { type: "startRound", subject: { kind: "none" } });
    expect(said(mergeEvents(batch, liveEvents(next.room, next.causes, second.room)))).toBe(
      "Voting started: Round 2.",
    );
  });

  it("says the final in French and German", async () => {
    await loadLanguage("fr");
    await loadLanguage("de");
    const { run, revealed } = revealedStory();
    const recorded = run("me", { type: "setFinal", card: "8" });
    const events = liveEvents(recorded.room, recorded.causes, revealed.room);
    expect(describeEvents(fixedT("fr"), events)).toBe(
      "Le product owner a enregistré 8 comme estimation finale.",
    );
    expect(describeEvents(fixedT("de"), events)).toBe(
      "Der Product Owner hat 8 als endgültige Schätzung festgehalten.",
    );
  });
});

describe("settings (#25)", () => {
  /** Ana's view of a room whose PO ("me") changes settings. */
  function anasRoom() {
    const { run } = story("ana");
    run("me", { type: "join", name: "Me", role: "voter" });
    const seated = run("ana", { type: "join", name: "Ana", role: "voter" });
    return { run, seated };
  }

  it("says each change in plain words to everyone but the PO", () => {
    const { run, seated } = anasRoom();
    const anonymous = run("me", { type: "updateSettings", patch: { revealNames: false } });
    expect(said(liveEvents(anonymous.room, anonymous.causes, seated.room))).toBe(
      "Anonymous voting starts with round 1.",
    );
    const several = run("me", {
      type: "updateSettings",
      patch: { poVotes: false, observersCount: false, revealWhenAllVoted: false },
    });
    expect(said(liveEvents(several.room, several.causes, anonymous.room))).toBe(
      "The cards now wait for a reveal, even once everyone has voted. The product owner no longer votes. Observers no longer take one of the 16 places.",
    );
    const deck = run("me", {
      type: "updateSettings",
      patch: { deck: { kind: "preset", id: "tshirt" }, whoCanReveal: "anyone" },
    });
    expect(said(liveEvents(deck.room, deck.causes, several.room))).toBe(
      "The product owner changed the deck to “T-shirt sizes” from the next round. Anyone who votes can now reveal the cards.",
    );
    const rest = run("me", {
      type: "updateSettings",
      patch: {
        specials: [],
        timer: { seconds: 60 },
        allowChangeAfterReveal: true,
        revealNames: true,
        poVotes: true,
        observersCount: true,
        revealWhenAllVoted: true,
        whoCanReveal: "po",
        deck: { kind: "custom", cards: ["1", "2"] },
      },
    });
    expect(said(liveEvents(rest.room, rest.causes, deck.room))).toBe(
      [
        "The product owner changed the deck to a custom deck from the next round.",
        "The product owner changed the special cards from the next round.",
        "The product owner changed the timer.",
        "The cards now turn over once everyone has voted.",
        "Only the product owner can reveal the cards now.",
        "Voting is named again from round 1.",
        "Votes can now change after the reveal.",
        "The product owner now votes too.",
        "Observers now take one of the 16 places.",
      ].join(" "),
    );
    const back = run("me", { type: "updateSettings", patch: { allowChangeAfterReveal: false } });
    expect(said(liveEvents(back.room, back.causes, rest.room))).toBe(
      "Votes can no longer change after the reveal.",
    );
  });

  it("says nothing to the PO, whose own switch says it", () => {
    const { run } = story("me");
    const seated = run("me", { type: "join", name: "Me", role: "voter" });
    const changed = run("me", { type: "updateSettings", patch: { revealNames: false } });
    expect(liveEvents(changed.room, changed.causes, seated.room)).toEqual([]);
  });

  it("says a restart once, with its deck, and a change a reconnect brings (#26)", () => {
    const { run, seated } = anasRoom();
    const started = run("me", { type: "startRound", subject: { kind: "none" } });
    // Ana's vote; the PO has not voted, so the round is still open.
    const before = run("ana", { type: "castVote", card: "5" });
    const restarted = run("me", {
      type: "updateSettings",
      patch: { deck: { kind: "preset", id: "tshirt" } },
    });
    // The restart, not a new round: no "Voting started", and Ana has a hand to play again.
    expect(said(liveEvents(restarted.room, restarted.causes, before.room))).toBe(
      "The product owner restarted round 1 with “T-shirt sizes”. Vote again.",
    );
    const specials = run("me", { type: "updateSettings", patch: { specials: ["?"] } });
    expect(said(liveEvents(specials.room, specials.causes, restarted.room))).toBe(
      "The product owner restarted round 1 with new special cards. Vote again.",
    );
    // A reconnect's snapshot has no causes; the settings it shows are still news, and the
    // round it missed starting already plays with them.
    expect(said(liveEvents(restarted.room, [], seated.room))).toContain(
      "The product owner changed the deck to “T-shirt sizes”.",
    );
    expect(said(liveEvents(started.room, [], seated.room))).toBe("");
  });

  it("says a restart's fresh timer once, right after the restart (#26, #27)", () => {
    const { run } = anasRoom();
    run("me", { type: "updateSettings", patch: { timer: { seconds: 60 } } });
    run("me", { type: "startRound", subject: { kind: "none" } });
    const before = run("ana", { type: "castVote", card: "5" });
    const restarted = run("me", {
      type: "updateSettings",
      patch: { deck: { kind: "preset", id: "tshirt" } },
    });
    const events = liveEvents(restarted.room, restarted.causes, before.room);
    expect(said(events)).toBe(
      "The product owner restarted round 1 with “T-shirt sizes”. Vote again. Timer started: 1 minute.",
    );
    expect(events.filter((e) => e.kind === "timer")).toHaveLength(1);
    // The PO hears the timer too, as for any start, but not the restart they made.
    const po = story("me");
    po.run("me", { type: "join", name: "Me", role: "voter" });
    po.run("ana", { type: "join", name: "Ana", role: "voter" });
    po.run("me", { type: "updateSettings", patch: { timer: { seconds: 60 } } });
    po.run("me", { type: "startRound", subject: { kind: "none" } });
    const voted = po.run("me", { type: "castVote", card: "5" });
    const again = po.run("me", { type: "updateSettings", patch: { specials: [] } });
    expect(said(liveEvents(again.room, again.causes, voted.room))).toBe("Timer started: 1 minute.");
  });

  it("tells an observer of a restart without asking them to vote (#26)", async () => {
    const { run } = story("obs");
    run("me", { type: "join", name: "Me", role: "voter" });
    run("obs", { type: "join", name: "Oda", role: "observer" });
    run("ana", { type: "join", name: "Ana", role: "voter" });
    run("me", { type: "startRound", subject: { kind: "none" } });
    const voted = run("me", { type: "castVote", card: "3" });
    const restarted = run("me", {
      type: "updateSettings",
      patch: { deck: { kind: "custom", cards: ["🐜", "🐈", "🐘"] } },
    });
    expect(said(liveEvents(restarted.room, restarted.causes, voted.room))).toBe(
      "The product owner restarted round 1 with a custom deck.",
    );
    await loadLanguage("fr");
    await loadLanguage("de");
    const events = liveEvents(restarted.room, restarted.causes, voted.room);
    expect(describeEvents(fixedT("fr"), events)).toBe(
      "Le product owner a relancé le tour 1 avec un jeu personnalisé.",
    );
    expect(describeEvents(fixedT("de"), events)).toBe(
      "Der Product Owner hat Runde 1 mit einem eigenen Kartendeck neu gestartet.",
    );
  });

  it("says a deck change after the reveal applies from the next round (#26)", () => {
    const { run } = anasRoom();
    run("me", { type: "startRound", subject: { kind: "none" } });
    const revealed = run("me", { type: "reveal" });
    const changed = run("me", { type: "updateSettings", patch: { specials: ["?", "☕", "∞"] } });
    expect(said(liveEvents(changed.room, changed.causes, revealed.room))).toBe(
      "The product owner changed the special cards from the next round.",
    );
  });

  it("says the changes in the order they happened, around a new round", () => {
    const { run, seated } = anasRoom();
    const started = run("me", { type: "startRound", subject: { kind: "none" } });
    const anonymous = run("me", { type: "updateSettings", patch: { revealNames: false } });
    const batch = mergeEvents(
      liveEvents(started.room, started.causes, seated.room),
      liveEvents(anonymous.room, anonymous.causes, started.room),
    );
    // Started first, changed within the same batch: said in that order, for round 2.
    expect(said(batch)).toBe("Voting started: Round 1. Anonymous voting starts with round 2.");
    // Votes either side of a change stay either side of it.
    const vote = (who: string): LiveEvent => ({ kind: "voted", who, name: who });
    expect(said([vote("Ben"), ...batch.slice(1), vote("Cleo")])).toBe(
      "Ben voted. Anonymous voting starts with round 2. Cleo voted.",
    );
  });

  it("says that a new round is anonymous", async () => {
    await loadLanguage("fr");
    await loadLanguage("de");
    const { run, seated } = anasRoom();
    run("me", { type: "updateSettings", patch: { revealNames: false } });
    const started = run("me", { type: "startRound", subject: { kind: "none" } });
    const events = liveEvents(started.room, started.causes, seated.room);
    expect(said(events.filter((e) => e.kind === "roundStarted"))).toBe(
      "Voting started: Round 1, anonymous.",
    );
    const roundOnly = events.filter((e) => e.kind === "roundStarted");
    expect(describeEvents(fixedT("fr"), roundOnly)).toBe("Le vote a commencé : Tour 1, anonyme.");
    expect(describeEvents(fixedT("de"), roundOnly)).toBe(
      "Die Abstimmung hat begonnen: Runde 1, anonym.",
    );
  });

  it("says a setting changed twice in a batch once, or not at all when it came back", () => {
    const { run, seated } = anasRoom();
    const on = run("me", { type: "updateSettings", patch: { revealNames: false } });
    const off = run("me", { type: "updateSettings", patch: { revealNames: true } });
    const poOff = run("me", { type: "updateSettings", patch: { poVotes: false } });
    const first = liveEvents(on.room, on.causes, seated.room);
    const cancelled = mergeEvents(first, liveEvents(off.room, off.causes, on.room));
    expect(cancelled).toEqual([]);
    const batch = mergeEvents(
      mergeEvents(first, liveEvents(poOff.room, poOff.causes, off.room)),
      liveEvents(off.room, off.causes, on.room),
    );
    expect(said(batch)).toBe("The product owner no longer votes.");
    expect(said(mergeEvents([], first))).toBe("Anonymous voting starts with round 1.");
  });

  it("speaks French and German", async () => {
    await loadLanguage("fr");
    await loadLanguage("de");
    const { run, seated } = anasRoom();
    const changed = run("me", { type: "updateSettings", patch: { revealNames: false } });
    const events = liveEvents(changed.room, changed.causes, seated.room);
    expect(describeEvents(fixedT("fr"), events)).toBe("Le vote anonyme commence au tour 1.");
    expect(describeEvents(fixedT("de"), events)).toBe("Ab Runde 1 wird anonym abgestimmt.");
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

describe("the timer (#27)", () => {
  /** A room with the PO ("me") and Ana voting, each step at its own time. */
  function timed(viewer: string, settings: Partial<RoomState["settings"]> = {}) {
    let state: RoomState = { ...createRoom({ ownerId: "me" }) };
    state = { ...state, settings: { ...state.settings, ...settings } };
    let version = 1;
    const run = (actor: string, command: Command, now: number) => {
      const result = apply(state, command, { actor, now });
      if (!result.ok) throw new Error(result.error);
      state = result.state;
      version += 1;
      return toSnapshot(state, viewer, { code: CODE, version, now, causes: result.causes });
    };
    run("me", { type: "join", name: "Me", role: "voter" }, 1);
    run("ana", { type: "join", name: "Ana", role: "voter" }, 2);
    return run;
  }

  it.each(["me", "ana"])("says a start, an extension and a stop to everyone (%s)", (viewer) => {
    const run = timed(viewer);
    const started0 = run("me", { type: "startRound", subject: { kind: "none" } }, 1_000);
    const started = run("me", { type: "startTimer", seconds: 60 }, 2_000);
    expect(said(liveEvents(started.room, started.causes, started0.room))).toBe(
      "Timer started: 1 minute.",
    );
    const extended = run("me", { type: "extendTimer", seconds: 30 }, 3_000);
    expect(said(liveEvents(extended.room, extended.causes, started.room))).toBe(
      "30 seconds added.",
    );
    // A reconnect that missed the deadline before: the extension is said without its length.
    expect(said(liveEvents(extended.room, extended.causes, null))).toBe("Time added.");
    const stopped = run("me", { type: "stopTimer" }, 4_000);
    expect(said(liveEvents(stopped.room, stopped.causes, extended.room))).toBe("Timer stopped.");
  });

  it("says the timer a round starts with, after the round", () => {
    const run = timed("ana", { timer: { seconds: 90, revealAtEnd: true } });
    const started = run("me", { type: "startRound", subject: { kind: "none" } }, 1_000);
    expect(said(liveEvents(started.room, started.causes, null))).toBe(
      "Voting started: Round 1. Timer started: 1 minute 30 seconds.",
    );
  });

  it("says time is up, before the reveal when the timer revealed the round", () => {
    const run = timed("ana");
    run("me", { type: "startRound", subject: { kind: "none" } }, 1_000);
    const started = run("me", { type: "startTimer", seconds: 5 }, 2_000);
    const up = run(":server", { type: "timeUp" }, 7_000);
    expect(said(liveEvents(up.room, up.causes, started.room))).toBe(
      "Time is up. Cards revealed. Nothing to count.",
    );
    const waiting = timed("ana", { timer: { seconds: null, revealAtEnd: false } });
    waiting("me", { type: "startRound", subject: { kind: "none" } }, 1_000);
    const before = waiting("me", { type: "startTimer", seconds: 5 }, 2_000);
    const over = waiting(":server", { type: "timeUp" }, 7_000);
    expect(said(liveEvents(over.room, over.causes, before.room))).toBe("Time is up.");
  });

  it("says a start then an extension in one batch as one start, and drops news a new round made moot", () => {
    const start: LiveEvent = {
      kind: "timer",
      who: "",
      name: "",
      timer: { what: "started", seconds: 60 },
    };
    const more: LiveEvent = {
      kind: "timer",
      who: "",
      name: "",
      timer: { what: "extended", seconds: 30 },
    };
    const stop: LiveEvent = { kind: "timer", who: "", name: "", timer: { what: "stopped" } };
    const some: LiveEvent = { kind: "timer", who: "", name: "", timer: { what: "extended" } };
    expect(said(mergeEvents([start], [more]))).toBe("Timer started: 1 minute 30 seconds.");
    expect(said(mergeEvents([{ ...start, timer: { what: "started" } }], [more]))).toBe("");
    expect(said(mergeEvents([start], [stop]))).toBe("Timer stopped.");
    expect(said(mergeEvents([some], [more]))).toBe("30 seconds added.");
    const up: LiveEvent = { kind: "timeUp", who: "", name: "" };
    const round: LiveEvent = {
      kind: "roundStarted",
      who: "",
      name: "",
      round: { number: 2, subject: { kind: "none" }, anonymous: false },
    };
    expect(said(mergeEvents([start, up, up], [round]))).toBe("Voting started: Round 2.");
    expect(said(mergeEvents([up], [up]))).toBe("Time is up.");
  });

  it("speaks French and German", async () => {
    await loadLanguage("fr");
    await loadLanguage("de");
    const events: LiveEvent[] = [
      { kind: "timer", who: "", name: "", timer: { what: "started", seconds: 60 } },
    ];
    expect(describeEvents(fixedT("fr"), events)).toBe("Minuteur lancé\u{202f}: 1 minute.");
    expect(describeEvents(fixedT("de"), events)).toBe("Zeitlimit gestartet: 1 Minute.");
    const up: LiveEvent[] = [{ kind: "timeUp", who: "", name: "" }];
    expect(describeEvents(fixedT("fr"), up)).toBe("Temps écoulé.");
    expect(describeEvents(fixedT("de"), up)).toBe("Die Zeit ist um.");
  });
});
