/**
 * What the server and the page share about a tracker's connector (#54, ADR-030): the answers of
 * `/api/connectors/*`, the codes they refuse with, and how a page learns which connectors this
 * install has. No zod: the page's lazy chunk reads these, and a body's schema is the server's.
 *
 * HTTP only: nothing here reaches a socket, and a snapshot says no more than `round.system`.
 */

/** The connectors this version knows. */
export const CONNECTOR_NAMES = ["jira", "azure-devops"] as const;
export type ConnectorName = (typeof CONNECTOR_NAMES)[number];

export function isConnectorName(value: unknown): value is ConnectorName {
  return (CONNECTOR_NAMES as readonly unknown[]).includes(value);
}

/** The `<meta name>` listing the connectors of this install; left out when there are none. */
export const CONNECTOR_META = "pp-connectors";

/** The query parameter a connection comes back to the room with. Read once, then removed. */
export const CONNECTOR_RESULT_PARAM = "connector";

/**
 * How a connection ended: done, the person went back at the tracker, its `state` ran out while
 * the tracker's screen stood open, or anything else.
 */
export const CONNECTOR_RESULTS = ["connected", "cancelled", "expired", "failed"] as const;
export type ConnectorResult = (typeof CONNECTOR_RESULTS)[number];

export function isConnectorResult(value: unknown): value is ConnectorResult {
  return (CONNECTOR_RESULTS as readonly unknown[]).includes(value);
}

/** A JQL query past this is refused before it leaves: a real filter is a line or two. */
export const MAX_JQL_LENGTH = 2000;

/** A WIQL query past this is refused before it leaves. Azure DevOps takes up to 32,000. */
export const MAX_WIQL_LENGTH = 4000;

/** The most a pasted personal access token can be: Microsoft's are 84 characters today. */
export const MAX_PAT_LENGTH = 1024;

/**
 * An Azure DevOps organisation's name, as Microsoft allows it: letters, digits and hyphens, at
 * most 50, and a hyphen at neither end. It goes into `https://dev.azure.com/{organisation}/`, so
 * nothing else may pass: no dot, no slash, no `@`.
 */
export const ADO_ORGANIZATION = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,48}[A-Za-z0-9])?$/;

/** The most a single list of boards or sprints holds. */
export const MAX_BOARDS = 100;

/**
 * Why a connector route said no. Stable, translated by the page with the tracker's name in it
 * (`connector.errors.*`), and never in a socket ack, so `ACK_ERROR_CODES` does not hold them.
 *
 * The first group is about the person's connection or the request, the second is what the
 * tracker answered.
 */
export const CONNECTOR_ERROR_CODES = [
  /** A guest: only an account connects a tracker. */
  "connector_sign_in",
  "connector_not_connected",
  /** Not a name an organisation can have: nothing was asked of the tracker. */
  "connector_bad_organization",
  /** The tracker did not take this token, or it ran out. */
  "connector_bad_token",
  /**
   * This organisation did not let the token in. A stranger's token, a made-up one, an expired one
   * and a wrong scope can all read like this, so the words name them all.
   */
  "connector_no_access",
  /** The token works and lacks the scope the app needs. */
  "connector_scope",
  "connector_no_organization",
  /** The grant is gone: the row went with it, and the person connects again. */
  "connector_reconnect",
  /**
   * A saved token was refused, or a sign-in was asked for: a 401, a 203 and a 3xx cannot be told
   * apart. It may come back after a sign-in at the tracker, so the row stays.
   */
  "connector_token_refused",
  /** The token reads work items and cannot list the organisation's projects: nothing was saved. */
  "connector_no_projects",
  /**
   * The tracker refused a token it had just renewed, so connecting again would change nothing:
   * the app's scopes do not fit what the call asks. The connection stays.
   */
  "connector_setup",
  "connector_no_site",
  "connector_no_field",
  /** Not a site of this person's own list, or a field not of this site's. */
  "connector_bad_site",
  "connector_bad_field",
  /** The item came from another site than the one this person is connected to. */
  "connector_other_site",
  /** The round came from no tracker, or by a paste, so nothing says where it belongs. */
  "connector_no_source",
  "connector_no_final",
  /** `?`, a coffee, a T-shirt size: a final with no number is not written. */
  "connector_not_numeric",
  "connector_rate_limited",
  "connector_forbidden",
  "connector_not_found",
  /** The tracker read the query and refused it. */
  "connector_bad_query",
  /** The tracker refused the field on this item: it is not on the item's screen. */
  "connector_field_refused",
  /** The item's type carries no estimate: a Task, in many process templates. Not a failure. */
  "connector_no_estimate_field",
  /** The query finds more than the tracker will give back at all. */
  "connector_query_cap",
  "connector_unavailable",
  "connector_timeout",
] as const;
export type ConnectorErrorCode = (typeof CONNECTOR_ERROR_CODES)[number];

export function isConnectorErrorCode(value: unknown): value is ConnectorErrorCode {
  return (CONNECTOR_ERROR_CODES as readonly unknown[]).includes(value);
}

/** One site of the person's own list, or a project. Only the id ever comes back from a client. */
export interface ConnectorSiteView {
  readonly id: string;
  readonly name: string;
}

export interface ConnectorFieldView {
  readonly id: string;
  readonly name: string;
}

/** `GET /api/connectors/:name`: no call to the tracker, no token opened. */
export interface ConnectionView {
  readonly connected: boolean;
  /** The organisation a token was given for, where a tracker has one. */
  readonly organization?: string;
  readonly site?: ConnectorSiteView;
  readonly field?: ConnectorFieldView;
}

/** `GET /api/connectors/:name/fields`: the site's number fields, and the one that looks right. */
export interface ConnectorFieldsView {
  readonly fields: readonly ConnectorFieldView[];
  readonly guess?: string;
}

export interface ConnectorBoardView {
  readonly id: number;
  readonly name: string;
}

/** `more`: the list stopped at `MAX_BOARDS`, and a name narrows it. */
export interface ConnectorBoardsView {
  readonly boards: readonly ConnectorBoardView[];
  readonly more: boolean;
}

/** A saved query, by its path. A folder is never one. `more`: the list stopped short. */
export interface ConnectorSavedQueriesView {
  readonly queries: readonly ConnectorSiteView[];
  readonly more: boolean;
}

export interface ConnectorSprintView {
  readonly id: number;
  readonly name: string;
  readonly state: "active" | "future";
}

/**
 * What an import did. `leftOut`: found and not in the queue, because it was full or its items
 * could not be read. `beyond`: how many more the query found past the limit, as the tracker
 * estimates it, or null when it would not say; 0 when nothing lay past it.
 */
export interface ConnectorImportView {
  readonly added: number;
  readonly duplicates: number;
  readonly shortened: number;
  readonly leftOut: number;
  readonly beyond: number | null;
}

/** What a write-back stored, for the line beside the item. */
export interface ConnectorWriteView {
  readonly key: string | null;
  readonly value: number;
}
