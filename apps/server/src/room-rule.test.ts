import { createRoom } from "@pp/domain";
import { describe, expect, it } from "vitest";
import {
  asciiDomain,
  mayHoldRole,
  NO_RULES,
  RULE_SESSION_MAX_AGE_MS,
  refusalOf,
  sessionTooOld,
  withAsciiDomains,
} from "./room-rule.ts";

describe("asciiDomain", () => {
  it("gives an international name its `xn--` form, whatever its case", () => {
    expect(asciiDomain("bücher.example")).toBe("xn--bcher-kva.example");
    expect(asciiDomain(" BÜCHER.example ")).toBe("xn--bcher-kva.example");
    expect(asciiDomain("straße.de")).toBe("xn--strae-oqa.de");
  });

  it("leaves plain ASCII for the domain to judge, without a parser", () => {
    expect(asciiDomain("a@b.com/x")).toBe("a@b.com/x");
    expect(asciiDomain("Example.COM")).toBe("Example.COM");
  });

  it.each([
    "bücher.example/x",
    "example.com/ü",
    "example.com#ü",
    "example.com?ü",
    "example.com\\ü",
    "a@bücher.example",
    "bücher.example:443",
    "[ü]",
    "ü%41.example",
    // IDNA would quietly drop or map these, so what is stored is not what was typed.
    "exam\u00adple.com",
    "bücher\u3002example",
    "ｅxamplü.com",
  ])("hands %s back as typed, for `cleanDomain` to refuse", (entry) => {
    expect(asciiDomain(entry)).toBe(entry);
  });

  it("is what a rule in a command goes through", () => {
    const restriction = { domains: ["bücher.example"], tenants: [] };
    expect(withAsciiDomains({ type: "updateSettings", patch: { restriction } })).toMatchObject({
      patch: { restriction: { domains: ["xn--bcher-kva.example"] } },
    });
  });
});

describe("sessionTooOld", () => {
  const now = 10 * RULE_SESSION_MAX_AGE_MS;

  it("is 30 days, by when the session began", () => {
    expect(RULE_SESSION_MAX_AGE_MS).toBe(2_592_000_000);
    expect(sessionTooOld(now - RULE_SESSION_MAX_AGE_MS, now)).toBe(false);
    expect(sessionTooOld(now - RULE_SESSION_MAX_AGE_MS - 1, now)).toBe(true);
  });

  it("says nothing of a session nobody knows the start of", () => {
    expect(sessionTooOld(undefined, now)).toBe(false);
  });
});

describe("mayHoldRole", () => {
  const providers = { google: true, microsoft: false };
  const open = createRoom({ ownerId: "po" });
  const ruled = createRoom({ ownerId: "po" });
  ruled.settings.restriction = { domains: ["example.com"], tenants: [] };
  const passes = { domain: "example.com", tenant: null };
  const now = 2 * RULE_SESSION_MAX_AGE_MS;

  it("asks what the door asks: the account, then a session young enough and live", () => {
    const hold = (identity: typeof passes | null, startedAt: number | null | undefined) =>
      mayHoldRole(ruled, "a", { identity, startedAt }, providers, now);
    expect(hold(passes, now)).toBe(true);
    expect(hold(passes, now - RULE_SESSION_MAX_AGE_MS)).toBe(true);
    expect(hold(passes, now - RULE_SESSION_MAX_AGE_MS - 1)).toBe(false);
    expect(hold(passes, null)).toBe(false);
    expect(hold(null, now)).toBe(false);
    expect(hold({ domain: "elsewhere.example", tenant: null }, now)).toBe(false);
    expect(hold(passes, undefined)).toBe(true);
  });

  it("asks nothing in a room with no rule, or of its PO", () => {
    const nothing = { identity: null, startedAt: null };
    expect(mayHoldRole(open, "a", nothing, providers, now)).toBe(true);
    expect(mayHoldRole(ruled, "po", nothing, providers, now)).toBe(true);
  });
});

describe("refusalOf", () => {
  const rule = { domains: ["example.com"], tenants: [] };
  const rules = {
    providers: { google: true, microsoft: false },
    identitiesOf: async () => new Map([["a", { domain: "example.com", tenant: null }]]),
    candidateOf: NO_RULES.candidateOf,
  };
  const room = { restriction: rule, ownerId: "po" };
  const now = 2 * RULE_SESSION_MAX_AGE_MS;

  it("lets the PO through, and anyone in a room with no rule", async () => {
    const old = { id: "po", startedAt: 0 };
    await expect(refusalOf(rules, room, old, now)).resolves.toBeNull();
    await expect(
      refusalOf(rules, { restriction: null, ownerId: "po" }, { id: "b", startedAt: 0 }, now),
    ).resolves.toBeNull();
  });

  it("names the account first, the sign-in's age after", async () => {
    await expect(refusalOf(rules, room, { id: "a", startedAt: now }, now)).resolves.toBeNull();
    await expect(refusalOf(rules, room, { id: "a", startedAt: 0 }, now)).resolves.toBe(
      "session_too_old",
    );
    await expect(refusalOf(rules, room, { id: "b", startedAt: 0 }, now)).resolves.toBe(
      "sign_in_required",
    );
    await expect(refusalOf(rules, room, null, now)).resolves.toBe("sign_in_required");
  });

  it("fails closed without a database", async () => {
    await expect(refusalOf(NO_RULES, room, { id: "a", startedAt: now }, now)).resolves.toBe(
      "restriction_unavailable",
    );
  });
});
