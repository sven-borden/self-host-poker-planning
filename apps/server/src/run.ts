/**
 * Start and stop. `main.ts` calls `run(process.env, …)` and nothing else does; the process
 * hooks are parameters so tests drive a start, a signal and the exit code in-process.
 */
import { existsSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { join, resolve } from "node:path";
import type { DestinationStream } from "pino";
import { ConfigError, loadConfig } from "./config.ts";
import { createLogger } from "./logger.ts";
import { createServer, type PokerServer, type ServerDeps } from "./server.ts";

export type Signal = "SIGTERM" | "SIGINT";
export type Crash = "uncaughtException" | "unhandledRejection";

export interface ProcessHooks {
  exit(code: number): void;
  /** Registers a handler for both signals. */
  onSignal(handler: (signal: Signal) => void): void;
  /** Registers a handler for an uncaught exception and an unhandled rejection. */
  onCrash(handler: (crash: Crash, error: unknown) => void): void;
  /** Log output; stdout when left out. */
  destination?: DestinationStream;
  /** Hard limit for a shutdown; default 10 s. Open connections are cut 2 s before. */
  shutdownTimeoutMs?: number;
  /** Wires #7's database and #10's auth into the server; receives the valid config. */
  deps?: Omit<ServerDeps, "logger" | "staticDir">;
}

/** `apps/web/dist`, seen from `apps/server/src` (tsx) and `apps/server/dist` (bundle). */
export const DEFAULT_STATIC_DIR = resolve(import.meta.dirname, "../../web/dist");

/**
 * Validates the config, listens and installs the signal handlers. A bad config logs one
 * line naming the variables (never their values) and exits 1. Resolves with the running
 * server, or `undefined` when the config was refused.
 */
export async function run(
  env: Readonly<Record<string, string | undefined>>,
  hooks: ProcessHooks,
): Promise<PokerServer | undefined> {
  let config: ReturnType<typeof loadConfig>;
  try {
    config = loadConfig(env);
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    createLogger("info", hooks.destination).fatal({ variables: error.variables }, error.message);
    hooks.exit(1);
    return undefined;
  }

  const logger = createLogger(config.logLevel, hooks.destination);
  // A bug that escapes every handler: one fatal line, then exit 1 for the orchestrator to
  // restart the container. Continuing would run on an unknown state.
  hooks.onCrash((crash, error) => {
    logger.fatal({ err: error, crash }, "crashed");
    hooks.exit(1);
  });
  const staticDir = config.staticDir ? resolve(config.staticDir) : DEFAULT_STATIC_DIR;
  if (!existsSync(join(staticDir, "index.html"))) {
    logger.warn({ staticDir }, "web app not built: serving the API only");
  }
  const server = createServer(config, { ...hooks.deps, logger, staticDir });
  let address: AddressInfo;
  try {
    address = await server.listen();
  } catch (error) {
    logger.fatal({ err: error, port: config.port }, "cannot listen");
    await server.io.close();
    hooks.exit(1);
    return undefined;
  }
  logger.info(
    {
      port: address.port,
      version: config.appVersion ?? "dev",
      commit: config.gitCommit ?? "unknown",
    },
    "listening",
  );

  const timeoutMs = hooks.shutdownTimeoutMs ?? 10_000;
  let stopping = false;
  hooks.onSignal((signal) => {
    if (stopping) {
      logger.info({ signal }, "shutdown: already in progress");
      return;
    }
    stopping = true;
    logger.info({ signal }, "shutdown: started");
    const cut = setTimeout(() => {
      logger.warn("shutdown: closing the remaining connections");
      server.httpServer.closeAllConnections();
    }, timeoutMs - 2000);
    const fail = setTimeout(() => {
      logger.error({ timeoutMs }, "shutdown: timed out");
      hooks.exit(1);
    }, timeoutMs);
    cut.unref();
    fail.unref();
    server.close().then(
      () => {
        clearTimeout(cut);
        clearTimeout(fail);
        logger.info("shutdown: done");
        hooks.exit(0);
      },
      (error: unknown) => {
        logger.error({ err: error }, "shutdown: failed");
        hooks.exit(1);
      },
    );
  });
  return server;
}

/** The part of `process` that `processHooks` uses; tests pass an EventEmitter. */
export interface NodeProcess {
  exit(code: number): void;
  on(event: string, listener: (value: unknown) => void): unknown;
}

/** Wires `run()` to the real process: exit, SIGTERM/SIGINT and the two crash events. */
export function processHooks(proc: NodeProcess): ProcessHooks {
  return {
    exit: (code) => proc.exit(code),
    onSignal: (handler) => {
      for (const signal of ["SIGTERM", "SIGINT"] satisfies Signal[]) {
        proc.on(signal, () => handler(signal));
      }
    },
    onCrash: (handler) => {
      for (const crash of ["uncaughtException", "unhandledRejection"] satisfies Crash[]) {
        proc.on(crash, (error) => handler(crash, error));
      }
    },
  };
}
