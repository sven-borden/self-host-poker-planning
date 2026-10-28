/**
 * The `setup` hook `main.ts` hands to `run()`: the database (#7), then identity (#10) on
 * its pool, then the room API (#14) and the room sync (#15) on its runner, and the
 * retention job (#35), whose first run comes a few minutes later. Opens nothing at import
 * time.
 */
import { createAuth, registerAuthApi, sessionChecker, sessionMiddleware } from "./auth.ts";
import type { Config } from "./config.ts";
import { type Database, setupDatabase } from "./database.ts";
import type { Logger } from "./logger.ts";
import { memoryRateLimit } from "./rate-limit.ts";
import { startRetention } from "./retention.ts";
import { registerPasswordApi } from "./room-password.ts";
import { registerRoomApi } from "./rooms.ts";
import type { Setup } from "./run.ts";
import { createRoomSync } from "./sync/room-sync.ts";

/** Knobs for tests only; production runs with the defaults. */
export interface SetupTuning {
  /** The presence grace (`PRESENCE_GRACE_MS`, 15 s, by default). */
  presenceGraceMs?: number;
  /** The grace after a restart (`PRESENCE_RESTART_GRACE_MS`, 60 s, by default). */
  presenceRestartGraceMs?: number;
  /** False: no deadline timeout, only the clients' `timeUp` pings and commands (#27). */
  deadlineTimeouts?: boolean;
}

export async function setupServer(
  config: Config,
  logger: Logger,
  signal?: AbortSignal,
  tuning: SetupTuning = {},
): Promise<Setup & { database: Database; auth: ReturnType<typeof createAuth> }> {
  const opened = await setupDatabase(config, logger, signal);
  const { database } = opened;
  // Building the auth instance queries nothing; if it throws, release the pool first.
  // One limiter for Better Auth's endpoints and the app's own (`/api/me/name`, rooms).
  const limiter = memoryRateLimit();
  let auth: ReturnType<typeof createAuth>;
  try {
    auth = createAuth(config, database.db, logger, limiter);
  } catch (error) {
    await database.close();
    throw error;
  }
  const { runner, store, db, retention: retentionStore } = database;
  const sync = createRoomSync({
    runner,
    store,
    access: store,
    logger,
    sessionAlive: sessionChecker(db),
    touchRoom: retentionStore.touchRoom,
    ...(tuning.presenceGraceMs !== undefined && { presenceGraceMs: tuning.presenceGraceMs }),
    ...(tuning.presenceRestartGraceMs !== undefined && {
      presenceRestartGraceMs: tuning.presenceRestartGraceMs,
    }),
    ...(tuning.deadlineTimeouts !== undefined && { deadlineTimeouts: tuning.deadlineTimeouts }),
  });
  const retention = startRetention({
    store: retentionStore,
    ttlDays: config.roomTtlDays,
    logger,
    occupied: () => sync.occupiedRooms(),
  });
  return {
    database,
    auth,
    deps: {
      ...opened.deps,
      registerApi: (app) => {
        registerAuthApi(app, { auth, db: database.db, config, limiter });
        registerRoomApi(app, { auth, rooms: store, config, limiter });
        registerPasswordApi(app, { auth, rooms: store, sync, config, limiter });
      },
      socketMiddleware: [sessionMiddleware(auth)],
      handlers: sync,
    },
    dispose: async () => {
      sync.close();
      await retention.stop();
      await database.close();
    },
  };
}
