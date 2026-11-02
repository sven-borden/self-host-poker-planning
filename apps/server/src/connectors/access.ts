/**
 * A person's way to a tracker (#54, ADR-030): the sealed token, refreshed when it runs out.
 *
 * Trackers rotate refresh tokens, and several instances may refresh one person at the same moment.
 * That is normal, so nothing here locks across instances. `replaceToken` is the judge: the first
 * write wins, the others read what it wrote and use that. Atlassian takes a refresh token again
 * for ten minutes after its use, so a loser usually gets a token of its own, which it drops.
 *
 * `invalid_grant` needs care for the same reason: a refresh that lost a race outside that window
 * is told so though the person's grant is fine. So the row goes only if it is still the state the
 * refused token came from, after a short wait for a winner still on its way (`dropToken`). Anything
 * else (a timeout, a 5xx, a 429) leaves the row alone: a tracker's bad minute costs no connection.
 */

import { z } from "zod";
import type {
  AccountId,
  Connector,
  ConnectorTokenStore,
  TokenVersion,
} from "../db/connector-tokens.ts";
import { Secret } from "../vault.ts";
import { type BacklogConnector, type Grant, type Outcome, success } from "./connector.ts";

/** A token this close to its end is refreshed first: a call must outlive the check. */
export const REFRESH_MARGIN_MS = 60_000;

/** How long a refused refresh waits for another instance's write, before it believes it. */
export const REFUSED_REFRESH_WAIT_MS = 400;

/** Reads of the row in one refresh: a race is lost once, not over and over. */
const REFRESH_TRIES = 4;

/** The sealed value: the two tokens and when the first one ends. */
const sealedSchema = z.object({ a: z.string(), r: z.string(), e: z.number() });

export const sealGrant = (grant: Grant) =>
  new Secret(
    JSON.stringify({
      a: grant.accessToken.reveal(),
      r: grant.refreshToken.reveal(),
      e: grant.expiresAt,
    }),
  );

function openGrant(token: Secret): Grant | null {
  let raw: unknown;
  try {
    raw = JSON.parse(token.reveal());
  } catch {
    return null;
  }
  const parsed = sealedSchema.safeParse(raw);
  if (!parsed.success) return null;
  const { a, r, e } = parsed.data;
  return { accessToken: new Secret(a), refreshToken: new Secret(r), expiresAt: e };
}

export interface ConnectorAccess {
  /**
   * Runs `call` with a live access token of `account`'s, and only theirs. A tracker that refuses
   * the token (401) gets one fresh token and one more try: a token can die before its time.
   */
  withToken<T>(
    account: AccountId,
    call: (token: Secret) => Promise<Outcome<T>>,
  ): Promise<Outcome<T>>;
}

export interface AccessOptions {
  now?: () => number;
  wait?: (ms: number) => Promise<void>;
}

type Row =
  | { readonly state: "live"; readonly grant: Grant; readonly version: TokenVersion }
  | { readonly state: "none" };

const NOT_CONNECTED = { ok: false, code: "connector_not_connected" } as const;
const RECONNECT = { ok: false, code: "connector_reconnect" } as const;

export function createConnectorAccess(
  store: ConnectorTokenStore,
  connector: Pick<BacklogConnector, "name" | "refresh">,
  {
    now = Date.now,
    wait = (ms) => new Promise((done) => setTimeout(done, ms)),
  }: AccessOptions = {},
): ConnectorAccess {
  const name: Connector = connector.name;
  /** This instance's refreshes under way, so a page of calls makes one. By account. */
  const flying = new Map<AccountId, Promise<Outcome<Secret>>>();

  async function read(account: AccountId): Promise<Row> {
    const row = await store.readToken(account, name);
    if (row.status !== "ok") return { state: "none" };
    const grant = openGrant(row.token);
    return grant === null ? { state: "none" } : { state: "live", grant, version: row.version };
  }

  const fresh = (grant: Grant) => grant.expiresAt - REFRESH_MARGIN_MS > now();

  /**
   * Reads, and refreshes unless the row is fresh. `spent`: the access token a tracker refused,
   * so a row still holding it is refreshed however long it has to live.
   */
  async function refreshed(account: AccountId, spent?: string): Promise<Outcome<Secret>> {
    for (let attempt = 0; attempt < REFRESH_TRIES; attempt++) {
      const row = await read(account);
      if (row.state === "none") return NOT_CONNECTED;
      const { grant, version } = row;
      if (fresh(grant) && grant.accessToken.reveal() !== spent) return success(grant.accessToken);
      const answer = await connector.refresh(grant.refreshToken);
      if (answer.ok) {
        const written = await store.replaceToken(account, name, version, sealGrant(answer.value));
        if (written.status === "replaced") return success(answer.value.accessToken);
        if (written.status === "gone") return NOT_CONNECTED;
        continue;
      }
      if (answer.code !== "connector_reconnect") return answer;
      // Refused. Believed only if nobody wrote since: the winner of a race may be a moment away.
      await wait(REFUSED_REFRESH_WAIT_MS);
      if (await store.dropToken(account, name, version)) return RECONNECT;
    }
    return RECONNECT;
  }

  /** One refresh per account on this instance: those waiting share its answer. */
  function shared(account: AccountId, spent?: string): Promise<Outcome<Secret>> {
    const running = flying.get(account);
    if (running) return running;
    const started = refreshed(account, spent).finally(() => flying.delete(account));
    flying.set(account, started);
    return started;
  }

  return {
    withToken: async (account, call) => {
      const row = await read(account);
      if (row.state === "none") return NOT_CONNECTED;
      const first = fresh(row.grant) ? success(row.grant.accessToken) : await shared(account);
      if (!first.ok) return first;
      const answer = await call(first.value);
      if (answer.ok || answer.code !== "connector_reconnect") return answer;
      const again = await shared(account, first.value.reveal());
      if (!again.ok) return again;
      return call(again.value);
    },
  };
}
