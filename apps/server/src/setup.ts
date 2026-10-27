/**
 * The `setup` hook `main.ts` hands to `run()`: the database (#7), then identity (#10) on
 * its pool. W1 adds the room handlers here. Opens nothing at import time.
 */
import { createAuth, registerAuthApi, sessionMiddleware } from "./auth.ts";
import type { Config } from "./config.ts";
import { type Database, setupDatabase } from "./database.ts";
import type { Logger } from "./logger.ts";
import { memoryRateLimit } from "./rate-limit.ts";
import type { Setup } from "./run.ts";

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
  return {
    database,
    auth,
    deps: {
      ...opened.deps,
      registerApi: (app) => registerAuthApi(app, { auth, db: database.db, config, limiter }),
      socketMiddleware: [sessionMiddleware(auth)],
    },
    dispose: opened.dispose,
  };
}
