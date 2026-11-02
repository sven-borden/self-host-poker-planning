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
 *
 * What an account proves was true at sign-in, and only a new sign-in asks the provider again. A
 * session slides, so someone who left would pass for as long as they visit: in a room with a rule
 * a session older than `RULE_SESSION_MAX_AGE_MS` must sign in again. Its PO is exempt, as from
 * every rule, which is why the role asks what the door asks (`mayHoldRole`).
 */
import { domainToASCII, domainToUnicode } from "node:url";
import {
  type AccessIdentity,
  type Command,
  cleanDomain,
  type Restriction,
  type RestrictionRefusal,
  RULE_SESSION_MAX_AGE_DAYS,
  type RuledRoom,
  type RuleProviders,
  restrictionRefusal,
  roomRefusal,
  type UserId,
} from "@pp/domain";
import { eq, inArray, type SQL, sql } from "drizzle-orm";
import type { Config } from "./config.ts";
import { account, session, user } from "./db/auth-schema.ts";
import { guard } from "./db/errors.ts";
import type { Db } from "./db/rooms.ts";

export interface RoomRules {
  providers: RuleProviders;
  /** What each person proves; a guest, or a user who is gone, has no entry. */
  identitiesOf(users: readonly UserId[]): Promise<Map<UserId, AccessIdentity>>;
  /** What one person proves and their newest live session, in one statement. */
  candidateOf(who: UserId): Promise<RoleCandidate>;
}

/** What the role asks of someone (`mayHoldRole`). */
export interface RoleCandidate {
  identity: AccessIdentity | null;
  /**
   * When the session it goes by began: for someone named, the newest live one, and null when none
   * is live. A socket of the tests' stand-in has none to say, which counts as not too old.
   */
  startedAt: number | null | undefined;
}

/** A room sync without a database: no provider, no identity, so a rule admits nobody. */
export const NO_RULES: RoomRules = {
  providers: { google: false, microsoft: false },
  identitiesOf: async () => new Map(),
  candidateOf: async () => ({ identity: null, startedAt: null }),
};

/** How long a sign-in counts in a room with a rule, by `session.created_at`. */
export const RULE_SESSION_MAX_AGE_MS = RULE_SESSION_MAX_AGE_DAYS * 24 * 60 * 60 * 1000;

/** Whether a session that started at `startedAt` (epoch ms) is too old for a room with a rule. */
export const sessionTooOld = (startedAt: number | undefined, now: number): boolean =>
  startedAt !== undefined && now - startedAt > RULE_SESSION_MAX_AGE_MS;

/**
 * Whether `who` may hold the role of this room under its rule. The PO passes every rule and every
 * age, so the role would be a way around them: it asks what the door asks, a sign-in young enough
 * and a live one included. A room with no rule asks nothing. Every way to the role goes by this,
 * and it says yes or no: the reason is not for whoever is asking about someone else.
 */
export function mayHoldRole(
  state: RuledRoom,
  who: UserId,
  { identity, startedAt }: RoleCandidate,
  providers: RuleProviders,
  now: number,
): boolean {
  if (state.settings.restriction === undefined || who === state.ownerId) return true;
  if (startedAt === null || sessionTooOld(startedAt, now)) return false;
  return roomRefusal(state, who, identity, providers) === null;
}

/** A room as a row reads it, for `mayHoldRole`: the rule is null with none. */
export const ruledRoom = (room: { ownerId: UserId; rule: Restriction | null }): RuledRoom => ({
  ownerId: room.ownerId,
  settings: room.rule === null ? {} : { restriction: room.rule },
});

/**
 * What the role asks of someone deleting their account (#51, ADR-029): their account as it stands,
 * and no age. Their sessions ended with their own deletion, which took a sign-in minutes old, so
 * "no live session" says nothing of them here, however long the deletion runs.
 */
export const goingCandidate = async (
  rules: Pick<RoomRules, "identitiesOf">,
  who: UserId,
): Promise<RoleCandidate> => ({
  identity: await identityOf(rules, who),
  startedAt: undefined,
});

export const identityOf = async (
  rules: Pick<RoomRules, "identitiesOf">,
  who: UserId,
): Promise<AccessIdentity | null> => (await rules.identitiesOf([who])).get(who) ?? null;

