/**
 * The seam between a tracker and the rest of the server (#54, ADR-030): what `routes.ts` needs of
 * a connector, and nothing it does not. `jira.ts` is the one implementation, and #55 (Azure
 * DevOps) the second: the OAuth dance, the token's life, the import and the write-back are the
 * same flow for both, and only the addresses and the shapes differ.
 *
 * Nothing here throws for what a tracker answers: every call comes back as an `Outcome`, whose
 * failure holds a code and how long to wait, never a body, a URL or a query. That is what keeps a
 * token, a JQL and an issue's text out of every log and error.
 */
import type { ConnectorErrorCode } from "@pp/protocol";
import type { Connector } from "../db/connector-tokens.ts";
import type { Secret } from "../vault.ts";

/** What a tracker's answer can fail with. */
export type UpstreamCode = Extract<
  ConnectorErrorCode,
  | "connector_reconnect"
  | "connector_rate_limited"
  | "connector_forbidden"
  | "connector_not_found"
  | "connector_bad_query"
  | "connector_field_refused"
  | "connector_unavailable"
  | "connector_timeout"
>;

export interface Failure {
  readonly ok: false;
  readonly code: UpstreamCode | "connector_not_connected";
  /** Seconds, from `Retry-After`, with `connector_rate_limited`. */
  readonly retryAfter?: number;
}

export type Outcome<T> = { readonly ok: true; readonly value: T } | Failure;

export const success = <T>(value: T): Outcome<T> => ({ ok: true, value });

/** What a tracker grants: `expiresAt` in epoch milliseconds, on this server's clock. */
export interface Grant {
  readonly accessToken: Secret;
  readonly refreshToken: Secret;
  readonly expiresAt: number;
}

/** One place of the person's own at the tracker: a Jira site. */
export interface Site {
  readonly id: string;
  readonly name: string;
  /** The site's own address, for an item's link. From the tracker, never from a client. */
  readonly url: string;
}

export interface Field {
  readonly id: string;
  readonly name: string;
}

export interface Board {
  readonly id: number;
  readonly name: string;
}

export interface Sprint {
  readonly id: number;
  readonly name: string;
  readonly state: "active" | "future";
}

/** One item a query found, as the tracker holds it. */
export interface FoundItem {
  readonly id: string;
  readonly key: string;
  readonly title: string;
  readonly url: string;
}

/** What an import asks for: a query of the person's, or a sprint they picked. */
export type BacklogQuery = { readonly jql: string } | { readonly sprint: number };

export interface FoundPage {
  readonly items: readonly FoundItem[];
  /** Where the next page starts; absent on the last. */
  readonly next?: string;
}

export interface BacklogConnector {
  readonly name: Connector;
  /** The name a queue item's `source` carries. */
  readonly system: "jira" | "ado";
  /** Where the browser goes to grant access. Holds `state` and no room code. */
  authorizeUrl(state: string, redirectUri: string): string;
  exchangeCode(code: string, redirectUri: string): Promise<Outcome<Grant>>;
  /** `connector_reconnect` means the grant is gone: the provider said `invalid_grant`. */
  refresh(refreshToken: Secret): Promise<Outcome<Grant>>;
  /** The person's own sites, as the tracker lists them for this token. */
  sites(token: Secret): Promise<Outcome<readonly Site[]>>;
  numberFields(token: Secret, site: string): Promise<Outcome<readonly Field[]>>;
  /** The field that looks like the estimate, of those listed. */
  guessField(fields: readonly Field[]): string | undefined;
  boards(
    token: Secret,
    site: string,
    name: string | undefined,
  ): Promise<Outcome<{ boards: readonly Board[]; more: boolean }>>;
  sprints(token: Secret, site: string, board: number): Promise<Outcome<readonly Sprint[]>>;
  search(
    token: Secret,
    site: Site,
    query: BacklogQuery,
    next: string | undefined,
  ): Promise<Outcome<FoundPage>>;
  /** How many items a query finds, as the tracker estimates it. */
  count(token: Secret, site: string, query: BacklogQuery): Promise<Outcome<number>>;
  /** Writes one number to one field of one item, and nothing else. */
  writeEstimate(
    token: Secret,
    site: string,
    item: string,
    field: string,
    value: number,
  ): Promise<Outcome<void>>;
}
