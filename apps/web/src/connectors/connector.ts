import {
  CONNECTOR_META,
  CONNECTOR_RESULT_PARAM,
  type ConnectorName,
  type ConnectorResult,
  isConnectorErrorCode,
  isConnectorName,
  isConnectorResult,
} from "@pp/protocol";
import type { TFunction } from "../i18n/i18n.ts";
import { failureMessage } from "../room/failure.ts";

// What the page knows about a tracker's connector (#54, ADR-030), for the room's own chunk: which
// connectors this install has, from a tag the server puts in `index.html` (none without keys), how
// a connection came back, and what a refusal says. The rest of the UI loads when it is needed.

/** A tracker's name as a person reads it. A brand: the same in every language. */
export const SYSTEM_NAMES: Readonly<Record<ConnectorName, string>> = {
  jira: "Jira",
  "azure-devops": "Azure DevOps",
};

/** What a round's `system` says, for each connector. */
export const ROUND_SYSTEMS = { jira: "jira", "azure-devops": "ado" } as const satisfies Record<
  ConnectorName,
  string
>;

/** The connector a round's `system` belongs to. */
export const connectorOf = (system: "jira" | "ado"): ConnectorName =>
  system === "ado" ? "azure-devops" : "jira";

/** Where Azure DevOps' words differ: a site is a project there, and an organisation is around it. */
const AZURE_MESSAGES = {
  connector_no_site: "connector.azure.errors.connector_no_site",
  connector_bad_site: "connector.azure.errors.connector_bad_site",
  connector_bad_field: "connector.azure.errors.connector_bad_field",
  connector_other_site: "connector.azure.errors.connector_other_site",
  connector_no_source: "connector.azure.errors.connector_no_source",
  connector_field_refused: "connector.azure.errors.connector_field_refused",
} as const;

/** True when this install has the connector. Not the same as this person having connected. */
export function connectorOn(name: ConnectorName): boolean {
  const tag = document.querySelector<HTMLMetaElement>(`meta[name="${CONNECTOR_META}"]`);
  return (tag?.content.split(" ") ?? []).filter(isConnectorName).includes(name);
}

let pending: ConnectorResult | null = null;

/** Takes how a connection ended out of the address, before the router or the page views read it. */
export function readConnectorResult(): void {
  const url = new URL(window.location.href);
  const result = url.searchParams.get(CONNECTOR_RESULT_PARAM);
  if (result === null) return;
  url.searchParams.delete(CONNECTOR_RESULT_PARAM);
  window.history.replaceState(window.history.state, "", url);
  pending = isConnectorResult(result) ? result : "failed";
}

/**
 * How a connection ended, until `clearConnectorResult`. Not taken at the first read: the room's
 * first renders mount and drop the queue's button, and the sheet must still open and say it.
 */
export const connectorResult = (): ConnectorResult | null => pending;

/** The sheet that said it closed. */
export function clearConnectorResult(): void {
  pending = null;
}

/** What a refusal says, with the tracker's name in it, and a wait when the tracker gave one. */
export function connectorMessage(
  t: TFunction,
  code: string,
  name: ConnectorName,
  retryAfter?: number,
): string {
  if (!isConnectorErrorCode(code)) return failureMessage(t, code);
  const system = SYSTEM_NAMES[name];
  if (code === "connector_rate_limited" && retryAfter !== undefined) {
    return t("connector.errors.connector_rate_limited_wait", { system, seconds: retryAfter });
  }
  if (name === "azure-devops" && Object.hasOwn(AZURE_MESSAGES, code)) {
    return t(AZURE_MESSAGES[code as keyof typeof AZURE_MESSAGES]);
  }
  // The key is only known at run time; i18n.test.ts holds every code to a message.
  return (t as (key: string, values: object) => string)(`connector.errors.${code}`, { system });
}
