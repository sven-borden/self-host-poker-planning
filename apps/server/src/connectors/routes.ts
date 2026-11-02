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
 * For the PO of a room, at `/api/rooms/:code/connectors/:name`:
 * - `POST …/connect` answers `{ url }`, where the page sends the browser;
 * - `POST …/import { jql } | { sprint }` fills the queue through `apply`;
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
  type ConnectorWriteView,
  MAX_BOARDS,
  MAX_JQL_LENGTH,
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
import type { ConnectorAccess } from "./access.ts";
import { sealGrant } from "./access.ts";
import type {
  BacklogConnector,
  BacklogQuery,
  Failure,
  FoundItem,
  Outcome,
  Site,
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

const idBody = z.strictObject({ id: z.string().min(1).max(128) });
const importBody = z.union([
  z.strictObject({ jql: z.string().trim().min(1).max(MAX_JQL_LENGTH) }),
  z.strictObject({ sprint: z.number().int().positive().max(WIRE_LIMITS.roundNumber) }),
]);
const writeBody = z.strictObject({
  round: z.number().int().positive().max(WIRE_LIMITS.roundNumber),
});
const emptyBody = z.strictObject({});

/** What `connector_token.settings` holds: read through this, so an old shape counts as none. */
const settingsSchema = z.object({
  site: z.object({ id: z.string(), name: z.string(), url: z.string() }),
  field: z.object({ id: z.string(), name: z.string() }).optional(),
});
type Settings = z.output<typeof settingsSchema>;

const STATUS_OF: Record<Failure["code"], 401 | 403 | 404 | 409 | 422 | 429 | 502 | 504> = {
  connector_not_connected: 409,
  connector_reconnect: 409,
  connector_rate_limited: 429,
  connector_forbidden: 403,
  connector_not_found: 404,
  connector_bad_query: 422,
  connector_field_refused: 422,
  connector_unavailable: 502,
  connector_timeout: 504,
};

/** Who is asking. `account` is the one id a token is ever read by. */
interface Caller {
  account: AccountId;
  sessionId: string;
}

export interface ConnectorApiDeps {
  auth: Auth;
  connector: BacklogConnector;
  access: ConnectorAccess;
  tokens: ConnectorTokenStore;
  states: OAuthStateStore;
  rooms: Pick<RoomStore, "loadRoom" | "roomCodeOf">;
  history: Pick<HistoryStore, "loadDecision">;
  sync: Pick<RoomSync, "commandAs">;
  config: Config;
  limiter: RateLimiter;
}

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
  const source = { system, site: site.id, id: item.id };
  return { entry: { ...entry, source } as QueueEntry, shortened: long || titled === null };
}

export function registerConnectorApi(app: Hono<AppEnv>, deps: ConnectorApiDeps): void {
  const { auth, connector, access, tokens, states, rooms, history, sync, config, limiter } = deps;
  const { name } = connector;
  const own = `/api/connectors/${name}`;
  const inRoom = `/api/rooms/:code/connectors/${name}`;
  const redirectUri = `${config.baseUrl}${own}/callback`;

  /** A `Failure` as an answer. The log says what kind, and nothing of the tracker's words. */
  function failed(c: Context<AppEnv>, failure: Failure) {
    c.var.log.info({ connector: name, code: failure.code }, "connector call refused");
    const { code, retryAfter } = failure;
    if (retryAfter !== undefined) {
      c.header("Retry-After", String(Math.min(retryAfter, MAX_RETRY_AFTER_S)));
    }
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
    const view: ConnectionView = {
      connected: stored !== undefined,
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

  app.post(`${inRoom}/connect`, async (c) => {
    const me = await caller(c, "change", CONNECTOR_CHANGE_LIMIT);
    if (me instanceof Response) return me;
    const parsed = await body(c, emptyBody);
    if (parsed instanceof Response) return parsed;
    const room = await poRoom(c, me);
    if (room instanceof Response) return room;
    const state = await states.issue(me.sessionId, room.id);
    return c.json({ url: connector.authorizeUrl(state, redirectUri) });
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
    const code = c.req.query("code");
    if (c.req.query("error") !== undefined || code === undefined) {
      return backTo(c, taken.room, "cancelled");
    }
    const grant = await connector.exchangeCode(code, redirectUri);
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

  /** The person's own sites, as the tracker says today, for the page and for the check. */
  const ownSites = (account: AccountId) =>
    access.withToken(account, (token) => connector.sites(token));

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
    const stored = await tokens.writeSettings(me.account, name, {
      site,
      ...(field ? { field } : {}),
    });
    if (!stored) return c.json({ code: "connector_not_connected" }, 409);
    return c.body(null, 204);
  });

  app.get(`${own}/fields`, async (c) => {
    const me = await caller(c, "read", CONNECTOR_READ_LIMIT);
    if (me instanceof Response) return me;
    const settings = await siteOf(c, me);
    if (settings instanceof Response) return settings;
    const fields = await access.withToken(me.account, (token) =>
      connector.numberFields(token, settings.site.id),
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
    const chosen = await body(c, idBody);
    if (chosen instanceof Response) return chosen;
    const settings = await siteOf(c, me);
    if (settings instanceof Response) return settings;
    const fields = await access.withToken(me.account, (token) =>
      connector.numberFields(token, settings.site.id),
    );
    if (!fields.ok) return failed(c, fields);
    const field = fields.value.find(({ id }) => id === chosen.id);
    if (field === undefined) return c.json({ code: "connector_bad_field" }, 422);
    const stored = await tokens.writeSettings(me.account, name, { ...settings, field });
    if (!stored) return c.json({ code: "connector_not_connected" }, 409);
    return c.body(null, 204);
  });

  app.get(`${own}/boards`, async (c) => {
    const me = await caller(c, "read", CONNECTOR_READ_LIMIT);
    if (me instanceof Response) return me;
    const settings = await siteOf(c, me);
    if (settings instanceof Response) return settings;
    const typed = c.req.query("name")?.trim().slice(0, 100);
    const boards = await access.withToken(me.account, (token) =>
      connector.boards(token, settings.site.id, typed === "" ? undefined : typed),
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
      connector.sprints(token, settings.site.id, Number(id)),
    );
    if (!sprints.ok) return failed(c, sprints);
    return c.json({ sprints: sprints.value });
  });

  /** All a query finds, in order, up to what the queue can take. Nothing on a failed page. */
  async function find(me: Caller, site: Site, query: BacklogQuery, room: StoredRoom) {
    const entries: QueueEntry[] = [];
    let shortened = 0;
    let unreadable = 0;
    let next: string | undefined;
    for (let page = 0; page < MAX_SEARCH_PAGES; page++) {
      const found: Outcome<{ items: readonly FoundItem[]; next?: string }> = await access.withToken(
        me.account,
        (token) => connector.search(token, site, query, next),
      );
      if (!found.ok) return found;
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
    const query = await body(c, importBody);
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
      beyond = count.ok ? Math.max(0, count.value - found.entries.length) : null;
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
    if (settings.site.id !== source.site) return c.json({ code: "connector_other_site" }, 409);
    const { field } = settings;
    if (field === undefined) return c.json({ code: "connector_no_field" }, 409);
    const written = await access.withToken(me.account, (token) =>
      connector.writeEstimate(token, source.site, source.id, field.id, value),
    );
    if (!written.ok) return failed(c, written);
    c.var.log.info({ room: room.id, connector: name, round: asked.round }, "estimate written");
    const view: ConnectorWriteView = {
      key: subject.kind === "link" ? (subject.key ?? null) : null,
      value,
    };
    return c.json(view);
  });
}
