/**
 * A tracker over HTTP (#54, ADR-030), for a signed-in person only, and every call with that
 * person's own token: the account comes from the session here, and from nowhere else. The token of
 * another person in the room, or the keeper's for a PO who claimed the role, is never in reach.
 *
 * Per person, at `/api/connectors/:name`:
 * - `GET …` what the connection points at, with no call to the tracker;
 * - `DELETE …` disconnects, which deletes the row;
 * - `GET …/callback` where the tracker sends the browser back;
 * - `GET …/sites`, `PUT …/site { id }`: the person's own sites, and which one;
 * - `GET …/fields`, `PUT …/field { id }`: the site's number fields, and which one is the estimate;
 * - `GET …/boards?name=`, `GET …/boards/:id/sprints`: what a sprint is picked from.
 *
 * For a tracker where a person pastes a token (Azure DevOps, #55, ADR-031), instead of the callback,
 * the boards and the room's `connect`:
 * - `POST …/connect { organization, token }` tests the token, lists its projects, and seals it;
 * - `GET …/types`, `GET …/fields?type=`, `PUT …/field { id, type }`, `DELETE …/field`: a person's
 *   choice over the field each item's type carries, read from the type;
 * - `GET …/queries`: the saved queries an import can name.
 *
 * For the PO of a room, at `/api/rooms/:code/connectors/:name`:
 * - `POST …/connect` answers `{ url }`, where the page sends the browser;
 * - `POST …/import`, a query as the connector takes one, fills the queue through `apply`;
 * - `POST …/write-back { round }` writes that round's final to the item it estimated.
 *
 * Without the connector's keys or the vault nothing here is registered, and `/api/*` answers 404.
 * A request's answer is `no-store`, an error is `{ code }`, never a sentence, and nothing logged
 * here holds a token, a code, a query, an issue's text or a room's code.
 */
