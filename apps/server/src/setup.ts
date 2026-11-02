/**
 * The `setup` hook `main.ts` hands to `run()`: the database (#7), then identity (#10) on
 * its pool, then Redis when `REDIS_URL` is set (#39, several instances), the room API
 * (#14) and the room sync (#15) on its runner, the retention job (#35), whose first run
 * comes a few minutes later, a guest's way to an account (#48), between identity and the
 * room sync, "My rooms" (#49) and the trackers' connectors (#54). Opens nothing at import time.
 */
import {
  cookieNaming,
  createAuth,
  registerAuthApi,
  sessionChecker,
  sessionMiddleware,
} from "./auth.ts";
import { type Config, connectorNames } from "./config.ts";
import { createConnectorAccess } from "./connectors/access.ts";
import { createJiraConnector } from "./connectors/jira.ts";
import { createOAuthStateStore } from "./connectors/oauth-state.ts";
import { registerConnectorApi } from "./connectors/routes.ts";
import { type Database, setupDatabase } from "./database.ts";
import { createGuestLinkStore } from "./db/guest-links.ts";
import { createMyRoomsStore } from "./db/my-rooms.ts";
import { createGuestLinks, type GuestLinks } from "./guest-link.ts";
import type { Logger } from "./logger.ts";
import { registerMyRoomsApi } from "./my-rooms.ts";
import { memoryRateLimit, type RateLimitRule } from "./rate-limit.ts";
import { type Retention, startRetention } from "./retention.ts";
import { registerPasswordApi } from "./room-password.ts";
import { createRoomRules } from "./room-rule.ts";
import { registerRestrictionApi } from "./room-rule-api.ts";
import { registerRoomApi } from "./rooms.ts";
import type { Setup } from "./run.ts";
import { connectScaleOut, type ScaleOut } from "./scale-out.ts";
import { createRoomSync, type RoomSync } from "./sync/room-sync.ts";

/** Knobs for tests only; production runs with the defaults. */
export interface SetupTuning {
  /** Commits that set a rule (`RULE_CHANGE_LIMIT` by default). */
  ruleChangeLimit?: RateLimitRule;
  /** The presence grace (`PRESENCE_GRACE_MS`, 15 s, by default). */
  presenceGraceMs?: number;
  /** The grace after a restart (`PRESENCE_RESTART_GRACE_MS`, 60 s, by default). */
  presenceRestartGraceMs?: number;
  /** False: no deadline timeout, only the clients' `timeUp` pings and commands (#27). */
  deadlineTimeouts?: boolean;
  /** The retention job's first run, without jitter (3 to 5 minutes by default). */
  retentionStartDelayMs?: number;
  /** The retention job's clock (Postgres's `now()` by default). */
  retentionNow?: () => number;
  /** Several instances: how often the presence sweep runs (`PRESENCE_SWEEP_MS`). */
  presenceSweepMs?: number;
}

export async function setupServer(
  config: Config,
  logger: Logger,
  signal?: AbortSignal,
  tuning: SetupTuning = {},
): Promise<
  Setup & {
    database: Database;
    auth: ReturnType<typeof createAuth>;
    retention: Retention;
    links: GuestLinks;
  }
