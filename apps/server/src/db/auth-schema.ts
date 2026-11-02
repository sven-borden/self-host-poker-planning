/**
 * Better Auth's tables (#10), in the shape its Drizzle adapter expects (`provider: "pg"`):
 * `user`, `session`, `account` and `verification`, plus the anonymous plugin's
 * `user.is_anonymous`. drizzle-kit reads this file next to `schema.ts`
 * (`drizzle.config.ts`); the migration `add_better_auth_tables` creates them. The
 * property names are Better Auth's field names; the columns are snake_case.
 *
 * A guest is a `user` row with `is_anonymous = true`, a placeholder email and an empty
 * `name` until the person picks one. A person who signs in with Google or Microsoft (#47)
 * has an `account` row, without the provider's tokens: `auth.ts` clears them before the
 * write. `verification` holds a sign-in in progress. `session.ip_address` and
 * `session.user_agent` exist because the adapter writes them, but `auth.ts` always stores
 * null there: no tracking by default.
 */
import { boolean, index, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

const instant = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

export const user = pgTable("user", {
  id: text("id").primaryKey(),
  /** The display name; "" until the person picks one (#16). Cleaned by the domain's rules. */
  name: text("name").notNull(),
  /**
   * A placeholder for a guest (`…@anonymous…`) and for a Microsoft account
   * (`sha256(tid:oid)@microsoft.invalid`, #48), never shown and never mailed. A Google account's
   * address: shown to its owner only, and in no room's snapshot. Unique, so only an address a
   * provider proves may stand here: see `account.claimed_email`.
   */
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").notNull().default(false),
  image: text("image"),
  createdAt: instant("created_at").notNull().defaultNow(),
  updatedAt: instant("updated_at").notNull().defaultNow(),
  isAnonymous: boolean("is_anonymous").default(false),
  /** The avatar the person picked (#42), one of the domain's ids; null shows initials. */
  avatar: text("avatar"),
});

export const session = pgTable(
  "session",
  {
    id: text("id").primaryKey(),
    expiresAt: instant("expires_at").notNull(),
    /** The session token; the cookie carries it signed. Never log it. */
    token: text("token").notNull().unique(),
    createdAt: instant("created_at").notNull().defaultNow(),
    updatedAt: instant("updated_at").notNull().defaultNow(),
    /** Always null: `auth.ts` drops it before the insert. */
    ipAddress: text("ip_address"),
    /** Always null: `auth.ts` drops it before the insert. */
    userAgent: text("user_agent"),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
  },
  (table) => [index("session_user_id_idx").on(table.userId)],
);

export const account = pgTable(
  "account",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    /** Always null, like the id token and both expiries: `auth.ts` clears them. */
    accessToken: text("access_token"),
    /** Always null: `auth.ts` clears it. */
    refreshToken: text("refresh_token"),
    /** Always null: `auth.ts` clears it. */
    idToken: text("id_token"),
    accessTokenExpiresAt: instant("access_token_expires_at"),
    refreshTokenExpiresAt: instant("refresh_token_expires_at"),
    scope: text("scope"),
    password: text("password"),
    createdAt: instant("created_at").notNull().defaultNow(),
    updatedAt: instant("updated_at").notNull().defaultNow(),
    /** A Microsoft account's tenant (`tid`), for rooms limited to one (#50). */
    tenantId: text("tenant_id"),
    /** A Google account's Workspace domain (`hd`), stored and read by nothing yet (ADR-028). */
    hostedDomain: text("hosted_domain"),
    /**
     * The address a Microsoft token claims (#48, ADR-025): shown to its owner, proof of nothing,
     * and unique in nothing, so a claim cannot lock out the person who owns the address.
     */
    claimedEmail: text("claimed_email"),
  },
  (table) => [
    index("account_user_id_idx").on(table.userId),
    // Every sign-in looks up by these two, and one person at a provider is one account.
    uniqueIndex("account_provider_account_idx").on(table.providerId, table.accountId),
  ],
);

export const verification = pgTable(
  "verification",
  {
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: instant("expires_at").notNull(),
    createdAt: instant("created_at").notNull().defaultNow(),
    updatedAt: instant("updated_at").notNull().defaultNow(),
  },
  (table) => [index("verification_identifier_idx").on(table.identifier)],
);

/** What `drizzleAdapter` gets as `schema`. */
export const authSchema = { user, session, account, verification };