/** Characters a URL parser ends a host at, or reads as something else: as the panel's guard. */
const NOT_OF_A_HOST = /[/\\@:?#%[\]]/;

/**
 * An entry as the domain's `cleanDomain` reads it: an international name in its `xn--` form, by
 * the platform's IDNA, since the domain has no `URL`. `domainToASCII` is a URL parser: it answers
 * the host of whatever it is given, so `bücher.example/x` reads as `bücher.example`, and it drops
 * or maps characters a name does not hold. So an entry with a character no host holds stays as
 * typed, and one IDNA does not give back whole does too, and `cleanDomain` refuses either: it
 * takes ASCII alone. Plain ASCII never meets the parser at all.
 */
export function asciiDomain(raw: string): string {
  const domain = raw.trim();
  if (!/[^\p{ASCII}]/u.test(domain) || NOT_OF_A_HOST.test(domain)) return domain;
  const ascii = domainToASCII(domain);
  return domainToUnicode(ascii) === domain.normalize("NFC").toLowerCase() ? ascii : domain;
}

/** A patch's rule with its domains in that form, so the domain judges what it can read. */
export function withAsciiDomains(command: Command): Command {
  if (command.type !== "updateSettings") return command;
  const rule = command.patch.restriction;
  if (!rule) return command;
  const domains = rule.domains.map(asciiDomain);
  return { ...command, patch: { ...command.patch, restriction: { ...rule, domains } } };
}

/** The domain of an address its provider verified, as a rule compares it. */
function verifiedDomain(address: string): string | null {
  return cleanDomain(asciiDomain(address.slice(address.lastIndexOf("@") + 1)));
}

/** What `identitiesIn` reads from `user` joined with `account`. */
const IDENTITY = {
  id: user.id,
  isAnonymous: user.isAnonymous,
  email: user.email,
  emailVerified: user.emailVerified,
  provider: account.providerId,
  tenant: account.tenantId,
};

/** When `user`'s newest live session began, by the same check as a socket's (`sessionChecker`). */
const NEWEST_SESSION = sql`(select max(${session.createdAt}) from ${session}
  where ${session.userId} = ${user.id} and ${session.expiresAt} > now())`.mapWith(
  session.createdAt,
) as SQL<Date | null>;

function identitiesIn(
  rows: readonly {
    id: UserId;
    isAnonymous: boolean | null;
    email: string;
    emailVerified: boolean;
    provider: string | null;
    tenant: string | null;
  }[],
): Map<UserId, AccessIdentity> {
  const identities = new Map<UserId, AccessIdentity>();
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
}

export function createRoomRules(db: Db, config: Pick<Config, "socialProviders">): RoomRules {
  return {
    providers: {
      google: config.socialProviders.google !== undefined,
      microsoft: config.socialProviders.microsoft !== undefined,
    },
    identitiesOf: (users) =>
      guard("load identities", async () => {
        if (users.length === 0) return new Map();
        const rows = await db
          .select(IDENTITY)
          .from(user)
          .leftJoin(account, eq(account.userId, user.id))
          .where(inArray(user.id, [...users]));
        return identitiesIn(rows);
      }),
    // One statement: a hand-over, rule or no rule, costs the one read it always did.
    candidateOf: (who) =>
      guard("load a role candidate", async () => {
        const rows = await db
          .select({ ...IDENTITY, started: NEWEST_SESSION })
          .from(user)
          .leftJoin(account, eq(account.userId, user.id))
          .where(eq(user.id, who));
        return {
          identity: identitiesIn(rows).get(who) ?? null,
          startedAt: rows[0]?.started?.getTime() ?? null,
        };
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
  who: Pick<Session, "id" | "startedAt"> | null,
  now: number = Date.now(),
): Promise<RestrictionRefusal | null> {
  if (restriction === null || who?.id === ownerId) return null;
  const identity = who === null ? null : await identityOf(rules, who.id);
  const refused = restrictionRefusal(restriction, identity, rules.providers);
  return refused ?? (sessionTooOld(who?.startedAt, now) ? "session_too_old" : null);
}

/** Who a request came from: the user, and when their session began. */
interface Session {
  id: UserId;
  startedAt: number;
}
