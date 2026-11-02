import { describe, expect, it } from "vitest";
import { apply } from "./apply.ts";
import {
  type AccessIdentity,
  cleanDomain,
  cleanRestriction,
  cleanTenant,
  domainOfAddress,
  MICROSOFT_CONSUMER_TENANT,
  requirementOf,
  restrictionRefusal,
  roomRefusal,
} from "./restriction.ts";
import { createRoom, MAX_RESTRICTION_ENTRIES, type Restriction } from "./room.ts";

const TENANT = "11111111-2222-3333-4444-555555555555";
const OTHER_TENANT = "99999999-9999-9999-9999-999999999999";
const BOTH = { google: true, microsoft: true };
const NONE = { google: false, microsoft: false };
const rule = (domains: string[], tenants: string[] = []): Restriction => ({ domains, tenants });
const google = (domain: string | null): AccessIdentity => ({ domain, tenant: null });
const microsoft = (tenant: string | null): AccessIdentity => ({ domain: null, tenant });

describe("cleanDomain", () => {
  it("keeps a domain, lower-cased and trimmed", () => {
    expect(cleanDomain(" Example.COM ")).toBe("example.com");
    expect(cleanDomain("mail.example.co.uk")).toBe("mail.example.co.uk");
    expect(cleanDomain("xn--bcher-kva.example")).toBe("xn--bcher-kva.example");
    expect(cleanDomain("a-b.ch")).toBe("a-b.ch");
  });

  it.each([
    "",
    "localhost",
    "com",
    "@example.com",
    "a@example.com",
    "*.example.com",
    "https://example.com",
    "example.com/path",
    "example.com:443",
    "example.com.",
    ".example.com",
    "exa mple.com",
    "exa%6Dple.com",
    "-example.com",
    "example-.com",
    "exam..ple.com",
    "192.168.1.1",
    "bücher.example",
    `${"a".repeat(64)}.com`,
    `${"a.".repeat(127)}com`,
  ])("refuses %j", (raw) => {
    expect(cleanDomain(raw)).toBeNull();
  });

  it("refuses what is not text", () => {
    expect(cleanDomain(3)).toBeNull();
    expect(cleanDomain(null)).toBeNull();
  });
});

describe("cleanTenant", () => {
  it("keeps a GUID, lower-cased", () => {
    expect(cleanTenant(TENANT.toUpperCase())).toBe(TENANT);
  });

  it("refuses anything else, and the tenant of every personal account", () => {
    expect(cleanTenant("contoso.com")).toBeNull();
    expect(cleanTenant(`{${TENANT}}`)).toBeNull();
    expect(cleanTenant(TENANT.replaceAll("-", ""))).toBeNull();
    expect(cleanTenant(MICROSOFT_CONSUMER_TENANT)).toBeNull();
    expect(cleanTenant(MICROSOFT_CONSUMER_TENANT.toUpperCase())).toBeNull();
    expect(cleanTenant(1)).toBeNull();
  });
});

describe("cleanRestriction", () => {
  it("cleans both lists and drops a repeat", () => {
    expect(
      cleanRestriction({
        domains: ["Example.com", "example.com"],
        tenants: [TENANT.toUpperCase()],
      }),
    ).toEqual({ domains: ["example.com"], tenants: [TENANT] });
  });

  it("holds its limit, per list, before anything is dropped as a repeat", () => {
    const full = Array.from({ length: MAX_RESTRICTION_ENTRIES }, (_, i) => `d${i}.example.com`);
    expect(cleanRestriction({ domains: full, tenants: [] })?.domains).toHaveLength(
      MAX_RESTRICTION_ENTRIES,
    );
    expect(cleanRestriction({ domains: [...full, "x.example.com"], tenants: [] })).toBeNull();
    const repeats = Array.from({ length: MAX_RESTRICTION_ENTRIES + 1 }, () => "example.com");
    expect(cleanRestriction({ domains: repeats, tenants: [] })).toBeNull();
  });

  it("refuses a rule with no entry, a malformed one, or anything more", () => {
    expect(cleanRestriction({ domains: [], tenants: [] })).toBeNull();
    expect(cleanRestriction({ domains: ["example.com", "nope"], tenants: [] })).toBeNull();
    expect(cleanRestriction({ domains: [], tenants: ["nope"] })).toBeNull();
    expect(cleanRestriction({ domains: ["example.com"] })).toBeNull();
    expect(cleanRestriction({ domains: "example.com", tenants: [] })).toBeNull();
    expect(cleanRestriction({ domains: ["example.com"], tenants: [], more: 1 })).toBeNull();
    expect(cleanRestriction(null)).toBeNull();
    expect(cleanRestriction("example.com")).toBeNull();
  });
});