import {
  cardValue,
  cleanQueueItem,
  cutTitle,
  fitToQueue,
  MAX_TITLE_LENGTH,
  type QueueEntry,
} from "@pp/domain";
import {
  CONNECTOR_RESULT_PARAM,
  type ConnectionView,
  type ConnectorFieldsView,
  type ConnectorImportView,
  type ConnectorResult,
  type ConnectorSavedQueriesView,
  type ConnectorWriteView,
  MAX_BOARDS,
  MAX_PAT_LENGTH,
  WIRE_LIMITS,
} from "@pp/protocol";
import type { Context, Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../app.ts";
import { type Auth, sessionOf } from "../auth.ts";
import type { Config } from "../config.ts";
import { type AccountId, accountOf, type ConnectorTokenStore } from "../db/connector-tokens.ts";
import type { HistoryStore, RoomStore, StoredRoom } from "../db/rooms.ts";
import { foreignOrigin, isJsonBody, rateLimited } from "../http.ts";
import type { RateLimiter, RateLimitRule } from "../rate-limit.ts";
import { isRoomCode } from "../room-code.ts";
import type { RoomSync } from "../sync/room-sync.ts";
import { Secret } from "../vault.ts";
import type { ConnectorAccess } from "./access.ts";
import { sealGrant } from "./access.ts";
import {
  type BacklogConnector,
  type BacklogQuery,
  type Failure,
  type FoundItem,
  type FoundPage,
  type ItemFields,
  type OAuthSignIn,
  type Outcome,
  type PastedToken,
  type SavedQueries,
  type Site,
  type SprintBoards,
  success,
} from "./connector.ts";
import type { OAuthStateStore } from "./oauth-state.ts";

/** Reads per person: a sheet opening, and a person typing a board's name. */
export const CONNECTOR_READ_LIMIT = { window: 60, max: 60 } as const;
/** Connections begun, disconnections and changes of site or field, per person. */
export const CONNECTOR_CHANGE_LIMIT = { window: 600, max: 30 } as const;
/** Imports per person: each may take ten calls to the tracker. */
export const CONNECTOR_IMPORT_LIMIT = { window: 60, max: 10 } as const;
/** Write-backs per person: a final a few seconds, and a few pressed twice. */
export const CONNECTOR_WRITE_LIMIT = { window: 60, max: 60 } as const;

/** Pages of a search, whatever it finds: twice what fills an empty queue. */
export const MAX_SEARCH_PAGES = 10;

/** The most anything said it would wait, for a `Retry-After` that is not sensible. */
const MAX_RETRY_AFTER_S = 3600;

/** A pasted token has no end of its own that this server knows: only the tracker's word ends it. */
const NEVER = Number.MAX_SAFE_INTEGER;
/** A token goes into a header: printable, with no space. Anything else was no token. */
const TOKEN_SHAPE = /^[\x21-\x7e]+$/;

const idBody = z.strictObject({ id: z.string().min(1).max(128) });
const typedFieldBody = z.strictObject({
  id: z.string().min(1).max(128),
  type: z.string().min(1).max(128),
});
const connectBody = z.strictObject({
  organization: z.string().min(1).max(128),
  token: z.string().min(1).max(MAX_PAT_LENGTH),
});
const writeBody = z.strictObject({
  round: z.number().int().positive().max(WIRE_LIMITS.roundNumber),
});
const emptyBody = z.strictObject({});

/** What `connector_token.settings` holds: read through this, so an old shape counts as none. */
const settingsSchema = z.object({
  organization: z.string().optional(),
  site: z.object({
    id: z.string(),
    name: z.string(),
    url: z.string(),
    home: z.string().optional(),
  }),
  field: z.object({ id: z.string(), name: z.string() }).optional(),
});
type Settings = z.output<typeof settingsSchema>;

/** A connection before a project is picked holds this alone. */
const organizationSchema = z.object({ organization: z.string() });

const STATUS_OF: Record<Failure["code"], 401 | 403 | 404 | 409 | 422 | 429 | 502 | 504> = {
  connector_not_connected: 409,
  connector_reconnect: 409,
  connector_token_refused: 409,
  connector_no_projects: 403,
  connector_bad_token: 422,
  connector_no_access: 403,
  connector_scope: 403,
  connector_no_organization: 404,
  connector_setup: 403,
  connector_rate_limited: 429,
  connector_forbidden: 403,
  connector_not_found: 404,
  connector_bad_query: 422,
  connector_field_refused: 422,
  connector_no_estimate_field: 422,
  connector_query_cap: 422,
  connector_unavailable: 502,
  connector_timeout: 504,
};

/** Who is asking. `account` is the one id a token is ever read by. */
interface Caller {
  account: AccountId;
  sessionId: string;
}

/** A tracker, with what it takes to connect one. A third way to sign in is a third member. */
export type AnyConnector<Q> =
  | (BacklogConnector<Q> & OAuthSignIn & SprintBoards)
  | (BacklogConnector<Q> & PastedToken & ItemFields & SavedQueries);

export interface ConnectorApiDeps<Q = BacklogQuery> {
  auth: Auth;
  connector: AnyConnector<Q>;
  access: ConnectorAccess;
  tokens: ConnectorTokenStore;
  states: OAuthStateStore;
  rooms: Pick<RoomStore, "loadRoom" | "roomCodeOf">;
  history: Pick<HistoryStore, "loadDecision">;
  sync: Pick<RoomSync, "commandAs">;
  config: Config;
  limiter: RateLimiter;
}

/** What an item's `source` names and a write-back compares: a site, or the organisation around it. */
const homeOf = (site: Pick<Site, "id" | "home">) => site.home ?? site.id;

/** The queue's entry of a found item, or `null` when its key is not a key. */
function entryOf(item: FoundItem, site: Site, system: BacklogConnector["system"]) {
  const summary = item.title.replace(/\s+/gu, " ").trim();
  const long = Array.from(summary).length > MAX_TITLE_LENGTH;
  const title = long ? cutTitle(summary, MAX_TITLE_LENGTH) : summary;
  const parts = { key: item.key, url: item.url };
  // A summary with hidden characters would cost the ticket: it keeps its key and link.
  const titled = title === "" ? null : cleanQueueItem({ ...parts, title });
  const entry = titled ?? cleanQueueItem(parts);
  if (entry === null) return null;
  const source = { system, site: homeOf(site), id: item.id };
  return {
    entry: { ...entry, source } as QueueEntry,
    shortened: long || (title !== "" && titled === null),
  };
}

export function registerConnectorApi<Q>(app: Hono<AppEnv>, deps: ConnectorApiDeps<Q>): void {
  const { auth, connector, access, tokens, states, rooms, history, sync, config, limiter } = deps;
  const { name } = connector;
  const oauth = "authorizeUrl" in connector ? connector : null;
  const pasted = "checkToken" in connector ? connector : null;
  /** Azure DevOps treats an organisation's name without regard to case. Jira's ids stay exact. */
  const plainHome = (home: string | undefined) => (pasted ? home?.toLowerCase() : home);
  const fieldBody: z.ZodType<{ id: string; type?: string }> = pasted ? typedFieldBody : idBody;
  const own = `/api/connectors/${name}`;
  const inRoom = `/api/rooms/:code/connectors/${name}`;
  const redirectUri = `${config.baseUrl}${own}/callback`;

  /** A `Failure` as an answer. The log says what kind, and nothing of the tracker's words. */
  function failed(c: Context<AppEnv>, failure: Failure) {
    c.var.log.info({ connector: name, code: failure.code }, "connector call refused");
    const { code } = failure;
    const retryAfter =
      failure.retryAfter === undefined
        ? undefined
        : Math.min(failure.retryAfter, MAX_RETRY_AFTER_S);
    if (retryAfter !== undefined) c.header("Retry-After", String(retryAfter));
    return c.json(
      { code, ...(retryAfter === undefined ? {} : { retryAfter }) },
      STATUS_OF[failure.code],
    );
  }

  /** What every route but the callback checks, in order. The person, or the refusal to send. */
  async function caller(
    c: Context<AppEnv>,
    bucket: string,
    limit: RateLimitRule,
  ): Promise<Caller | Response> {
    c.header("Cache-Control", "no-store");
    if (foreignOrigin(c, config)) return c.json({ code: "not_allowed" }, 403);
    const session = await sessionOf(auth, c.req.raw.headers);
    if (!session) return c.json({ code: "unauthenticated" }, 401);
    const account = accountOf(session.user);
    if (account === undefined) return c.json({ code: "connector_sign_in" }, 403);
    const allowed = await limiter.consume(`connector|${name}|${bucket}|${account}`, limit);
    if (!allowed.allowed) return rateLimited(c, allowed.retryAfter);
    return { account, sessionId: session.sessionId };
  }

  /** A JSON body through its schema, or the refusal to send. */
  async function body<T>(c: Context<AppEnv>, schema: z.ZodType<T>): Promise<T | Response> {
    if (!isJsonBody(c)) return c.json({ code: "bad_payload" }, 415);
    const parsed = schema.safeParse(await c.req.json().catch(() => undefined));
    return parsed.success ? parsed.data : c.json({ code: "bad_payload" }, 400);
  }

  /** The room of the path, for its PO and for nobody else. */
  async function poRoom(c: Context<AppEnv>, me: Caller): Promise<StoredRoom | Response> {
    const code = c.req.param("code");
    const room = code !== undefined && isRoomCode(code) ? await rooms.loadRoom(code) : null;
    if (!room) return c.json({ code: "room_not_found" }, 404);
    if (room.state.ownerId !== me.account) return c.json({ code: "not_allowed" }, 403);
    return room;
  }

  async function settingsOf(account: AccountId): Promise<Settings | null> {
    const parsed = settingsSchema.safeParse(await tokens.readSettings(account, name));
    return parsed.success ? parsed.data : null;
  }

  async function organizationOf(account: AccountId): Promise<string | undefined> {
    const parsed = organizationSchema.safeParse(await tokens.readSettings(account, name));
    return parsed.success ? parsed.data.organization : undefined;
  }

  /** The chosen site, or the refusal: nothing is asked of a tracker without one. */
  async function siteOf(c: Context<AppEnv>, me: Caller): Promise<Settings | Response> {
    const settings = await settingsOf(me.account);
    if (settings !== null) return settings;
    const connected = (await tokens.readSettings(me.account, name)) !== undefined;
    return c.json({ code: connected ? "connector_no_site" : "connector_not_connected" }, 409);
  }

  /** Where a connection comes back to: a path this server built, from a room it looked up. */
  async function backTo(c: Context<AppEnv>, room: string | null, result: ConnectorResult) {
    const code = room === null ? null : await rooms.roomCodeOf(room);
    return c.redirect(
      `${code === null ? "/" : `/r/${code}`}?${CONNECTOR_RESULT_PARAM}=${result}`,
      302,
    );
  }

  app.get(own, async (c) => {
    const me = await caller(c, "read", CONNECTOR_READ_LIMIT);
    if (me instanceof Response) return me;
    const stored = await tokens.readSettings(me.account, name);
    const settings = settingsSchema.safeParse(stored);
    const organization = organizationSchema.safeParse(stored);
    const view: ConnectionView = {
      connected: stored !== undefined,
      ...(organization.success ? { organization: organization.data.organization } : {}),
      ...(settings.success
        ? {
            site: { id: settings.data.site.id, name: settings.data.site.name },
            ...(settings.data.field ? { field: settings.data.field } : {}),
          }
        : {}),
    };
    return c.json(view);
  });

  app.delete(own, async (c) => {
    const me = await caller(c, "change", CONNECTOR_CHANGE_LIMIT);
    if (me instanceof Response) return me;
    await tokens.deleteToken(me.account, name);
    c.var.log.info({ connector: name }, "connector disconnected");
    return c.body(null, 204);
  });

  if (pasted) {
    // A connection by a pasted token: the token is tested, sealed, and never seen again.
    app.post(`${own}/connect`, async (c) => {
      const me = await caller(c, "change", CONNECTOR_CHANGE_LIMIT);
      if (me instanceof Response) return me;
      const given = await body(c, connectBody);
      if (given instanceof Response) return given;
      if (!pasted.organization.test(given.organization)) {
        return c.json({ code: "connector_bad_organization" }, 422);
      }
      const organization = given.organization.toLowerCase();
      if (!TOKEN_SHAPE.test(given.token)) return c.json({ code: "connector_bad_token" }, 422);
      const token = new Secret(given.token);
      const checked = await pasted.checkToken(organization, token);
      if (!checked.ok) return failed(c, checked);
      const grant = { accessToken: token, refreshToken: new Secret(""), expiresAt: NEVER };
      const saved = await tokens.saveToken(me.account, name, sealGrant(grant));
      if (saved.status !== "saved") return c.json({ code: "connector_not_connected" }, 409);
      // The same organisation keeps its project and field; one project needs no question.
      const before = await settingsOf(me.account);
      const kept = plainHome(before?.site.home) === organization ? before : null;
      const only = checked.value.length === 1 ? checked.value[0] : undefined;
      await tokens.writeSettings(
        me.account,
        name,
        kept ?? { organization, ...(only ? { site: only } : {}) },
      );
      c.var.log.info({ connector: name }, "connector connected");
      return c.body(null, 204);
    });
  }

  if (oauth) {
    app.post(`${inRoom}/connect`, async (c) => {
      const me = await caller(c, "change", CONNECTOR_CHANGE_LIMIT);
      if (me instanceof Response) return me;
      const parsed = await body(c, emptyBody);
      if (parsed instanceof Response) return parsed;
      const room = await poRoom(c, me);
      if (room instanceof Response) return room;
      const state = await states.issue(me.sessionId, room.id);
      return c.json({ url: oauth.authorizeUrl(state, redirectUri) });
    });

    app.get(`${own}/callback`, async (c) => {
      c.header("Cache-Control", "no-store");
      const session = await sessionOf(auth, c.req.raw.headers);
      const account = session ? accountOf(session.user) : undefined;
      const state = c.req.query("state");
      if (!session || account === undefined || state === undefined) {
        return backTo(c, null, "failed");
      }
      const allowed = await limiter.consume(
        `connector|${name}|change|${account}`,
        CONNECTOR_CHANGE_LIMIT,
      );
      if (!allowed.allowed) return backTo(c, null, "failed");
      const taken = await states.take(state, session.sessionId);
      if (taken === null) return backTo(c, null, "failed");
      if (taken.expired) return backTo(c, taken.room, "expired");
      const code = c.req.query("code");
      if (c.req.query("error") !== undefined || code === undefined) {
        return backTo(c, taken.room, "cancelled");
      }
      const grant = await oauth.exchangeCode(code, redirectUri);
      if (!grant.ok) {
        c.var.log.info({ connector: name, code: grant.code }, "connection refused");
        return backTo(c, taken.room, "failed");
      }
      const saved = await tokens.saveToken(account, name, sealGrant(grant.value));
      if (saved.status !== "saved") return backTo(c, taken.room, "failed");
      const sites = await connector.sites(grant.value.accessToken);
      if (sites.ok) {
        // A site still on the list stays, with its field; one site needs no question.
        const before = await settingsOf(account);
        const kept = sites.value.find(({ id }) => id === before?.site.id);
        const only = sites.value.length === 1 ? sites.value[0] : undefined;
        const site = kept ?? only;
        await tokens.writeSettings(
          account,
          name,
          site === undefined
            ? null
            : { site, ...(kept && before?.field ? { field: before.field } : {}) },
        );
      }
      c.var.log.info({ connector: name }, "connector connected");
      return backTo(c, taken.room, "connected");
    });
  }

  /** The person's own sites, as the tracker says today, for the page and for the check. */
  const ownSites = async (account: AccountId) => {
    const organization = await organizationOf(account);
    return access.withToken(account, (token) => connector.sites(token, organization));
  };

  app.get(`${own}/sites`, async (c) => {
    const me = await caller(c, "read", CONNECTOR_READ_LIMIT);
    if (me instanceof Response) return me;
    const sites = await ownSites(me.account);
    if (!sites.ok) return failed(c, sites);
    return c.json({ sites: sites.value.map(({ id, name: site }) => ({ id, name: site })) });
  });

  app.put(`${own}/site`, async (c) => {
    const me = await caller(c, "change", CONNECTOR_CHANGE_LIMIT);
    if (me instanceof Response) return me;
    const chosen = await body(c, idBody);
    if (chosen instanceof Response) return chosen;
    // Only an id from this person's own list, read now with their token, ever gets stored.
    const sites = await ownSites(me.account);
    if (!sites.ok) return failed(c, sites);
    const site = sites.value.find(({ id }) => id === chosen.id);
    if (site === undefined) return c.json({ code: "connector_bad_site" }, 403);
    const before = await settingsOf(me.account);
    const field = before?.site.id === site.id ? before.field : undefined;
    const organization = await organizationOf(me.account);
    const stored = await tokens.writeSettings(me.account, name, {
      ...(organization === undefined ? {} : { organization }),
      site,
      ...(field ? { field } : {}),
    });
    if (!stored) return c.json({ code: "connector_not_connected" }, 409);
    return c.body(null, 204);
  });

  app.get(`${own}/fields`, async (c) => {
    const me = await caller(c, "read", CONNECTOR_READ_LIMIT);
    if (me instanceof Response) return me;
    const type = pasted ? c.req.query("type") : undefined;
    if (pasted && !type) return c.json({ code: "bad_payload" }, 400);
    const settings = await siteOf(c, me);
    if (settings instanceof Response) return settings;
    const fields = await access.withToken(me.account, (token) =>
      connector.numberFields(token, settings.site.id, type),
    );
    if (!fields.ok) return failed(c, fields);
    const guess = connector.guessField(fields.value);
    const view: ConnectorFieldsView = {
      fields: fields.value,
      ...(guess === undefined ? {} : { guess }),
    };
    return c.json(view);
  });

  app.put(`${own}/field`, async (c) => {
    const me = await caller(c, "change", CONNECTOR_CHANGE_LIMIT);
    if (me instanceof Response) return me;
    const chosen = await body(c, fieldBody);
    if (chosen instanceof Response) return chosen;
    const settings = await siteOf(c, me);
    if (settings instanceof Response) return settings;
    const fields = await access.withToken(me.account, (token) =>
      connector.numberFields(token, settings.site.id, chosen.type),
    );
    if (!fields.ok) return failed(c, fields);
    const field = fields.value.find(({ id }) => id === chosen.id);
    if (field === undefined) return c.json({ code: "connector_bad_field" }, 422);
    const stored = await tokens.writeSettings(me.account, name, { ...settings, field });
    if (!stored) return c.json({ code: "connector_not_connected" }, 409);
    return c.body(null, 204);
  });

  if (oauth) {
    app.get(`${own}/boards`, async (c) => {
      const me = await caller(c, "read", CONNECTOR_READ_LIMIT);
      if (me instanceof Response) return me;
      const settings = await siteOf(c, me);
      if (settings instanceof Response) return settings;
      const typed = c.req.query("name")?.trim().slice(0, 100);
      const boards = await access.withToken(me.account, (token) =>
        oauth.boards(token, settings.site.id, typed === "" ? undefined : typed),
      );
      if (!boards.ok) return failed(c, boards);
      return c.json({ ...boards.value, boards: boards.value.boards.slice(0, MAX_BOARDS) });
    });

    app.get(`${own}/boards/:id/sprints`, async (c) => {
      const me = await caller(c, "read", CONNECTOR_READ_LIMIT);
      if (me instanceof Response) return me;
      const id = c.req.param("id");
      if (!/^[1-9][0-9]{0,11}$/.test(id)) return c.json({ code: "bad_payload" }, 400);
      const settings = await siteOf(c, me);
      if (settings instanceof Response) return settings;
      const sprints = await access.withToken(me.account, (token) =>
        oauth.sprints(token, settings.site.id, Number(id)),
      );
      if (!sprints.ok) return failed(c, sprints);
      return c.json({ sprints: sprints.value });
    });
  }

  if (pasted) {
    // Back to the field of each item's own type.
    app.delete(`${own}/field`, async (c) => {
      const me = await caller(c, "change", CONNECTOR_CHANGE_LIMIT);
      if (me instanceof Response) return me;
      const settings = await siteOf(c, me);
      if (settings instanceof Response) return settings;
      const { field: _, ...rest } = settings;
      await tokens.writeSettings(me.account, name, rest);
      return c.body(null, 204);
    });

    app.get(`${own}/types`, async (c) => {
      const me = await caller(c, "read", CONNECTOR_READ_LIMIT);
      if (me instanceof Response) return me;
      const settings = await siteOf(c, me);
      if (settings instanceof Response) return settings;
      const types = await access.withToken(me.account, (token) =>
        pasted.workItemTypes(token, settings.site.id),
      );
      if (!types.ok) return failed(c, types);
      return c.json({ types: types.value });
    });

    app.get(`${own}/queries`, async (c) => {
      const me = await caller(c, "read", CONNECTOR_READ_LIMIT);
      if (me instanceof Response) return me;
      const settings = await siteOf(c, me);
      if (settings instanceof Response) return settings;
      const queries = await access.withToken(me.account, (token) =>
        pasted.savedQueries(token, settings.site.id),
      );
      if (!queries.ok) return failed(c, queries);
      const view: ConnectorSavedQueriesView = queries.value;
      return c.json(view);
    });
  }

  /** All a query finds, in order, up to what the queue can take. Nothing on a failed page. */
  async function find(me: Caller, site: Site, query: Q, room: StoredRoom) {
    const entries: QueueEntry[] = [];
    let shortened = 0;
    let unreadable = 0;
    let next: string | undefined;
    for (let page = 0; page < MAX_SEARCH_PAGES; page++) {
      const found: Outcome<FoundPage> = await access.withToken(me.account, (token) =>
        connector.search(token, site, query, next),
      );
      if (!found.ok) return found;
      unreadable += found.value.unreadable ?? 0;
      for (const item of found.value.items) {
        const made = entryOf(item, site, connector.system);
        if (made === null) unreadable += 1;
        else {
          entries.push(made.entry);
          if (made.shortened) shortened += 1;
        }
      }
      next = found.value.next;
      if (next === undefined || fitToQueue(room.state.queue, entries).overflow > 0) break;
    }
    return { ok: true as const, entries, shortened, unreadable, more: next !== undefined };
  }

  app.post(`${inRoom}/import`, async (c) => {
    const me = await caller(c, "import", CONNECTOR_IMPORT_LIMIT);
    if (me instanceof Response) return me;
    const query = await body(c, connector.query);
    if (query instanceof Response) return query;
    const room = await poRoom(c, me);
    if (room instanceof Response) return room;
    const settings = await siteOf(c, me);
    if (settings instanceof Response) return settings;
    const found = await find(me, settings.site, query, room);
    if (!found.ok) return failed(c, found);
    const { fit, duplicates, overflow } = fitToQueue(room.state.queue, found.entries);
    if (fit.length > 0) {
      // `apply` decides, on the state it commits over: a PO who lost the role is refused.
      const ack = await sync.commandAs(room, me.account, { type: "queueImport", items: fit });
      if (!ack.ok) return commandRefused(c, ack.code);
    }
    let beyond: number | null = 0;
    if (found.more) {
      const count = await access.withToken(me.account, (token) =>
        connector.count(token, settings.site.id, query),
      );
      const read = found.entries.length + found.unreadable;
      beyond = count.ok ? Math.max(0, count.value - read) : null;
    }
    const view: ConnectorImportView = {
      added: fit.length,
      duplicates,
      shortened: found.shortened,
      leftOut: overflow + found.unreadable,
      beyond,
    };
    c.var.log.info(
      { room: room.id, connector: name, added: view.added, leftOut: view.leftOut },
      "backlog imported",
    );
    return c.json(view);
  });

  function commandRefused(c: Context<AppEnv>, code: string) {
    switch (code) {
      case "not_owner":
      case "not_participant":
        return c.json({ code: "not_allowed" }, 403);
      case "queue_full":
        return c.json({ code }, 409);
      case "room_not_found":
        return c.json({ code }, 404);
      case "busy":
        return c.json({ code }, 503);
      default:
        return c.json({ code: "internal" }, 500);
    }
  }

  app.post(`${inRoom}/write-back`, async (c) => {
    const me = await caller(c, "write", CONNECTOR_WRITE_LIMIT);
    if (me instanceof Response) return me;
    const asked = await body(c, writeBody);
    if (asked instanceof Response) return asked;
    const room = await poRoom(c, me);
    if (room instanceof Response) return room;
    const decision = await history.loadDecision(room.id, asked.round);
    if (!decision?.final) {
      return c.json({ code: "connector_no_final" }, 409);
    }
    const { final, source, subject } = decision;
    if (source === null || source.system !== connector.system) {
      return c.json({ code: "connector_no_source" }, 409);
    }
    const value = cardValue(final);
    if (value === null) return c.json({ code: "connector_not_numeric" }, 422);
    const settings = await siteOf(c, me);
    if (settings instanceof Response) return settings;
    // The item names its own site: a PO connected elsewhere writes nothing, to no other issue.
    if (plainHome(homeOf(settings.site)) !== plainHome(source.site)) {
      return c.json({ code: "connector_other_site" }, 409);
    }
    const { field } = settings;
    if (pasted === null && field === undefined) return c.json({ code: "connector_no_field" }, 409);
    const written = await access.withToken(me.account, async (token) => {
      // A tracker whose field depends on the item says which, and a choice of the person's goes in.
      const target = pasted
        ? await pasted.fieldFor(token, source.site, source.id, field?.id)
        : success(field?.id ?? "");
      if (!target.ok) return target;
      return connector.writeEstimate(token, source.site, source.id, target.value, value);
    });
    if (!written.ok) return failed(c, written);
    c.var.log.info({ room: room.id, connector: name, round: asked.round }, "estimate written");
    const view: ConnectorWriteView = {
      key: subject.kind === "link" ? (subject.key ?? null) : null,
      value,
    };
    return c.json(view);
  });
}
