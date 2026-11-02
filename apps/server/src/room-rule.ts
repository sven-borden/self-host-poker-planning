/**
 * What a room's rule (#50, ADR-028) needs from the server: which providers this install has, and
 * what a person's account proves, read fresh from `user` and `account` and never taken from a
 * page. The domain's `restrictionRefusal` decides from these.
 *
 * - A domain comes only from an address its provider verified: a Google account with
 *   `email_verified`. A Microsoft account's `user.email` is a placeholder and its
 *   `claimed_email` proves nothing (ADR-025), so neither is read here. A Gmail address is a
 *   Gmail address: `hd` is not kept, and the rule compares the address Google vouched for.
 * - A tenant comes only from `account.tenant_id`, which #47 read from the token and checked.
 *
 * None of this leaves the server but as a yes or a no, and it reaches no log line.
 */
import { domainToASCII } from "node:url";
import {
  type AccessIdentity,
  type Command,
  cleanDomain,
  type Restriction,
  type RestrictionRefusal,
  type RuleProviders,
  restrictionRefusal,
  type UserId,
} from "@pp/domain";
import { eq, inArray } from "drizzle-orm";
import type { Config } from "./config.ts";
import { account, user } from "./db/auth-schema.ts";
import { guard } from "./db/errors.ts";
import type { Db } from "./db/rooms.ts";

export interface RoomRules {
  providers: RuleProviders;
  /** What each person proves; a guest, or a user who is gone, has no entry. */
  identitiesOf(users: readonly UserId[]): Promise<Map<UserId, AccessIdentity>>;
}

/** A room sync without a database: no provider, no identity, so a rule admits nobody. */
export const NO_RULES: RoomRules = {
  providers: { google: false, microsoft: false },
  identitiesOf: async () => new Map(),
};

export const identityOf = async (rules: RoomRules, who: UserId): Promise<AccessIdentity | null> =>
  (await rules.identitiesOf([who])).get(who) ?? null;

/**
 * An entry as the domain's `cleanDomain` reads it: an international name in its `xn--` form, by
 * the platform's IDNA, since the domain has no `URL`. "" for a name IDNA refuses. Plain ASCII is
 * left alone for `cleanDomain`, as `new URL` would quietly turn `a@b.com/x` into `b.com`.
 */
export function asciiDomain(raw: string): string {
  const domain = raw.trim();
  return /[^\p{ASCII}]/u.test(domain) ? domainToASCII(domain) : domain;
}

/** A patch's rule with its domains in that form, so the domain judges what it can read. */
export function withAsciiDomains(command: Command): Command {
  if (command.type !== "updateSettings") return command;
  const rule = command.patch.restriction as Restriction | null | undefined;
  if (!rule) return command;
  const domains = rule.domains.map(asciiDomain);
  return { ...command, patch: { ...command.patch, restriction: { ...rule, domains } } };
}

/** The domain of an address its provider verified, as a rule compares it. */
function verifiedDomain(address: string): string | null {
  return cleanDomain(asciiDomain(address.slice(address.lastIndexOf("@") + 1)));
}

export function createRoomRules(db: Db, config: Pick<Config, "socialProviders">): RoomRules {
  return {
    providers: {
      google: config.socialProviders.google !== undefined,
      microsoft: config.socialProviders.microsoft !== undefined,
    },
    identitiesOf: (users) =>
      guard("load identities", async () => {
        const identities = new Map<UserId, AccessIdentity>();
        if (users.length === 0) return identities;
        const rows = await db
          .select({
            id: user.id,
            isAnonymous: user.isAnonymous,
            email: user.email,
            emailVerified: user.emailVerified,
            provider: account.providerId,
            tenant: account.tenantId,
          })
          .from(user)
          .leftJoin(account, eq(account.userId, user.id))
          .where(inArray(user.id, [...users]));
        for (const row of rows) {
          if (row.isAnonymous) continue;
          const known = identities.get(row.id) ?? { domain: null, tenant: null };
          if (row.provider === "google" && row.emailVerified) {
            known.domain ??= verifiedDomain(row.email);
          }
          if (row.provider === "microsoft") known.tenant ??= row.tenant?.toLowerCase() ?? null;
          identities.set(row.id, known);
        }
        return identities;
      }),
  };
}

/**
 * Whether a rule refuses `who` (null: no session), with the PO let through: for the HTTP routes,
 * which load the rule and the PO beside the room rather than its state.
 */
export async function refusalOf(
  rules: RoomRules,
  { restriction, ownerId }: { restriction: Restriction | null; ownerId: UserId },
  who: UserId | null,
): Promise<RestrictionRefusal | null> {
  if (restriction === null || who === ownerId) return null;
  const identity = who === null ? null : await identityOf(rules, who);
  return restrictionRefusal(restriction, identity, rules.providers);
}
