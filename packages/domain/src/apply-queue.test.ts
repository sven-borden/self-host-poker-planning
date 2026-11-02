import { describe, expect, it } from "vitest";
import { apply } from "./apply.ts";
import {
  cleanQueueItem,
  cutTitle,
  fitToQueue,
  itemSubject,
  queueBytes,
  queueIdentity,
} from "./apply-queue.ts";
import type { Command } from "./commands.ts";
import {
  AUTO_ADVANCE_MS,
  createRoom,
  MAX_ITEM_TITLE_BYTES,
  MAX_LINK_LENGTH,
  MAX_QUEUE_BYTES,
  MAX_QUEUE_ITEMS,
  MAX_TITLE_LENGTH,
  type Participant,
  type QueueEntry,
  type QueueSource,
  type RoomState,
} from "./room.ts";

const T0 = 1_000_000;
const PO = "po";
const ANA = "ana";

function must(state: RoomState, command: Command, actor = PO, now = T0) {
  const result = apply(state, command, { actor, now });
  if (!result.ok) throw new Error(`refused: ${result.error}`);
  return result;
}

function refusal(state: RoomState, command: Command, actor = PO, now = T0) {
  const result = apply(state, command, { actor, now });
  return result.ok ? null : result.error;
}

/** A room with its PO and one voter, in the lobby. */
function room(): RoomState {
  let state = createRoom({ ownerId: PO });
  state = must(state, { type: "join", name: "Po", role: "voter" }).state;
  return must(state, { type: "join", name: "Ana", role: "voter" }, ANA).state;
}

const queued = (state: RoomState, ...keys: string[]) =>
  must(state, { type: "queueAdd", items: keys.map((title) => ({ title })) }).state;

const titles = (state: RoomState) => state.queue?.items.map((item) => item.title);

/** A revealed round on the table. */
function revealed(state: RoomState): RoomState {
  const started = must(state, { type: "startRound", subject: { kind: "none" } }).state;
  return must(started, { type: "reveal" }).state;
}

const auto = (state: RoomState) =>
  must(state, { type: "updateSettings", patch: { autoAdvance: true } }).state;

describe("cleanQueueItem", () => {
  it("keeps a key, a title and a link, and reads a link's own key", () => {
    expect(cleanQueueItem({ key: "ABC-123" })).toEqual({ key: "ABC-123" });
    expect(cleanQueueItem({ key: "1234", title: "  Fix \t the login " })).toEqual({
      key: "1234",
      title: "Fix the login",
    });
    expect(cleanQueueItem({ url: "https://x.atlassian.net/browse/ABC-1" })).toEqual({
      key: "ABC-1",
      url: "https://x.atlassian.net/browse/ABC-1",
    });
    expect(cleanQueueItem({ key: "OTHER-2", url: "https://j.co/browse/ABC-1" })?.key).toBe("ABC-1");
    expect(cleanQueueItem({ key: "OTHER-2", url: "https://example.com/x" })?.key).toBe("OTHER-2");
  });

  it("refuses what a subject refuses, and an item of nothing", () => {
    const refused = [
      null,
      "ABC-1",
      [],
      {},
      { title: "" },
      { title: "   " },
      { title: 5 },
      { title: "x".repeat(MAX_TITLE_LENGTH + 1) },
      { title: "bidi \u{202E}override" },
      { title: "zero\u{200B}width" },
      { title: "a\u{0007}bell" },
      { url: "javascript:alert(1)" },
      { url: "ftp://example.com/x" },
      { url: "https://a.com@b.com/x" },
      { url: `https://example.com/${"x".repeat(MAX_LINK_LENGTH)}` },
      { url: 5 },
      { key: "abc-1" },
      { key: "ABC-0" },
      { key: "#12" },
      { key: 12 },
      { key: "ABC-1 extra" },
      { key: "ABC-1", title: "x".repeat(MAX_TITLE_LENGTH) },
    ];
    for (const raw of refused) expect(cleanQueueItem(raw), JSON.stringify(raw)).toBeNull();
  });
});

