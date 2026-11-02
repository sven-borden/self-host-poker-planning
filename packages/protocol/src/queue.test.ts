import {
  apply,
  type Command,
  createRoom,
  MAX_QUEUE_ITEMS,
  type QueueEntry,
  queueBytes,
  type RoomState,
} from "@pp/domain";
import { describe, expect, it } from "vitest";
import { toDomainCommand } from "./commands.ts";
import { toSnapshot } from "./project.ts";
import { parseQueueRequest, queueAckSchema, queueList } from "./queue.ts";
import { snapshotSchema } from "./schemas.ts";

const PO = "po";
const META = { code: "abcdefghij", version: 1, now: 5 };

function step(state: RoomState, command: Command, actor = PO, now = 1): RoomState {
  const result = apply(state, command, { actor, now });
  if (!result.ok) throw new Error(result.error);
  return result.state;
}

/** Sixteen people around a voting round, as a snapshot's worst ordinary case. */
function fullTable(): RoomState {
  let state = createRoom({ ownerId: PO });
  state = step(state, { type: "join", name: "Pia Owner", role: "voter" });
  for (let n = 1; n < 16; n++) {
    state = step(state, { type: "join", name: `Person ${n}`, role: "voter" }, `user-${n}`);
  }
  return step(state, { type: "startRound", subject: { kind: "title", text: "A ticket" } });
}

const ticket = (n: number): QueueEntry => ({
  key: `PAY-${n}`,
  title: `Ticket number ${n} with a title of a fair length, as most of them are`,
  url: `https://acme.atlassian.net/browse/PAY-${n}`,
});

const fill = (state: RoomState, count: number) =>
  step(state, {
    type: "queueAdd",
    items: Array.from({ length: count }, (_, n) => ticket(n + 1)),
  });

/** Bytes: these snapshots are plain ASCII. */
const size = (value: unknown) => JSON.stringify(value).length;

describe("a snapshot's queue (ADR-024)", () => {
  it("is absent while the queue is empty: such a room sends what it always sent", () => {
    const state = fullTable();
    expect(toSnapshot(state, PO, META).room).not.toHaveProperty("queue");
    const emptied = step(fill(state, 1), { type: "queueClear" });
    expect(toSnapshot(emptied, PO, META).room).not.toHaveProperty("queue");
  });

  it("is the count, the rev and the next item, named once", () => {
    const { queue } = toSnapshot(fill(fullTable(), 3), "user-1", META).room;
    expect(queue).toEqual({ count: 3, rev: 1, next: { id: 1, key: "PAY-1" } });
  });

  it("names the next item by its title, else its link", () => {
    const base = fullTable();
    const named = (item: QueueEntry) =>
      toSnapshot(step(base, { type: "queueAdd", items: [item] }), PO, META).room.queue?.next;
    expect(named({ title: "Fix" })).toEqual({ id: 1, title: "Fix" });
    expect(named({ url: "https://example.com/x" })).toEqual({
      id: 1,
      url: "https://example.com/x",
    });
  });

  it("stays small in the worst case the rules allow", () => {
    const base = fullTable();
    const snapshot = (item: QueueEntry) =>
      queueBytes([toSnapshot(step(base, { type: "queueAdd", items: [item] }), PO, META)]);
    const without = queueBytes([toSnapshot(base, PO, META)]);
    const title = `${"\u{1100}".repeat(266)}${'"'.repeat(1)}`;
    const link = `https://example.com/${"\u{754C}".repeat(1980)}`;
    expect(snapshot({ title }) - without).toBeLessThan(900);
    expect(snapshot({ url: link }) - without).toBeLessThan(300);
    const next = toSnapshot(step(base, { type: "queueAdd", items: [{ url: link }] }), PO, META);
    expect(next.room.queue?.next.url?.startsWith("https://example.com/")).toBe(true);
    expect(snapshotSchema.safeParse(next).success).toBe(true);
  });

  it("gives everyone the same, the PO included", () => {
    const state = fill(fullTable(), 2);
    expect(toSnapshot(state, "user-1", META).room.queue).toEqual(
      toSnapshot(state, PO, META).room.queue,
    );
  });

  it("costs the same with 500 items as with one, and parses", () => {
    const one = fill(fullTable(), 1);
    const full = fill(fullTable(), MAX_QUEUE_ITEMS);
    const small = size(toSnapshot(one, "user-1", META));
    const large = size(toSnapshot(full, "user-1", META));
    expect(large - small).toBeLessThanOrEqual(2);
    expect(large - size(toSnapshot(fullTable(), "user-1", META))).toBeLessThan(100);
    expect(snapshotSchema.safeParse(toSnapshot(full, "user-1", META)).success).toBe(true);
  });

  it("carries a link's title with the round, and the countdown of a revealed round", () => {
    let state = step(fullTable(), { type: "updateSettings", patch: { autoAdvance: true } });
    state = fill(state, 2);
    state = step(state, { type: "reveal" });
    state = step(state, { type: "setFinal", card: "5" }, PO, 100);
    const { round } = toSnapshot(state, "user-1", META).room;
    expect(round?.phase === "revealed" && round.advanceAt).toBe(10_100);
    const next = step(state, { type: "startNext", id: 1 });
    expect(toSnapshot(next, "user-1", META).room.round?.subject).toEqual({
      kind: "link",
      url: ticket(1).url,
      key: "PAY-1",
      title: ticket(1).title,
    });
  });
});

