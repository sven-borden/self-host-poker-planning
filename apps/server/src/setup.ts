/**
 * The `setup` hook `main.ts` hands to `run()`: the database (#7), then identity (#10) on
 * its pool, then the room sync (#15) on its runner. Opens nothing at import time.
 */
import {
  createAuth,
  memoryRateLimit,
  registerAuthApi,
  sessionChecker,
  sessionMiddleware,
} from "./auth.ts";
import type { Config } from "./config.ts";
import { type Database, setupDatabase } from "./database.ts";
import type { Logger } from "./logger.ts";
import type { Setup } from "./run.ts";
import { createRoomSync } from "./sync/room-sync.ts";

export async function setupServer(
  config: Config,
  logger: Logger,
  signal?: AbortSignal,
): Promise<Setup & { database: Database; auth: ReturnType<typeof createAuth> }> {
  const opened = await setupDatabase(config, logger, signal);
  const { database } = opened;
  // Building the auth instance queries nothing; if it throws, release the pool first.
  // One limiter for Better Auth's endpoints and the app's own (`/api/me/name`).
  const limiter = memoryRateLimit();
  let auth: ReturnType<typeof createAuth>;
  try {
    auth = createAuth(config, database.db, logger, limiter);
  } catch (error) {
    await database.close();
    throw error;
  }
  const { runner, store, db } = database;
  const rooms = createRoomSync({ runner, store, logger, sessionAlive: sessionChecker(db) });
  return {
    database,
    auth,
    deps: {
      ...opened.deps,
      registerApi: (app) => registerAuthApi(app, { auth, db: database.db, config, limiter }),
      socketMiddleware: [sessionMiddleware(auth)],
      handlers: rooms,
    },
    dispose: async () => {
      rooms.close();
      await database.close();
    },
  };
}