describe("a title's bytes", () => {
  it("leaves room for 200 characters of any real text", () => {
    for (const unit of ["a", "\u{00E9}", "\u{754C}", "\u{1F600}"]) {
      const title = unit.repeat(MAX_TITLE_LENGTH);
      expect(cleanQueueItem({ title })).toEqual({ title });
    }
  });

  it("refuses one grapheme of thousands of bytes", () => {
    const jamo = "\u{1100}".repeat(3200);
    expect(cleanQueueItem({ title: jamo })).toBeNull();
    const fits = "\u{1100}".repeat(Math.floor(MAX_ITEM_TITLE_BYTES / 3));
    expect(cleanQueueItem({ title: fits })).toEqual({ title: fits });
  });
});

describe("itemSubject", () => {
  it("makes a link of a link, with its key and title, and a title of anything else", () => {
    expect(itemSubject({ url: "https://a.co/x" })).toEqual({ kind: "link", url: "https://a.co/x" });
    expect(itemSubject({ url: "https://a.co/x", key: "A-1", title: "T" })).toEqual({
      kind: "link",
      url: "https://a.co/x",
      key: "A-1",
      title: "T",
    });
    expect(itemSubject({ key: "AB-1", title: "Fix" })).toEqual({
      kind: "title",
      text: "AB-1 Fix",
    });
    expect(itemSubject({ key: "1234", title: "Fix" })).toEqual({
      kind: "title",
      text: "#1234 Fix",
    });
    expect(itemSubject({ key: "1234" })).toEqual({ kind: "title", text: "#1234" });
    expect(itemSubject({ title: "Fix" })).toEqual({ kind: "title", text: "Fix" });
  });
});

describe("queueIdentity", () => {
  it("is the key, else the link, else the title in any case", () => {
    expect(queueIdentity({ key: "A-1", title: "x", url: "https://a.co" })).toBe("key A-1");
    expect(queueIdentity({ url: "https://a.co", title: "x" })).toBe("url https://a.co");
    expect(queueIdentity({ title: "Fix It" })).toBe(queueIdentity({ title: "fix it" }));
  });
});

