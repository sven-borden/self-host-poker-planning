/**
 * What the server and the page share about a tracker's connector (#54, ADR-030): the answers of
 * `/api/connectors/*`, the codes they refuse with, and how a page learns which connectors this
 * install has. No zod: the page's lazy chunk reads these, and a body's schema is the server's.
 *
 * HTTP only: nothing here reaches a socket, and a snapshot says no more than `round.system`.
 */

/** The connectors this version knows. */
export const CONNECTOR_NAMES = ["jira"] as const;
export type ConnectorName = (typeof CONNECTOR_NAMES)[number];

export function isConnectorName(value: unknown): value is ConnectorName {
  return (CONNECTOR_NAMES as readonly unknown[]).includes(value);
}

/** The `<meta name>` listing the connectors of this install; left out when there are none. */
export const CONNECTOR_META = "pp-connectors";

/** The query parameter a connection comes back to the room with. Read once, then removed. */
export const CONNECTOR_RESULT_PARAM = "connector";

/** How a connection ended: done, the person went back at the tracker, or anything else. */
export const CONNECTOR_RESULTS = ["connected", "cancelled", "failed"] as const;
export type ConnectorResult = (typeof CONNECTOR_RESULTS)[number];

export function isConnectorResult(value: unknown): value is ConnectorResult {
  return (CONNECTOR_RESULTS as readonly unknown[]).includes(value);
}

/** A JQL query past this is refused before it leaves: a real filter is a line or two. */
export const MAX_JQL_LENGTH = 2000;

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
  /** The grant is gone (`invalid_grant`, or a refused token): the person connects again. */
  "connector_reconnect",
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
  "connector_unavailable",
  "connector_timeout",
] as const;
export type ConnectorErrorCode = (typeof CONNECTOR_ERROR_CODES)[number];

export function isConnectorErrorCode(value: unknown): value is ConnectorErrorCode {
  return (CONNECTOR_ERROR_CODES as readonly unknown[]).includes(value);
}

/** One site of the person's own list. The id is the only thing a client ever sends back. */
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