describe("domainOfAddress", () => {
  it("takes what follows the last @", () => {
    expect(domainOfAddress("ada@Example.com")).toBe("example.com");
    expect(domainOfAddress('"a@b"@example.com')).toBe("example.com");
    expect(domainOfAddress("not an address")).toBeNull();
  });
});

describe("restrictionRefusal", () => {
  it("admits a verified domain, exactly", () => {
    const r = rule(["example.com"]);
    expect(restrictionRefusal(r, google("example.com"), BOTH)).toBeNull();
    for (const other of ["notexample.com", "example.com.evil.net", "mail.example.com", "com"]) {
      expect(restrictionRefusal(r, google(other), BOTH)).toBe("account_not_allowed");
    }
  });

  it("admits a tenant whatever its case, and nothing else stands in for it", () => {
    const r = rule([], [TENANT]);
    expect(restrictionRefusal(r, microsoft(TENANT.toUpperCase()), BOTH)).toBeNull();
    expect(restrictionRefusal(r, microsoft(OTHER_TENANT), BOTH)).toBe("account_not_allowed");
    expect(restrictionRefusal(r, google("example.com"), BOTH)).toBe("account_not_allowed");
  });

  it("never lets a Microsoft account meet a domain: its identity holds none", () => {
    const r = rule(["contoso.com"]);
    expect(restrictionRefusal(r, microsoft(TENANT), BOTH)).toBe("account_not_allowed");
  });

  it("admits by either list", () => {
    const r = rule(["example.com"], [TENANT]);
    expect(restrictionRefusal(r, google("example.com"), BOTH)).toBeNull();
    expect(restrictionRefusal(r, microsoft(TENANT), BOTH)).toBeNull();
  });

  it("asks a guest to sign in", () => {
    expect(restrictionRefusal(rule(["example.com"]), null, BOTH)).toBe("sign_in_required");
  });

  it("fails closed once a rule's provider is gone", () => {
    const r = rule(["example.com"], [TENANT]);
    expect(restrictionRefusal(r, google("example.com"), NONE)).toBe("restriction_unavailable");
    expect(restrictionRefusal(r, null, NONE)).toBe("restriction_unavailable");
    // The other list still holds, and the dead one admits nobody.
    const noGoogle = { google: false, microsoft: true };
    expect(restrictionRefusal(r, google("example.com"), noGoogle)).toBe("account_not_allowed");
    expect(restrictionRefusal(r, microsoft(TENANT), noGoogle)).toBeNull();
    const noMicrosoft = { google: true, microsoft: false };
    expect(restrictionRefusal(r, microsoft(TENANT), noMicrosoft)).toBe("account_not_allowed");
    expect(restrictionRefusal(r, google("example.com"), noMicrosoft)).toBeNull();
    expect(restrictionRefusal(rule([], [TENANT]), microsoft(TENANT), noMicrosoft)).toBe(
      "restriction_unavailable",
    );
  });
});