describe("the queue's commands", () => {
  it("are the PO's alone", () => {
    const state = queued(room(), "one");
    const commands: Command[] = [
      { type: "queueAdd", items: [{ title: "x" }] },
      { type: "queueMove", id: 1, to: 0 },
      { type: "queueRemove", id: 1 },
      { type: "queueClear" },
      { type: "startNext", id: 1 },
      { type: "holdAdvance" },
    ];
    for (const command of commands) expect(refusal(state, command, ANA)).toBe("not_owner");
  });

  it("add a batch at the end as one change, numbering each item", () => {
    const first = must(room(), { type: "queueAdd", items: [{ title: "a" }, { key: "AB-1" }] });
    expect(first.state.queue).toEqual({
      items: [
        { title: "a", id: 1 },
        { key: "AB-1", id: 2 },
      ],
      lastId: 2,
      rev: 1,
    });
    expect(first.causes).toEqual([{ type: "queueChanged", added: 2 }]);
    const second = must(first.state, { type: "queueAdd", items: [{ title: "b" }] });
    expect(second.state.queue?.items.at(-1)).toEqual({ title: "b", id: 3 });
    expect(second.state.queue?.rev).toBe(2);
  });

  it("never reuse an id, even after an item left", () => {
    let state = queued(room(), "a", "b");
    state = must(state, { type: "queueRemove", id: 2 }).state;
    state = queued(state, "c");
    expect(state.queue?.items.map((item) => item.id)).toEqual([1, 3]);
  });

  it("drop duplicates within a batch and against the queue, and refuse nothing for them", () => {
    let state = queued(room(), "Same");
    const added = must(state, {
      type: "queueAdd",
      items: [{ title: "same" }, { title: "new" }, { title: "NEW" }],
    });
    expect(titles(added.state)).toEqual(["Same", "new"]);
    expect(added.causes).toEqual([{ type: "queueChanged", added: 1 }]);
    state = added.state;
    const nothing = must(state, { type: "queueAdd", items: [{ title: "SAME" }] });
    expect(nothing.state).toBe(state);
    expect(nothing.causes).toEqual([]);
  });

  it("change nothing for an empty batch on a room without a queue", () => {
    const state = room();
    expect(must(state, { type: "queueAdd", items: [] }).state).toBe(state);
  });

  it("refuse a batch with one bad item, whole", () => {
    const state = room();
    const items = [{ title: "fine" }, { url: "javascript:alert(1)" }];
    expect(refusal(state, { type: "queueAdd", items })).toBe("bad_queue_item");
    const notAList = "x" as unknown as [];
    expect(refusal(state, { type: "queueAdd", items: notAList })).toBe("bad_queue_item");
  });

  it("refuse a batch that does not fit, whole, and take exactly what fits", () => {
    const many = (from: number, count: number) =>
      Array.from({ length: count }, (_, n) => ({ title: `t${from + n}` }));
    const state = must(room(), { type: "queueAdd", items: many(0, MAX_QUEUE_ITEMS - 1) }).state;
    expect(refusal(state, { type: "queueAdd", items: many(1000, 2) })).toBe("queue_full");
    const full = must(state, { type: "queueAdd", items: many(1000, 1) }).state;
    expect(full.queue?.items).toHaveLength(MAX_QUEUE_ITEMS);
    expect(refusal(full, { type: "queueAdd", items: many(2000, 1) })).toBe("queue_full");
  });

  it("refuse a batch past the queue's bytes, whole, though it has room in items", () => {
    const wide = (from: number, count: number) =>
      Array.from({ length: count }, (_, n) => ({
        title: `${from + n} ${"\u{754C}".repeat(190)}`,
      }));
    let state = room();
    let next = 0;
    for (; next < MAX_QUEUE_ITEMS; next += 10) {
      const result = apply(
        state,
        { type: "queueAdd", items: wide(next, 10) },
        { actor: PO, now: T0 },
      );
      if (!result.ok) {
        expect(result.error).toBe("queue_full");
        break;
      }
      state = result.state;
    }
    const items = state.queue?.items ?? [];
    expect(items.length).toBeLessThan(MAX_QUEUE_ITEMS);
    expect(queueBytes(items)).toBeLessThanOrEqual(MAX_QUEUE_BYTES);
    expect(queueBytes(items)).toBeGreaterThan(MAX_QUEUE_BYTES - 10 * 700);
  });

  it("move an item to a place, past the end to the end", () => {
    const state = queued(room(), "a", "b", "c");
    const moved = must(state, { type: "queueMove", id: 3, to: 0 });
    expect(titles(moved.state)).toEqual(["c", "a", "b"]);
    expect(moved.state.queue?.rev).toBe(state.queue ? state.queue.rev + 1 : 0);
    expect(moved.causes).toEqual([{ type: "queueChanged" }]);
    expect(titles(must(state, { type: "queueMove", id: 1, to: 99 }).state)).toEqual([
      "b",
      "c",
      "a",
    ]);
    expect(must(state, { type: "queueMove", id: 2, to: 1 }).state).toBe(state);
  });

  it("refuse an unknown item and a place that is not one", () => {
    const state = queued(room(), "a");
    expect(refusal(state, { type: "queueMove", id: 9, to: 0 })).toBe("unknown_item");
    expect(refusal(room(), { type: "queueMove", id: 1, to: 0 })).toBe("unknown_item");
    expect(refusal(state, { type: "queueMove", id: 1, to: -1 })).toBe("bad_command");
    expect(refusal(state, { type: "queueMove", id: 1, to: 0.5 })).toBe("bad_command");
    expect(refusal(state, { type: "queueRemove", id: 9 })).toBe("unknown_item");
    expect(refusal(room(), { type: "queueRemove", id: 1 })).toBe("unknown_item");
    expect(refusal(state, { type: "startNext", id: 9 })).toBe("unknown_item");
    expect(refusal(room(), { type: "startNext", id: 1 })).toBe("unknown_item");
  });

  it("remove one item, and clear them all once", () => {
    const state = queued(room(), "a", "b");
    expect(titles(must(state, { type: "queueRemove", id: 1 }).state)).toEqual(["b"]);
    const cleared = must(state, { type: "queueClear" });
    expect(cleared.state.queue?.items).toEqual([]);
    expect(cleared.state.queue?.lastId).toBe(2);
    expect(must(cleared.state, { type: "queueClear" }).state).toBe(cleared.state);
    expect(must(room(), { type: "queueClear" }).causes).toEqual([]);
  });

  it("leave the room's snapshot of other things alone", () => {
    const state = room();
    const { queue: _, ...rest } = queued(state, "a");
    expect(rest).toEqual(state);
  });
});

