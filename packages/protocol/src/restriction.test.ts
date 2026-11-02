/**
 * A room limited to accounts on the wire (#50, ADR-028): the patch's strict parsing, what a
 * snapshot says of the rule to whom, and that nothing about a person can reach a frame.
 */
import { createRoom, MAX_RESTRICTION_ENTRIES, type RoomState } from "@pp/domain";
import { describe, expect, it } from "vitest";
import { toDomainCommand, WIRE_LIMITS } from "./commands.ts";
import { stringLeaves } from "./leak-scan.ts";
import { toSnapshot } from "./project.ts";
import { enterAckSchema, snapshotSchema } from "./schemas.ts";

const TENANT = "11111111-2222-3333-4444-555555555555";

function room(): RoomState {
  const state = createRoom({ ownerId: "po" });
  state.participants.po = { name: "PO", role: "voter", joinedAt: 1, connected: true };
  state.participants.other = { name: "Other", role: "voter", joinedAt: 2, connected: true };
  state.settings.restriction = { domains: ["example.com"], tenants: [TENANT] };
  return state;
}

const view = (state: RoomState, viewer: string) =>
  toSnapshot(state, viewer, { code: "Room234567", version: 1, now: 1 });

describe("the patch on the wire", () => {
  const patch = (restriction: unknown) =>
    toDomainCommand({
      id: "c1",
      type: "updateSettings",
      payload: { patch: { restriction } },
    });

  it("carries a rule, or null to remove it", () => {
    const rule = { domains: ["example.com"], tenants: [TENANT] };
    expect(patch(rule)).toMatchObject({ ok: true, command: { patch: { restriction: rule } } });
    expect(patch(null)).toMatchObject({ ok: true, command: { patch: { restriction: null } } });
  });

  it("leaves the exact rules to the domain, and refuses garbage", () => {
    expect(patch({ domains: ["not a domain"], tenants: [] }).ok).toBe(true);
    expect(patch({ domains: ["example.com"] }).ok).toBe(false);
    expect(patch({ domains: [], tenants: [], more: 1 }).ok).toBe(false);
    expect(patch({ domains: [1], tenants: [] }).ok).toBe(false);
    expect(patch({ domains: ["a".repeat(WIRE_LIMITS.restrictionEntry + 1)], tenants: [] }).ok).toBe(
      false,
    );
    const many = Array.from({ length: WIRE_LIMITS.restrictionEntries + 1 }, () => "example.com");
    expect(patch({ domains: many, tenants: [] }).ok).toBe(false);
    expect(WIRE_LIMITS.restrictionEntries).toBeGreaterThan(MAX_RESTRICTION_ENTRIES);
  });
});

describe("the snapshot", () => {
  it("shows a room without a rule as it always did", () => {
    const snapshot = view(createRoom({ ownerId: "po" }), "po");
    expect(snapshot.room.settings).not.toHaveProperty("restriction");
    expect(snapshotSchema.safeParse(snapshot).success).toBe(true);
  });

  it("gives the PO the rule, to edit", () => {
    const snapshot = view(room(), "po");
    expect(snapshot.room.settings.restriction).toEqual({
      domains: ["example.com"],
      organisation: true,
      tenants: [TENANT],
    });
    expect(snapshotSchema.safeParse(snapshot).success).toBe(true);
  });

  it("gives anyone else the domains and the word for a tenant, never its id", () => {
    const snapshot = view(room(), "other");
    expect(snapshot.room.settings.restriction).toEqual({
      domains: ["example.com"],
      organisation: true,
    });
    expect(JSON.stringify(snapshot)).not.toContain(TENANT);
    expect(snapshotSchema.safeParse(snapshot).success).toBe(true);
  });

  it("says no organisation when the rule names none", () => {
    const state = room();
    state.settings.restriction = { domains: ["example.com"], tenants: [] };
    expect(view(state, "other").room.settings.restriction?.organisation).toBe(false);
  });

  it("holds no address and no tenant of a person: the state has none to give", () => {
    const leaves = stringLeaves(view(room(), "other"));
    expect(leaves.filter(({ value }) => value.includes("@"))).toEqual([]);
  });
});

describe("the refused enter", () => {
  it("may carry what the room asks for", () => {
    const ack = {
      ok: false,
      code: "sign_in_required",
      requirement: { domains: ["example.com"], organisation: true },
    };
    expect(enterAckSchema.parse(ack)).toEqual(ack);
    expect(enterAckSchema.safeParse({ ok: false, code: "password_required" }).success).toBe(true);
  });
});

describe("a stored rule that is no rule", () => {
  it.each([[null], ["example.com"], [{ domains: "example.com", tenants: [] }]])(
    "%j shows the PO an empty rule to take off, and breaks no snapshot",
    (stored) => {
      const state = room();
      (state.settings as { restriction: unknown }).restriction = stored;
      const snapshot = view(state, "po");
      expect(snapshot.room.settings.restriction).toEqual({
        domains: [],
        organisation: false,
        tenants: [],
      });
      expect(snapshotSchema.safeParse(snapshot).success).toBe(true);
    },
  );
});

describe("an old sign-in", () => {
  it("is a refused `enter` that says what would pass, as the rule's other codes are", () => {
    const ack = {
      ok: false,
      code: "session_too_old",
      requirement: { domains: ["example.com"], organisation: false },
    };
    expect(enterAckSchema.safeParse(ack).success).toBe(true);
  });
});
