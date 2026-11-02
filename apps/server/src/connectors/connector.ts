/**
 * The seam between a tracker and the rest of the server (#54, ADR-030): what `routes.ts` needs of
 * a connector, and nothing it does not. `jira.ts` and `azure-devops.ts` (#55, ADR-031) implement
 * it: the token's life, the import and the write-back are one flow, and what a tracker has beyond
 * that comes as a part of its own: how a token is got, boards and sprints, saved queries, a field
 * that depends on the item. Entra sign-in for Azure DevOps would be `OAuthSignIn` on that connector.
 *
 * Nothing here throws for what a tracker answers: every call comes back as an `Outcome`, whose
 * failure holds a code and how long to wait, never a body, a URL or a query. That is what keeps a
 * token, a JQL and an issue's text out of every log and error.
 */
import type { ConnectorErrorCode } from "@pp/protocol";
import type { z } from "zod";
import type { Connector } from "../db/connector-tokens.ts";
import type { Secret } from "../vault.ts";

/** What a tracker's answer can fail with. */
export type UpstreamCode = Extract<
  ConnectorErrorCode,
  | "connector_reconnect"
  | "connector_bad_token"
  | "connector_no_access"
  | "connector_scope"
  | "connector_no_organization"
  | "connector_setup"
  | "connector_rate_limited"
  | "connector_forbidden"
  | "connector_not_found"
  | "connector_bad_query"
  | "connector_field_refused"
  | "connector_no_estimate_field"
  | "connector_query_cap"
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

/** One place of the person's own at the tracker: a Jira site, an Azure DevOps project. */
export interface Site {
  readonly id: string;
  readonly name: string;
  /** The site's own address, for an item's link. From the tracker, never from a client. */
  readonly url: string;
  /**
   * What an item's `source.site` holds, where that is wider than this site: an Azure DevOps work
   * item's id holds across its organisation, so a write needs that and no project.
   */
  readonly home?: string;
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

/** The same at Azure DevOps: a WIQL query, or a saved one by its id. */
export type AzureQuery = { readonly wiql: string } | { readonly saved: string };

export interface FoundPage {
  readonly items: readonly FoundItem[];
  /** Where the next page starts; absent on the last. */
  readonly next?: string;
  /** Found by the query and not readable, as an item that is gone or hidden from this person. */
  readonly unreadable?: number;
}

export interface BacklogConnector<Q = BacklogQuery> {
  readonly name: Connector;
  /** The name a queue item's `source` carries. */
  readonly system: "jira" | "ado";
  /** What an import's body must be. */
  readonly query: z.ZodType<Q>;
  /** `connector_reconnect` means the provider said the grant is gone. */
  refresh(refreshToken: Secret): Promise<Outcome<Grant>>;
  /**
   * The person's own sites, as the tracker lists them for this token. `home`: the organisation a
   * token was given for, where a token does not say that by itself.
   */
  sites(token: Secret, home?: string): Promise<Outcome<readonly Site[]>>;
  /** `type`: what the fields belong to, where they differ by the item's type. */
  numberFields(token: Secret, site: string, type?: string): Promise<Outcome<readonly Field[]>>;
  /** The field that looks like the estimate, of those listed. */
  guessField(fields: readonly Field[]): string | undefined;
  search(
    token: Secret,
    site: Site,
    query: Q,
    next: string | undefined,
  ): Promise<Outcome<FoundPage>>;
  /** How many items a query finds, as the tracker estimates it. */
  count(token: Secret, site: string, query: Q): Promise<Outcome<number>>;
  /** Writes one number to one field of one item, and nothing else. */
  writeEstimate(
    token: Secret,
    site: string,
    item: string,
    field: string,
    value: number,
  ): Promise<Outcome<void>>;
}

/** A token got by sending the browser to the tracker and back. */
export interface OAuthSignIn {
  /** Where the browser goes to grant access. Holds `state` and no room code. */
  authorizeUrl(state: string, redirectUri: string): string;
  exchangeCode(code: string, redirectUri: string): Promise<Outcome<Grant>>;
}

/** A token a person pastes, for an organisation they name. */
export interface PastedToken {
  /** What an organisation's name must look like, checked before anything leaves. */
  readonly organization: RegExp;
  /** One read that tells a good token from every way of being a bad one. */
  checkToken(organization: string, token: Secret): Promise<Outcome<void>>;
}

export interface SprintBoards {
  boards(
    token: Secret,
    site: string,
    name: string | undefined,
  ): Promise<Outcome<{ boards: readonly Board[]; more: boolean }>>;
  sprints(token: Secret, site: string, board: number): Promise<Outcome<readonly Sprint[]>>;
}

/** A saved query of the person's. */
export interface SavedQuery {
  readonly id: string;
  /** Its path, so two of one name can be told apart. */
  readonly name: string;
}

export interface SavedQueries {
  savedQueries(
    token: Secret,
    site: string,
  ): Promise<Outcome<{ queries: readonly SavedQuery[]; more: boolean }>>;
}

/** An estimate's field that depends on the item, read for each one and not chosen once. */
export interface ItemFields {
  workItemTypes(token: Secret, site: string): Promise<Outcome<readonly string[]>>;
  /** The field to write on `item`, with `chosen` first where its type carries that one. */
  fieldFor(
    token: Secret,
    site: string,
    item: string,
    chosen: string | undefined,
  ): Promise<Outcome<string>>;
}