describe("startNext", () => {
  it("starts a round on the item, which leaves the queue", () => {
    const state = must(room(), {
      type: "queueAdd",
      items: [{ url: "https://x.atlassian.net/browse/AB-1", title: "Login" }, { key: "AB-2" }],
    }).state;
    const started = must(state, { type: "startNext", id: 1 });
    expect(started.state.round?.subject).toEqual({
      kind: "link",
      url: "https://x.atlassian.net/browse/AB-1",
      key: "AB-1",
      title: "Login",
    });
    expect(started.state.round?.phase).toBe("voting");
    expect(started.state.queue?.items).toEqual([{ key: "AB-2", id: 2 }]);
    expect(started.causes).toEqual([{ type: "roundStarted", number: 1 }]);
  });

  it("reports the round it replaced, for history", () => {
    const state = revealed(queued(room(), "a"));
    const started = must(state, { type: "startNext", id: 1 });
    expect(started.ended).toBe(state.round);
  });

  it("is refused while a round is voting: a double press never takes two items", () => {
    const state = must(queued(room(), "a", "b"), { type: "startNext", id: 1 }).state;
    expect(refusal(state, { type: "startNext", id: 2 })).toBe("not_revealed");
    expect(titles(state)).toEqual(["b"]);
  });

  it("leaves a queue alone when the PO types a subject, and on a re-vote", () => {
    const state = revealed(queued(room(), "a"));
    const typed = must(state, { type: "startRound", subject: { kind: "title", text: "By hand" } });
    expect(titles(typed.state)).toEqual(["a"]);
    const again = must(must(typed.state, { type: "reveal" }).state, { type: "revote" });
    expect(titles(again.state)).toEqual(["a"]);
    expect(again.state.round?.subject).toEqual({ kind: "title", text: "By hand" });
  });
});

