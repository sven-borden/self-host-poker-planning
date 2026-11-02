import type {
  ConnectionView,
  ConnectorBoardsView,
  ConnectorFieldsView,
  ConnectorImportView,
  ConnectorName,
  ConnectorSavedQueriesView,
  ConnectorSiteView,
  ConnectorSprintView,
  ConnectorWriteView,
} from "@pp/protocol";
import { call, jsonInit, RoomApiError } from "../rooms/api.ts";

// A tracker over HTTP (#54, ADR-030). A token, a query's result and a site's address stay on the
// server: what comes here is names and numbers. An error is a `RoomApiError`, with a code.

const own = (name: ConnectorName) => `/api/connectors/${name}`;
const inRoom = (code: string, name: ConnectorName) =>
  `/api/rooms/${encodeURIComponent(code)}/connectors/${name}`;

/** What the server answers is its own: this page shipped with it. */
const answer = <T>(raw: unknown) => raw as T;

export const fetchConnection = async (name: ConnectorName) =>
  answer<ConnectionView>(await call(own(name)));

export async function startConnection(name: ConnectorName, code: string): Promise<string> {
  const raw = answer<{ url?: unknown }>(
    await call(`${inRoom(code, name)}/connect`, jsonInit("POST", {})),
  );
  if (typeof raw.url !== "string") throw new RoomApiError("internal");
  return raw.url;
}

export async function disconnect(name: ConnectorName): Promise<void> {
  await call(own(name), jsonInit("DELETE"));
}

export async function fetchSites(name: ConnectorName): Promise<readonly ConnectorSiteView[]> {
  return answer<{ sites: readonly ConnectorSiteView[] }>(await call(`${own(name)}/sites`)).sites;
}

export async function chooseSite(name: ConnectorName, id: string): Promise<void> {
  await call(`${own(name)}/site`, jsonInit("PUT", { id }));
}

export const fetchFields = async (name: ConnectorName) =>
  answer<ConnectorFieldsView>(await call(`${own(name)}/fields`));

export async function chooseField(name: ConnectorName, id: string): Promise<void> {
  await call(`${own(name)}/field`, jsonInit("PUT", { id }));
}

export async function fetchBoards(name: ConnectorName, filter: string) {
  const query = filter === "" ? "" : `?name=${encodeURIComponent(filter)}`;
  return answer<ConnectorBoardsView>(await call(`${own(name)}/boards${query}`));
}

export async function fetchSprints(
  name: ConnectorName,
  board: number,
): Promise<readonly ConnectorSprintView[]> {
  return answer<{ sprints: readonly ConnectorSprintView[] }>(
    await call(`${own(name)}/boards/${board}/sprints`),
  ).sprints;
}

/** The one place a token leaves this page: in a body, to this server, once. */
export async function connectAzure(organization: string, token: string): Promise<void> {
  await call(`${own("azure-devops")}/connect`, jsonInit("POST", { organization, token }));
}

export async function fetchTypes(name: ConnectorName): Promise<readonly string[]> {
  return answer<{ types: readonly string[] }>(await call(`${own(name)}/types`)).types;
}

export const fetchTypeFields = async (name: ConnectorName, type: string) =>
  answer<ConnectorFieldsView>(await call(`${own(name)}/fields?type=${encodeURIComponent(type)}`));

export async function chooseTypedField(
  name: ConnectorName,
  id: string,
  type: string,
): Promise<void> {
  await call(`${own(name)}/field`, jsonInit("PUT", { id, type }));
}

export async function clearField(name: ConnectorName): Promise<void> {
  await call(`${own(name)}/field`, jsonInit("DELETE"));
}

export const fetchSavedQueries = async (name: ConnectorName) =>
  answer<ConnectorSavedQueriesView>(await call(`${own(name)}/queries`));

export const importItems = async (
  name: ConnectorName,
  code: string,
  query: { jql: string } | { sprint: number } | { wiql: string } | { saved: string },
) =>
  answer<ConnectorImportView>(await call(`${inRoom(code, name)}/import`, jsonInit("POST", query)));

export const writeBack = async (name: ConnectorName, code: string, round: number) =>
  answer<ConnectorWriteView>(
    await call(`${inRoom(code, name)}/write-back`, jsonInit("POST", { round })),
  );
