/**
 * Start and stop. `main.ts` calls `run(process.env, …)` and nothing else does; the process
 * hooks are parameters so tests drive a start, a signal and the exit code in-process.
 */
import { existsSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { join, resolve } from "node:path";
import type { DestinationStream } from "pino";
import { type Config, ConfigError, loadConfig } from "./config.ts";
import { createLogger, type Logger } from "./logger.ts";
import { createServer, type PokerServer, type ServerDeps } from "./server.ts";

export type Signal = "SIGTERM" | "SIGINT";
export type Crash = "uncaughtException" | "unhandledRejection";

/** What later issues hand to `createServer`; `run()` adds the logger and the static folder. */
export type InjectedDeps = Omit<ServerDeps, "logger" | "staticDir">;

/** What `setup` opened: the server's dependencies, and how to release them. */
export interface Setup {
  /** `checkDb` (#7), `registerApi` and `socketMiddleware` (#10), `handlers` (W1). */
  deps?: InjectedDeps;
  /**
   * Releases what `setup` opened (#7: end the pool). Awaited after the server has closed
   * and before exit 0, inside the shutdown limit; also awaited when listen fails.
   */
  dispose?: () => Promise<void>;
  /**
   * Stops background work that reads the open sockets (#35: the retention job, which
   * keeps the rooms someone is in). Awaited at a shutdown before the server closes, so
   * that work never sees the sockets go; `dispose` still follows.
   */
  beforeClose?: () => Promise<void>;
}

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
  /**
   * Opens what the server needs, with the validated config and the process logger: #7
   * connects and runs the migrations, #10 builds Better Auth. Awaited before `listen()`;
   * a throw or a rejection logs one fatal line and exits 1 without listening. A setup that
   * fails halfway releases what it already opened before it throws.
   *
   * `signal` aborts when SIGTERM or SIGINT arrives during the start: setup stops waiting,
   * releases what it opened and rejects; `run()` then logs one line and exits 0.
   */
  setup?(config: Config, logger: Logger, signal: AbortSignal): Promise<Setup>;
}

/** How long an exit waits for the error reports on their way (#40). */
export const REPORTS_FLUSH_MS = 1000;

/** `apps/web/dist`, seen from `apps/server/src` (tsx) and `apps/server/dist` (bundle). */
export const DEFAULT_STATIC_DIR = resolve(import.meta.dirname, "../../web/dist");

/**
 * Validates the config, installs the signal handlers, runs `setup` and listens. A bad
 * config logs one line naming the variables (never their values) and exits 1; so does a
 * failed setup or listen. Resolves with the running server, or `undefined` when it did
 * not start. On a signal: `beforeClose`, close the server, `dispose`, then exit 0; during
 * `setup`, abort it and exit 0.
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

  // Error reports (#40) load only when SENTRY_DSN is set: otherwise no module of theirs.
  const reports = config.sentryDsn
    ? (await import("./sentry.ts")).startReports({
        dsn: config.sentryDsn,
        release: config.gitCommit ?? config.appVersion,
      })
    : undefined;
  const logger = createLogger(config.logLevel, hooks.destination, reports?.write);
  // With reports on, the last ones leave before the process does, for at most a second.
  const exit = (code: number) => {
    if (!reports) return hooks.exit(code);
    const done = () => hooks.exit(code);
    void reports.flush(REPORTS_FLUSH_MS).then(done, done);
  };
  // A bug that escapes every handler: one fatal line, then exit 1 for the orchestrator to
  // restart the container. Continuing would run on an unknown state.
  hooks.onCrash((crash, error) => {
    logger.fatal({ err: error, crash }, "crashed");
    exit(1);
  });
  const staticDir = config.staticDir ? resolve(config.staticDir) : DEFAULT_STATIC_DIR;
  if (!existsSync(join(staticDir, "index.html"))) {
    logger.warn({ staticDir }, "web app not built: serving the API only");
  }

  // The signal handlers come before `setup`: with Node as PID 1 a SIGTERM nobody handles
  // is ignored, and a start waiting on the database would keep the container up. A signal
  // while starting aborts `setup`; once `run()` is past it, it stops the way it started.
  const timeoutMs = hooks.shutdownTimeoutMs ?? 10_000;
  const aborter = new AbortController();
  let stopping: Signal | undefined;
  let running = false;
  let startLimit: ReturnType<typeof setTimeout> | undefined;
  let setup: Setup = {};
  let server: PokerServer | undefined;
  hooks.onSignal((signal) => {
    if (stopping) {
      logger.info({ signal }, "shutdown: already in progress");
      return;
    }
    stopping = signal;
    if (running && server) {
      shutdown(server, signal);
      return;
    }
    startLimit = setTimeout(() => {
      logger.error({ timeoutMs }, "shutdown: timed out");
      exit(1);
    }, timeoutMs);
    startLimit.unref();
    aborter.abort();
  });
  const stoppedWhileStarting = (signal: Signal) => {
    clearTimeout(startLimit);
    logger.info({ signal }, "shutdown: stopped while starting");
    exit(0);
    return undefined;
  };

  if (hooks.setup) {
    try {
      setup = await hooks.setup(config, logger, aborter.signal);
    } catch (error) {
      if (stopping) return stoppedWhileStarting(stopping);
      logger.fatal({ err: error }, "setup failed");
      exit(1);
      return undefined;
    }
    if (stopping) {
      await setup.dispose?.().catch((disposeError: unknown) => {
        logger.error({ err: disposeError }, "dispose failed");
      });
      return stoppedWhileStarting(stopping);
    }
  }
  server = createServer(config, { ...setup.deps, logger, staticDir });
  let address: AddressInfo;
  try {
    address = await server.listen();
  } catch (error) {
    clearTimeout(startLimit);
    logger.fatal({ err: error, port: config.port }, "cannot listen");
    await server.io.close();
    await setup.dispose?.().catch((disposeError: unknown) => {
      logger.error({ err: disposeError }, "dispose failed");
    });
    exit(1);
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
  running = true;
  if (stopping) {
    // The signal came while listen() ran: stop now, through the normal path.
    clearTimeout(startLimit);
    shutdown(server, stopping);
  }
  return server;

  function shutdown(server: PokerServer, signal: Signal): void {
    logger.info({ signal }, "shutdown: started");
    const cut = setTimeout(() => {
      logger.warn("shutdown: closing the remaining connections");
      server.httpServer.closeAllConnections();
    }, timeoutMs - 2000);
    const fail = setTimeout(() => {
      logger.error({ timeoutMs }, "shutdown: timed out");
      exit(1);
    }, timeoutMs);
    cut.unref();
    fail.unref();
    const { beforeClose, dispose } = setup;
    // Without background work the server stops accepting connections at once.
    const closed = beforeClose
      ? beforeClose()
          .catch((error: unknown) => {
            // The server still closes: background work that failed to stop is no reason
            // to keep the sockets open.
            logger.error({ err: error }, "shutdown: background work did not stop");
          })
          .then(() => server.close())
      : server.close();
    closed
      .then(async () => {
        if (!dispose) return;
        await dispose();
        logger.info("shutdown: resources released");
      })
      .then(
        () => {
          clearTimeout(cut);
          clearTimeout(fail);
          logger.info("shutdown: done");
          exit(0);
        },
        (error: unknown) => {
          clearTimeout(cut);
          clearTimeout(fail);
          logger.error({ err: error }, "shutdown: failed");
          exit(1);
        },
      );
  }
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
