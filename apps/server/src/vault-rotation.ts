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
  /** For tests, which race the run: the pool to use instead of one of its own. */
  connection?: Pick<pg.Pool, "query" | "end">,
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
  const pool = (connection ??
    (() => {
      const own = new pg.Pool({
        connectionString: libpqUrl(config.databaseUrl),
        application_name: "poker-planning-vault-rotate",
        max: 1,
        connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
      });
      own.on("error", () => {});
      return own;
    })()) as pg.Pool;
  try {
    const counts = await rotateTokens(pool, config.vault);
    // `keyId` is the 8 hex digits every row sealed with the current key carries: a container
    // that kept the old key (a `restart` does not read `.env` again) shows the old one. It is
    // no key, no user and no token.
    const line = { ...counts, keyId: config.vault.currentKeyId };
    if (counts.unknownKey > 0 || counts.corrupt > 0) {
      logger.warn(
        line,
        "vault: rotation done, but some rows cannot be opened and stayed as they are (unknownKey: its key is not in the variables; corrupt: changed, moved, or a format this version cannot read)",
      );
      return 1;
    }
    if (counts.offKey > 0) {
      logger.warn(
        line,
        "vault: rotation done, but rows are still not on the current key: an instance on an older key keeps writing them, so restart it with the new key, or run this again",
      );
      return 1;
    }
    logger.info(line, "vault: rotation done");
    return 0;
  } catch (error) {
    logger.error({ code: errorCode(error) }, "vault: rotation failed, it is safe to run it again");
    return 1;
  } finally {
    await pool.end().catch(() => {});
  }
}