describe("a round from a tracker (#54)", () => {
  const SOURCE = { system: "jira", site: "cloud-secret-site", id: "issue-secret-id" } as const;
  const imported = () => {
    const filled = step(fullTable(), {
      type: "queueImport",
      items: [{ key: "ABC-1", title: "Login", source: SOURCE }],
    });
    const voting = step(filled, { type: "reveal" });
    return step(voting, { type: "startNext", id: 1 });
  };

  it("tells the PO which tracker, and nobody else, and never where in it", () => {
    const state = imported();
    expect(state.round?.source).toEqual(SOURCE);
    const own = toSnapshot(state, PO, META);
    expect(own.round?.system).toBe("jira");
    expect(snapshotSchema.safeParse(own).success).toBe(true);
    const other = toSnapshot(state, "user-1", META);
    expect(other.round).not.toHaveProperty("system");
    for (const snapshot of [own, other]) {
      expect(JSON.stringify(snapshot)).not.toMatch(/cloud-secret-site|issue-secret-id|source/);
    }
  });

  it("says nothing for a round that came from no tracker", () => {
    expect(toSnapshot(fullTable(), PO, META).round).not.toHaveProperty("system");
  });
});

describe("the queue's list", () => {
  it("names each item field by field, never a connector's source", () => {
    const state = fill(fullTable(), 1);
    const queue = state.queue;
    if (queue === undefined) throw new Error("no queue");
    const item = {
      ...queue.items[0],
      id: 1,
      source: { system: "jira" as const, site: "cloud-1", id: "10042" },
    };
    const list = queueList({ ...queue, items: [item] });
    expect(list).toEqual({ rev: 1, items: [{ id: 1, ...ticket(1) }] });
    expect(queueAckSchema.safeParse({ ok: true, ...list }).success).toBe(true);
    const leaky = { ok: true, rev: 1, items: [item] };
    expect(queueAckSchema.safeParse(leaky).success).toBe(false);
  });

  it("is empty for a room without a queue, and holds a bare item", () => {
    expect(queueList(undefined)).toEqual({ rev: 0, items: [] });
    expect(queueList({ items: [{ id: 2 }], lastId: 2, rev: 3 })).toEqual({
      rev: 3,
      items: [{ id: 2 }],
    });
  });

  it("takes a request with no fields, and nothing else", () => {
    expect(parseQueueRequest(undefined)).toEqual({ ok: true });
    expect(parseQueueRequest({})).toEqual({ ok: true });
    expect(parseQueueRequest({ all: true })).toEqual({ ok: false, code: "bad_payload" });
    expect(parseQueueRequest("x")).toEqual({ ok: false, code: "bad_payload" });
  });
});

describe("the queue's commands on the wire", () => {
  const parse = (type: string, payload?: unknown) => toDomainCommand({ id: "1", type, payload });

  it("parse a batch, a move, a removal and the rest", () => {
    expect(
      parse("queueAdd", { items: [{ key: "AB-1", title: "x", url: "https://a.co" }] }),
    ).toEqual({
      ok: true,
      id: "1",
      command: {
        type: "queueAdd",
        items: [{ key: "AB-1", title: "x", url: "https://a.co" }],
      },
    });
    expect(parse("queueMove", { id: 1, to: 0 }).ok).toBe(true);
    expect(parse("queueRemove", { id: 1 }).ok).toBe(true);
    expect(parse("queueClear").ok).toBe(true);
    expect(parse("startNext", { id: 1 }).ok).toBe(true);
    expect(parse("holdAdvance").ok).toBe(true);
  });

  it("are strict: no id, no source, no unknown field, no batch past the limit", () => {
    const bad: [string, unknown][] = [
      ["queueAdd", { items: [] }],
      ["queueAdd", { items: [{ id: 1, title: "x" }] }],
      ["queueAdd", { items: [{ title: "x", source: { system: "jira", id: "1" } }] }],
      ["queueAdd", { items: [{ title: "x" }], more: true }],
      ["queueAdd", { items: [{ key: "x".repeat(65) }] }],
      ["queueAdd", { items: [{ title: "x".repeat(4097) }] }],
      ["queueAdd", { items: Array.from({ length: 501 }, () => ({ title: "x" })) }],
      ["queueMove", { id: 1 }],
      ["queueMove", { id: 0, to: 0 }],
      ["queueMove", { id: 1, to: -1 }],
      ["queueMove", { id: 1.5, to: 0 }],
      ["queueRemove", { id: "1" }],
      ["startNext", {}],
      ["startNext", { id: 1, subject: { kind: "none" } }],
      ["holdAdvance", { at: 1 }],
    ];
    for (const [type, payload] of bad) {
      expect(parse(type, payload), `${type} ${JSON.stringify(payload)?.slice(0, 80)}`).toEqual({
        ok: false,
        code: "bad_payload",
      });
    }
  });

  it("still refuse a title on a typed link: only a queue item carries one", () => {
    const subject = { kind: "link", url: "https://a.co", title: "x" };
    expect(parse("startRound", { subject })).toEqual({ ok: false, code: "bad_payload" });
  });

  it("take the setting in a patch", () => {
    expect(parse("updateSettings", { patch: { autoAdvance: true } }).ok).toBe(true);
    expect(parse("updateSettings", { patch: { autoAdvance: "on" } }).ok).toBe(false);
  });
});
