/**
 * `node dist/main.mjs vault:rotate` (ADR-026): one run of `rotateTokens` in the container of a
 * running server, on a small pool of its own and without a port. It reads the same variables
 * as the server, so it runs with the keys the server has. It answers with an exit code: 0 when
 * every row is on the current key, 1 when one is not or the run failed, with one line of
 * counts or of the reason, never a token, a key or a user.
 */
import pg from "pg";
import type { DestinationStream } from "pino";
import { ConfigError, loadConfig } from "./config.ts";
import { CONNECT_TIMEOUT_MS, libpqUrl } from "./database.ts";
import { rotateTokens } from "./db/connector-tokens.ts";
import { errorCode } from "./db/errors.ts";
import { createLogger } from "./logger.ts";

export async function runVaultRotation(
  env: Readonly<Record<string, string | undefined>>,
  destination?: DestinationStream,
): Promise<number> {
  let config: ReturnType<typeof loadConfig>;
  try {
    config = loadConfig(env);
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    createLogger("info", destination).fatal({ variables: error.variables }, error.message);
    return 1;
  }
  const logger = createLogger(config.logLevel, destination);
  if (!config.vault) {
    logger.error("vault: POKER_VAULT_KEY is not set, nothing to rotate to");
    return 1;
  }
  const pool = new pg.Pool({
    connectionString: libpqUrl(config.databaseUrl),
    application_name: "poker-planning-vault-rotate",
    max: 1,
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
  });
  pool.on("error", () => {});
  try {
    const counts = await rotateTokens(pool, config.vault);
    if (counts.unreadable > 0) {
      logger.warn(
        counts,
        "vault: rotation done, some rows cannot be opened and stayed as they are",
      );
      return 1;
    }
    logger.info(counts, "vault: rotation done");
    return 0;
  } catch (error) {
    logger.error({ code: errorCode(error) }, "vault: rotation failed, it is safe to run it again");
    return 1;
  } finally {
    await pool.end().catch(() => {});
  }
}