> {
  const opened = await setupDatabase(config, logger, signal);
  const { database } = opened;
  // Building the auth instance queries nothing; if it throws, release the pool first.
  // One limiter for Better Auth's endpoints and the app's own (`/api/me/name`, rooms).
  const limiter = memoryRateLimit();
  // Nothing calls these before the server listens, and by then `sync` is there.
  let sync: RoomSync;
  const links = createGuestLinks({
    store: createGuestLinkStore(database.db),
    rooms: {
      moveGuest: (room, guest, account) => sync.moveGuest(room, guest, account),
      dropGuest: (guest, account) => sync.dropGuest(guest, account),
    },
    logger,
  });
  let auth: ReturnType<typeof createAuth>;
  try {
    auth = createAuth(config, database.db, logger, limiter, links);
  } catch (error) {
    await database.close();
    throw error;
  }
  let scaleOut: ScaleOut | undefined;
  if (config.redisUrl !== undefined) {
    try {
      scaleOut = await connectScaleOut(config.redisUrl, logger, signal ? { signal } : {});
    } catch (error) {
      await database.close();
      throw error;
    }
  }
  const { runner, store, db, retention: retentionStore } = database;
  const rules = createRoomRules(db, config);
  sync = createRoomSync({
    limiter,
    runner,
    store,
    access: store,
    rules,
    history: store,
    logger,
    sessionAlive: sessionChecker(db),
    touchRoom: (roomId) => retentionStore.touchRoom(roomId, config.roomTtlDays),
    settleLinks: (account) => links.settle(account),
    ...(tuning.ruleChangeLimit !== undefined && { ruleChangeLimit: tuning.ruleChangeLimit }),
    ...(tuning.presenceGraceMs !== undefined && { presenceGraceMs: tuning.presenceGraceMs }),
    ...(tuning.presenceRestartGraceMs !== undefined && {
      presenceRestartGraceMs: tuning.presenceRestartGraceMs,
    }),
    ...(tuning.deadlineTimeouts !== undefined && { deadlineTimeouts: tuning.deadlineTimeouts }),
    ...(scaleOut && {
      shared: {
        acks: scaleOut.acks,
        ...(tuning.presenceSweepMs !== undefined && { sweepMs: tuning.presenceSweepMs }),
      },
    }),
  });
  const retention = startRetention({
    store: retentionStore,
    ttlDays: config.roomTtlDays,
    logger,
    occupied: () => sync.occupiedRooms(),
    beforePurge: () => links.sweep(),
    ...(tuning.retentionStartDelayMs !== undefined && {
      startDelayMs: tuning.retentionStartDelayMs,
      jitterMs: 0,
    }),
    ...(tuning.retentionNow !== undefined && { now: tuning.retentionNow }),
  });
  return {
    database,
    auth,
    retention,
    links,
    deps: {
      ...opened.deps,
      registerApi: (app) => {
        registerAuthApi(app, { auth, db: database.db, config, limiter });
        registerRoomApi(app, { auth, rooms: store, config, limiter, rules });
        registerPasswordApi(app, { auth, rooms: store, sync, config, limiter, rules });
        registerRestrictionApi(app, { auth, rooms: store, sync, config, rules, limiter });
        registerMyRoomsApi(app, {
          auth,
          rooms: createMyRoomsStore(db),
          links,
          sync,
          config,
          limiter,
          rules,
        });
        // Dark without its keys, the vault and a way to sign in: nothing is registered.
        if (config.jira && connectorNames(config).includes("jira")) {
          const connector = createJiraConnector(config.jira);
          const tokens = database.connectorTokens;
          registerConnectorApi(app, {
            auth,
            connector,
            access: createConnectorAccess(tokens, connector),
            tokens,
            states: createOAuthStateStore(db),
            rooms: store,
            history: store,
            sync,
            config,
            limiter,
          });
        }
      },
      socketMiddleware: [sessionMiddleware(auth)],
      sessionCookie: cookieNaming(config.baseUrl).sessionCookie,
      handlers: sync,
      ...(scaleOut && {
        // WebSocket only: a connection stays on the instance it reached, so no sticky
        // sessions are needed; the web app learns it from index.html (`app.ts`).
        realtimeCluster: { adapter: scaleOut.adapter, transports: ["websocket"] },
        checkRedis: scaleOut.ping,
        websocketOnly: true,
      }),
    },
    // Before the server closes its sockets: a run that started during the close would see
    // no socket and take the occupied rooms for idle ones.
    beforeClose: () => retention.stop(),
    dispose: async () => {
      // Again here, for a failed listen and for tests: `stop` is idempotent.
      await retention.stop();
      sync.close();
      // After the server closed, which closed the adapter's subscriptions.
      await scaleOut?.close();
      await database.close();
    },
  };
}