describe("requirementOf", () => {
  it("says what can still work, and never a tenant's id", () => {
    const r = rule(["example.com"], [TENANT]);
    expect(requirementOf(r, BOTH)).toEqual({ domains: ["example.com"], organisation: true });
    expect(requirementOf(r, { google: false, microsoft: true })).toEqual({
      domains: [],
      organisation: true,
    });
    expect(requirementOf(r, { google: true, microsoft: false })).toEqual({
      domains: ["example.com"],
      organisation: false,
    });
    expect(JSON.stringify(requirementOf(r, BOTH))).not.toContain(TENANT);
  });
});

describe("roomRefusal", () => {
  const restricted = () => {
    const state = createRoom({ ownerId: "po" });
    state.settings.restriction = rule(["example.com"]);
    return state;
  };

  it("lets anyone through a room without a rule", () => {
    expect(roomRefusal(createRoom({ ownerId: "po" }), "guest", null, NONE)).toBeNull();
  });

  it("always lets its PO through, even with the provider gone", () => {
    expect(roomRefusal(restricted(), "po", null, NONE)).toBeNull();
  });

  it("does not count a seat", () => {
    const state = restricted();
    state.participants.seated = { name: "Seated", role: "voter", joinedAt: 1, connected: true };
    expect(roomRefusal(state, "seated", null, BOTH)).toBe("sign_in_required");
  });
});

describe("updateSettings with a rule", () => {
  const seated = () => {
    const state = createRoom({ ownerId: "po" });
    state.participants.po = { name: "PO", role: "voter", joinedAt: 1, connected: true };
    state.participants.other = { name: "Other", role: "voter", joinedAt: 2, connected: true };
    return state;
  };
  const set = (restriction: unknown, actor = "po", state = seated()) =>
    apply(state, { type: "updateSettings", patch: { restriction } as never }, { actor, now: 1000 });

  it("stores a rule, cleaned, and says it changed", () => {
    const result = set({ domains: ["Example.com"], tenants: [] });
    expect(result.ok).toBe(true);
    expect(result.state.settings.restriction).toEqual({ domains: ["example.com"], tenants: [] });
    expect(result.causes).toEqual([{ type: "settingsUpdated", restriction: true }]);
  });

  it("is the PO's alone", () => {
    expect(set({ domains: ["example.com"], tenants: [] }, "other")).toMatchObject({
      ok: false,
      error: "not_owner",
    });
  });

  it("refuses a malformed rule, and changes nothing", () => {
    const state = seated();
    const result = set({ domains: ["nope"], tenants: [] }, "po", state);
    expect(result).toMatchObject({ ok: false, error: "bad_restriction" });
    expect(result.state).toBe(state);
  });

  it("removes a rule by null, and null on no rule changes nothing", () => {
    const state = seated();
    state.settings.restriction = rule(["example.com"]);
    const removed = set(null, "po", state);
    expect(removed.state.settings.restriction).toBeUndefined();
    expect(removed.causes).toEqual([{ type: "settingsUpdated", restriction: true }]);
    const none = seated();
    expect(set(null, "po", none).state).toBe(none);
  });

  it("changes nothing when the rule is the one the room has", () => {
    const state = seated();
    state.settings.restriction = rule(["example.com"]);
    expect(set({ domains: ["EXAMPLE.com"], tenants: [] }, "po", state).state).toBe(state);
  });

  it("leaves another setting's cause without the rule's mark, and seats as they are", () => {
    const state = seated();
    state.settings.restriction = rule(["example.com"]);
    const result = apply(
      state,
      { type: "updateSettings", patch: { poVotes: false } },
      { actor: "po", now: 1000 },
    );
    expect(result.causes).toEqual([{ type: "settingsUpdated" }]);
    expect(result.state.settings.restriction).toEqual(rule(["example.com"]));
    expect(Object.keys(set({ domains: ["example.com"], tenants: [] }).state.participants)).toEqual([
      "po",
      "other",
    ]);
  });
});