describe("auto-advance", () => {
  const finalized = (state: RoomState, card = "5", now = T0) =>
    must(state, { type: "setFinal", card }, PO, now);

  it("is off by default: a final arms nothing", () => {
    const result = finalized(revealed(queued(room(), "a")));
    expect(result.state.round?.advanceAt).toBeUndefined();
    expect(result.causes).toEqual([{ type: "finalSet", card: "5" }]);
  });

  it("arms a countdown on a recorded final while the queue has an item", () => {
    const result = finalized(revealed(queued(auto(room()), "a")));
    expect(result.state.round?.advanceAt).toBe(T0 + AUTO_ADVANCE_MS);
    expect(result.causes).toEqual([{ type: "finalSet", card: "5" }, { type: "advanceArmed" }]);
  });

  it("arms nothing on an empty queue: the room stays as it is", () => {
    const result = finalized(revealed(auto(room())));
    expect(result.state.round?.advanceAt).toBeUndefined();
    const later = must(result.state, { type: "timeUp" }, PO, T0 + 10 * AUTO_ADVANCE_MS);
    expect(later.state).toBe(result.state);
  });

  it("another final starts the countdown again; the same final changes nothing", () => {
    const first = finalized(revealed(queued(auto(room()), "a"))).state;
    const again = finalized(first, "8", T0 + 4000).state;
    expect(again.round?.advanceAt).toBe(T0 + 4000 + AUTO_ADVANCE_MS);
    expect(finalized(again, "8", T0 + 5000).state).toBe(again);
  });

  it("holds a stay for the round: a changed final starts no countdown", () => {
    const state = finalized(revealed(queued(auto(room()), "a", "b"))).state;
    const held = must(state, { type: "holdAdvance" }).state;
    const changed = finalized(held, "8", T0 + 4000);
    expect(changed.state.round?.final).toBe("8");
    expect(changed.state.round?.advanceAt).toBeUndefined();
    expect(changed.causes).toEqual([{ type: "finalSet", card: "8" }]);
    // The next round is a new one: its final counts down again.
    const next = must(changed.state, { type: "startNext", id: 1 }, PO, T0 + 5000).state;
    const again = finalized(must(next, { type: "reveal" }).state, "5", T0 + 6000);
    expect(again.state.round?.advanceAt).toBe(T0 + 6000 + AUTO_ADVANCE_MS);
  });

  it("does not hold for the round when the queue ended it", () => {
    const state = finalized(revealed(queued(auto(room()), "a"))).state;
    const emptied = must(state, { type: "queueRemove", id: 1 }).state;
    const refilled = queued(emptied, "b");
    expect(finalized(refilled, "8", T0 + 4000).state.round?.advanceAt).toBe(
      T0 + 4000 + AUTO_ADVANCE_MS,
    );
  });

  it("ends when the PO leaves, and nothing starts", () => {
    const state = finalized(revealed(queued(auto(room()), "a"))).state;
    const left = must(state, { type: "leave" });
    expect(left.state.round?.advanceAt).toBeUndefined();
    expect(left.causes).toEqual([{ type: "left", who: PO }, { type: "advanceHeld" }]);
    const later = must(left.state, { type: "timeUp" }, ":server", T0 + AUTO_ADVANCE_MS);
    expect(later.state).toBe(left.state);
    expect(titles(later.state)).toEqual(["a"]);
  });

  it("ends when the PO goes away, and goes on when a voter does", () => {
    const state = finalized(revealed(queued(auto(room()), "a"))).state;
    const away = { type: "presence", connected: false } as const;
    const gone = must(state, { ...away, who: PO }, ":server", T0 + 1);
    expect(gone.state.round?.advanceAt).toBeUndefined();
    expect(gone.causes).toEqual([{ type: "away", who: PO }, { type: "advanceHeld" }]);
    const voter = must(state, { ...away, who: ANA }, ":server", T0 + 1);
    expect(voter.state.round?.advanceAt).toBe(T0 + AUTO_ADVANCE_MS);
  });

  it("starts nothing at the deadline on a stored state whose PO is away", () => {
    const state = finalized(revealed(queued(auto(room()), "a"))).state;
    const po = { ...(state.participants[PO] as Participant), awaySince: T0 };
    const stored = { ...state, participants: { ...state.participants, [PO]: po } };
    const result = must(stored, { type: "timeUp" }, ":server", T0 + AUTO_ADVANCE_MS);
    expect(result.state.round?.number).toBe(1);
    expect(result.state.round?.advanceAt).toBeUndefined();
    expect(titles(result.state)).toEqual(["a"]);
  });

  it("is ended by the server when nobody is left, even past its deadline", () => {
    const state = finalized(revealed(queued(auto(room()), "a"))).state;
    const late = T0 + 100 * AUTO_ADVANCE_MS;
    const ended = must(state, { type: "endCountdown" }, ":server", late);
    expect(ended.state.round?.number).toBe(1);
    expect(ended.state.round?.advanceAt).toBeUndefined();
    expect(ended.causes).toEqual([{ type: "advanceHeld" }]);
    expect(titles(ended.state)).toEqual(["a"]);
    // No later enter or ping can resolve it.
    expect(must(ended.state, { type: "timeUp" }, ":server", late + 1).state).toBe(ended.state);
    // Nothing to end: nothing changes.
    expect(must(ended.state, { type: "endCountdown" }, ":server", late + 2).state).toBe(
      ended.state,
    );
  });

  it("starts the next item at the deadline, exactly once, whoever acts first", () => {
    const state = finalized(revealed(queued(auto(room()), "a", "b"))).state;
    const early = must(state, { type: "timeUp" }, ":server", T0 + AUTO_ADVANCE_MS - 1);
    expect(early.state).toBe(state);
    const at = T0 + AUTO_ADVANCE_MS;
    const result = must(state, { type: "timeUp" }, ":server", at);
    expect(result.state.round?.number).toBe(2);
    expect(result.state.round?.phase).toBe("voting");
    expect(result.state.round?.subject).toEqual({ kind: "title", text: "a" });
    expect(result.state.round?.startedAt).toBe(at);
    expect(result.state.round?.advanceAt).toBeUndefined();
    expect(titles(result.state)).toEqual(["b"]);
    expect(result.causes).toEqual([{ type: "roundStarted", number: 2 }]);
    expect(result.ended).toBe(state.round);
    // A second ping finds a voting round: nothing more starts.
    expect(must(result.state, { type: "timeUp" }, ":server", at + 1).state).toBe(result.state);
  });

  it("stands when the command after the deadline is refused, and reports the round it ended", () => {
    const state = finalized(revealed(queued(auto(room()), "a"))).state;
    const result = apply(
      state,
      { type: "setFinal", card: "8" },
      { actor: PO, now: T0 + AUTO_ADVANCE_MS },
    );
    expect(result.ok).toBe(false);
    expect(result.state.round?.number).toBe(2);
    expect(result.ended).toBe(state.round);
  });

  it("starts the room's timer with the round, as any start does", () => {
    const timed = must(queued(auto(room()), "a"), {
      type: "updateSettings",
      patch: { timer: { seconds: 60 } },
    }).state;
    const state = finalized(revealed(timed)).state;
    const at = T0 + AUTO_ADVANCE_MS + 500;
    const { round } = must(state, { type: "timeUp" }, ":server", at).state;
    expect(round?.deadlineAt).toBe(at + 60_000);
  });

  it("stops when the PO stays", () => {
    const state = finalized(revealed(queued(auto(room()), "a"))).state;
    const held = must(state, { type: "holdAdvance" });
    expect(held.state.round?.advanceAt).toBeUndefined();
    expect(held.causes).toEqual([{ type: "advanceHeld" }]);
    expect(must(held.state, { type: "holdAdvance" }).state).toBe(held.state);
    const later = must(held.state, { type: "timeUp" }, ":server", T0 + 10 * AUTO_ADVANCE_MS);
    expect(later.state).toBe(held.state);
  });

  it("stops when the queue empties or the setting goes off", () => {
    const state = finalized(revealed(queued(auto(room()), "a"))).state;
    const removed = must(state, { type: "queueRemove", id: 1 });
    expect(removed.state.round?.advanceAt).toBeUndefined();
    expect(removed.causes).toEqual([{ type: "queueChanged" }, { type: "advanceHeld" }]);
    const off = must(state, { type: "updateSettings", patch: { autoAdvance: false } });
    expect(off.state.round?.advanceAt).toBeUndefined();
    expect(off.causes.at(-1)).toEqual({ type: "advanceHeld" });
  });

  it("goes with the round: by hand, a re-vote or another subject replaces it", () => {
    const state = finalized(revealed(queued(auto(room()), "a", "b"))).state;
    for (const command of [
      { type: "startNext", id: 2 },
      { type: "revote" },
      { type: "startRound", subject: { kind: "none" } },
    ] satisfies Command[]) {
      expect(must(state, command).state.round?.advanceAt).toBeUndefined();
    }
  });

  describe("a start pressed as the countdown ends", () => {
    const typed: Command = {
      type: "startRound",
      subject: { kind: "title", text: "Typed" },
      round: 1,
    };
    const at = T0 + AUTO_ADVANCE_MS;

    it("is refused when it lands first: the item starts, and stays a round", () => {
      const state = finalized(revealed(queued(auto(room()), "a", "b"))).state;
      const result = apply(state, typed, { actor: PO, now: at });
      expect(result).toMatchObject({ ok: false, error: "round_changed" });
      expect(result.state.round?.number).toBe(2);
      expect(result.state.round?.subject).toEqual({ kind: "title", text: "a" });
      expect(titles(result.state)).toEqual(["b"]);
      expect(result.ended).toBe(state.round);
    });

    it("is refused when the server's timeout landed first", () => {
      const state = finalized(revealed(queued(auto(room()), "a", "b"))).state;
      const started = must(state, { type: "timeUp" }, ":server", at).state;
      const result = apply(started, typed, { actor: PO, now: at + 30 });
      expect(result).toMatchObject({ ok: false, error: "round_changed" });
      expect(result.state).toBe(started);
    });

    it("still replaces the round it was pressed for, before the deadline", () => {
      const state = finalized(revealed(queued(auto(room()), "a"))).state;
      const started = must(state, typed, PO, at - 1);
      expect(started.state.round?.subject).toEqual({ kind: "title", text: "Typed" });
      expect(titles(started.state)).toEqual(["a"]);
    });

    it("counts the lobby as round 0", () => {
      const subject = { kind: "none" } as const;
      expect(refusal(room(), { type: "startRound", subject, round: 3 })).toBe("round_changed");
      expect(must(room(), { type: "startRound", subject, round: 0 }).state.round?.number).toBe(1);
    });
  });

  it("ends quietly on a state whose queue went missing", () => {
    const state = finalized(revealed(queued(auto(room()), "a"))).state;
    const { queue: _, ...stale } = state;
    const result = must(stale, { type: "timeUp" }, ":server", T0 + AUTO_ADVANCE_MS);
    expect(result.state.round?.phase).toBe("revealed");
    expect(result.state.round?.advanceAt).toBeUndefined();
    expect(result.causes).toEqual([{ type: "advanceHeld" }]);
  });

  it("tells a room stored before the setting that it is off", () => {
    const state = finalized(revealed(queued(room(), "a"))).state;
    const { autoAdvance: _, ...older } = state.settings;
    const stored = { ...state, settings: older } as RoomState;
    const round = stored.round && { ...stored.round, advanceAt: T0 + 1 };
    const result = must({ ...stored, round }, { type: "queueRemove", id: 1 });
    expect(result.state.round?.advanceAt).toBeUndefined();
  });
});

