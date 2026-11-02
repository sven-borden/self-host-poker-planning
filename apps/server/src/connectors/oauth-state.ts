/**
 * The `state` of a connection under way (#54, ADR-030): random, for one use, ten minutes long and
 * bound to the session that asked. Never a room code: it goes to the tracker.
 *
 * A row of Better Auth's `verification` table, which holds its own sign-ins in progress and whose
 * expired rows the retention job already sweeps, so every instance can finish what another began.
 * The row keeps hashes only: a reader of the database can neither finish a connection nor tell
 * whose it is. `take` is one `delete … returning`, so two callbacks with one `state` get one row.
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { and, eq, gt } from "drizzle-orm";
import { verification } from "../db/auth-schema.ts";
import { guard } from "../db/errors.ts";
import type { Db } from "../db/rooms.ts";

export const STATE_TTL_MS = 10 * 60 * 1000;

const hash = (value: string) => createHash("sha256").update(value).digest("base64url");
const identifierOf = (state: string) => `connector-state:${hash(state)}`;

export interface OAuthStateStore {
  /** A new `state` for this session; `room`: the room to come back to, by its id. */
  issue(sessionId: string, room: string | null): Promise<string>;
  /**
   * Spends `state`: it never works twice, whoever brought it. The room it was issued for, or
   * `null` when it is unknown, expired, or was issued to another session.
   */
  take(state: string, sessionId: string): Promise<{ room: string | null } | null>;
}

interface Stored {
  session: string;
  room: string | null;
}

export function createOAuthStateStore(db: Db, now: () => number = Date.now): OAuthStateStore {
  return {
    issue: async (sessionId, room) => {
      const state = randomBytes(32).toString("base64url");
      const value: Stored = { session: hash(sessionId), room };
      await guard("issue connector state", () =>
        db.insert(verification).values({
          id: randomUUID(),
          identifier: identifierOf(state),
          value: JSON.stringify(value),
          expiresAt: new Date(now() + STATE_TTL_MS),
        }),
      );
      return state;
    },

    take: async (state, sessionId) => {
      const rows = await guard("take connector state", () =>
        db
          .delete(verification)
          .where(
            and(
              eq(verification.identifier, identifierOf(state)),
              gt(verification.expiresAt, new Date(now())),
            ),
          )
          .returning({ value: verification.value }),
      );
      const row = rows[0];
      if (row === undefined) return null;
      const stored = JSON.parse(row.value) as Stored;
      return stored.session === hash(sessionId) ? { room: stored.room } : null;
    },
  };
}
