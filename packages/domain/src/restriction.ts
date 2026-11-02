/**
 * Who may enter a room limited to an email domain or a Microsoft tenant (#50, ADR-028). The rule
 * sits in the room's settings; what is pure about it is here, and the server feeds it what a
 * person's account proves (`AccessIdentity`), which it reads fresh and never takes from a page.
 *
 * A Microsoft address proves nothing: Entra's `email` claim is whatever a tenant's admin set. So
 * a domain is met only by an address its provider verified, today a Google account's, and a
 * tenant only by the id from the token. The two never stand in for each other.
 */
import { MAX_RESTRICTION_ENTRIES, type Restriction, type RoomState, type UserId } from "./room.ts";

/** Every personal Microsoft account carries this tenant: it names no organisation. */
export const MICROSOFT_CONSUMER_TENANT = "9188040d-6c67-4c5b-b112-36a304b66dad";

/**
 * What a person's account proves, as far as a room's rule asks. Null for the whole identity: a
 * guest. `domain`: of an address its provider verified, in the form `cleanDomain` gives.
 * `tenant`: of a Microsoft account. A signed-in person may have neither.
 */
export type AccessIdentity = { domain: string | null; tenant: string | null };

/** The sign-in providers this install has. A rule on one that is gone admits nobody. */
export type RuleProviders = { google: boolean; microsoft: boolean };

/** Why a person does not pass: guest, wrong account, or a rule nobody can meet here. */
export type RestrictionRefusal =
  | "sign_in_required"
  | "account_not_allowed"
  | "restriction_unavailable";

/** What the refused may read: what would pass. "Your organisation", never a tenant's id. */
export type RestrictionRequirement = { domains: string[]; organisation: boolean };

/** Labels of 1 to 63 letters, digits and inner hyphens, at least two, the last not a number. */
const DOMAIN =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * A domain as a rule stores it, lower-cased, or null. Only ASCII: the domain has no `URL`, so an
 * international name reaches it as its `xn--` form, which the server and the panel make. No
 * wildcard, no `@`, no scheme or path, no IP address, no trailing dot and no bare top-level name.
 */
export function cleanDomain(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const domain = raw.trim().toLowerCase();
  return DOMAIN.test(domain) ? domain : null;
}

/** A Microsoft tenant as a rule stores it, a lower-cased GUID, or null. Never the consumer one. */
export function cleanTenant(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const tenant = raw.trim().toLowerCase();
  return GUID.test(tenant) && tenant !== MICROSOFT_CONSUMER_TENANT ? tenant : null;
}

function cleanList(raw: unknown, clean: (entry: unknown) => string | null): string[] | null {
  if (!Array.isArray(raw) || raw.length > MAX_RESTRICTION_ENTRIES) return null;
  const entries = raw.map(clean);
  if (entries.some((entry) => entry === null)) return null;
  return [...new Set(entries as string[])];
}

/** A rule as a room stores it, or null: a malformed entry refuses it all, and so does no entry. */
export function cleanRestriction(raw: unknown): Restriction | null {
  if (typeof raw !== "object" || raw === null) return null;
  const { domains: rawDomains, tenants: rawTenants, ...rest } = raw as Record<string, unknown>;
  if (Object.keys(rest).length > 0) return null;
  const domains = cleanList(rawDomains, cleanDomain);
  const tenants = cleanList(rawTenants, cleanTenant);
  if (!domains || !tenants || domains.length + tenants.length === 0) return null;
  return { domains, tenants };
}

/**
 * What of a rule can still be met on this install. A provider whose keys are gone offers nothing,
 * so what a person is told to do is what can work.
 */
export function requirementOf(rule: Restriction, providers: RuleProviders): RestrictionRequirement {
  return {
    domains: providers.google ? rule.domains : [],
    organisation: providers.microsoft && rule.tenants.length > 0,
  };
}

/**
 * Whether the rule refuses this identity, and why. Domains match exactly: `example.com` admits
 * neither `mail.example.com` nor `example.com.evil.net`. Fails closed: when no provider this rule
 * needs is left, nobody passes, whatever account they hold.
 */
export function restrictionRefusal(
  rule: Restriction,
  identity: AccessIdentity | null,
  providers: RuleProviders,
): RestrictionRefusal | null {
  const { domains, organisation } = requirementOf(rule, providers);
  if (domains.length === 0 && !organisation) return "restriction_unavailable";
  if (identity === null) return "sign_in_required";
  const { domain, tenant } = identity;
  const byDomain = domain !== null && domains.includes(domain);
  const byTenant = organisation && tenant !== null && rule.tenants.includes(tenant.toLowerCase());
  return byDomain || byTenant ? null : "account_not_allowed";
}

/**
 * The room's rule applied to one person, when they enter or join: its PO always passes, so no rule
 * locks its PO out. A seat does not pass (ADR-028): a person seated before the rule stays while
 * their socket does, and meets it when they next enter.
 */
export function roomRefusal(
  state: RoomState,
  who: UserId,
  identity: AccessIdentity | null,
  providers: RuleProviders,
): RestrictionRefusal | null {
  const rule = state.settings.restriction;
  if (rule === undefined || who === state.ownerId) return null;
  return restrictionRefusal(rule, identity, providers);
}