describe("a connector's import (#54)", () => {
  const SOURCE: QueueSource = { system: "jira", site: "cloud-1", id: "10001" };
  const imported = (key: string, source: unknown = SOURCE) =>
    ({ key, title: `Fix ${key}`, source }) as QueueEntry;

  it("adds items with their source, as a paste adds them", () => {
    const { state, causes } = must(room(), { type: "queueImport", items: [imported("ABC-1")] });
    expect(state.queue?.items).toEqual([
      { id: 1, key: "ABC-1", title: "Fix ABC-1", source: SOURCE },
    ]);
    expect(causes).toEqual([{ type: "queueChanged", added: 1 }]);
  });

  it("is the PO's alone, like every change to the queue", () => {
    expect(refusal(room(), { type: "queueImport", items: [imported("ABC-1")] }, ANA)).toBe(
      "not_owner",
    );
  });

  it("refuses an item without a whole source, and all of the batch with it", () => {
    const bad: unknown[] = [
      null,
      "cloud-1",
      {},
      { system: "gitlab", site: "a", id: "1" },
      { system: "jira", site: "", id: "1" },
      { system: "jira", site: 7, id: "1" },
      { system: "jira", site: "a", id: "" },
      { system: "jira", site: "a", id: 1 },
      { system: "jira", site: "a b", id: "1" },
    ];
    for (const source of bad) {
      const items = [imported("ABC-1"), imported("ABC-2", source)];
      expect(refusal(room(), { type: "queueImport", items })).toBe("bad_queue_item");
    }
    expect(refusal(room(), { type: "queueImport", items: ["ABC-1"] as never })).toBe(
      "bad_queue_item",
    );
  });

  it("never reads a source from a paste", () => {
    const { state } = must(room(), {
      type: "queueAdd",
      items: [imported("ABC-1")],
    });
    expect(state.queue?.items[0]).toEqual({ id: 1, key: "ABC-1", title: "Fix ABC-1" });
  });

  it("gives the round the item's source, by hand, by countdown and through Vote again", () => {
    const filled = must(room(), {
      type: "queueImport",
      items: [imported("ABC-1"), imported("ABC-2", { ...SOURCE, id: "10002" })],
    }).state;
    const first = must(filled, { type: "startNext", id: 1 }).state;
    expect(first.round?.source).toEqual(SOURCE);
    const shown = must(first, { type: "reveal" }).state;
    const again = must(shown, { type: "revote" });
    expect(again.state.round?.source).toEqual(SOURCE);
    expect(again.ended?.source).toEqual(SOURCE);

    const counting = must(auto(must(again.state, { type: "reveal" }).state), {
      type: "setFinal",
      card: "5",
    }).state;
    const next = must(counting, { type: "timeUp" }, PO, T0 + AUTO_ADVANCE_MS);
    expect(next.state.round?.source).toEqual({ ...SOURCE, id: "10002" });
  });

  it("gives a round on a pasted item or a typed subject no source", () => {
    const pasted = must(queued(room(), "Plain"), { type: "startNext", id: 1 }).state;
    expect(pasted.round).not.toHaveProperty("source");
    const typed = must(room(), { type: "startRound", subject: { kind: "none" } }).state;
    expect(typed.round).not.toHaveProperty("source");
  });

  it("cuts a title with an ellipsis, by code points", () => {
    expect(cutTitle("abcd😀f", 5)).toBe("abcd\u{2026}");
    expect(cutTitle("😀😀😀", 3)).toBe("😀😀\u{2026}");
  });

  it("takes what fits, and counts duplicates and overflow", () => {
    const queue = must(queued(room(), "One"), {
      type: "queueImport",
      items: [imported("ABC-1")],
    }).state.queue;
    expect(fitToQueue(queue, [imported("ABC-1"), imported("ABC-2"), imported("ABC-2")])).toEqual({
      fit: [imported("ABC-2")],
      duplicates: 2,
      overflow: 0,
    });
    expect(fitToQueue(undefined, [{ title: "Alone" }])).toEqual({
      fit: [{ title: "Alone" }],
      duplicates: 0,
      overflow: 0,
    });
  });

  it("stops at the item limit and at the byte limit", () => {
    const many = Array.from({ length: MAX_QUEUE_ITEMS + 3 }, (_, n) => ({ key: `ABC-${n + 1}` }));
    const counted = fitToQueue(undefined, many);
    expect(counted.fit).toHaveLength(MAX_QUEUE_ITEMS);
    expect(counted.overflow).toBe(3);

    const wide = Array.from({ length: MAX_QUEUE_ITEMS }, (_, n) => ({
      title: `${n} ${"€".repeat(190)}`,
      source: SOURCE,
    }));
    const bytes = fitToQueue(undefined, wide);
    expect(bytes.overflow).toBeGreaterThan(0);
    expect(queueBytes(bytes.fit.map((entry, n) => ({ ...entry, id: n + 1 })))).toBeLessThanOrEqual(
      MAX_QUEUE_BYTES,
    );
    const stored = must(room(), { type: "queueAdd", items: [] }).state;
    expect(
      must(stored, {
        type: "queueImport",
        items: bytes.fit.map((entry) => ({ ...entry, source: SOURCE })),
      }).state.queue?.items,
    ).toHaveLength(bytes.fit.length);
  });
});
