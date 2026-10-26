/**
 * The HTTP side: `/api/*` and the built web app. `createApp` opens nothing; `createServer`
 * (server.ts) mounts the app on a Node HTTP server next to Socket.IO.
 */
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join, sep } from "node:path";
import { serveStatic } from "@hono/node-server/serve-static";
import { type Context, Hono } from "hono";
import type { Config } from "./config.ts";
import type { Logger } from "./logger.ts";

export interface AppEnv {
  Variables: {
    /** Correlates every log line of one HTTP request; echoed in `x-request-id`. */
    requestId: string;
    log: Logger;
    /** Set by the web app's static handler: the file it served (internal). */
    staticFile?: string;
  };
}

export type DbStatus = "ok" | "error";

export interface AppDeps {
  logger: Logger;
  /**
   * Pings the database for `/api/health` (#7). Without it `db` reports `"unchecked"`.
   * A rejection counts as `"error"`.
   */
  checkDb?: () => Promise<DbStatus>;
  /**
   * Adds API routes (Better Auth under `/api/auth/*` in #10, rooms in W1). Called before
   * the `/api/*` 404, so every route registered here wins over it.
   */
  registerApi?: (app: Hono<AppEnv>) => void;
  /** Absolute folder of the built web app; nothing is served when it has no index.html. */
  staticDir?: string;
  /** Seconds since start, for `/api/health`. Defaults to `process.uptime`. */
  uptime?: () => number;
}

/** An incoming `x-request-id` is kept only when it is short and harmless in a log line. */
const SAFE_REQUEST_ID = /^[\w.:-]{1,64}$/;

const IMMUTABLE = "public, max-age=31536000, immutable";
const REVALIDATE = "no-cache";

export function createApp(config: Config, deps: AppDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const uptime = deps.uptime ?? process.uptime;

  app.use("*", async (c, next) => {
    const incoming = c.req.header("x-request-id");
    const requestId = incoming && SAFE_REQUEST_ID.test(incoming) ? incoming : randomUUID();
    const log = deps.logger.child({ requestId });
    c.set("requestId", requestId);
    c.set("log", log);
    const started = performance.now();
    await next();
    c.header("x-request-id", requestId);
    c.header("X-Content-Type-Options", "nosniff");
    // Path only: the query string may carry anything, and bodies, cookies and auth
    // headers are never logged.
    const line = {
      method: c.req.method,
      path: c.req.path,
      status: c.res.status,
      ms: Math.round(performance.now() - started),
    };
    if (c.res.status >= 500) log.error(line, "request failed");
    else if (c.req.path.startsWith("/api/") && c.req.path !== "/api/health")
      log.info(line, "request");
    else log.debug(line, "request");
  });

  app.onError((error, c) => {
    c.var.log.error({ err: error }, "unhandled error");
    return c.json({ code: "internal" }, 500);
  });
  app.notFound((c) => c.json({ code: "not_found" }, 404));

  app.get("/api/health", async (c) => {
    const db = deps.checkDb ? await deps.checkDb().catch((): DbStatus => "error") : "unchecked";
    c.header("Cache-Control", "no-store");
    return c.json(
      {
        status: db === "error" ? "error" : "ok",
        version: config.appVersion ?? "dev",
        commit: config.gitCommit ?? "unknown",
        db,
        uptime: Math.floor(uptime()),
      },
      db === "error" ? 503 : 200,
    );
  });

  deps.registerApi?.(app);

  // Anything else under /api is a JSON 404, never the web app.
  app.all("/api", (c) => c.notFound());
  app.all("/api/*", (c) => c.notFound());

  if (deps.staticDir && existsSync(join(deps.staticDir, "index.html"))) {
    mountWebApp(app, deps.staticDir);
  }
  return app;
}

/**
 * Serves the built web app. Files under `assets/` carry a content hash in their name and
 * are cached for a year; everything else (`index.html`, `theme-init.js`, the favicon) is
 * revalidated on every load. A GET for a path whose last segment has no dot gets
 * `index.html` (history fallback, so `/r/:code` works on reload); a missing file with an
 * extension is a 404, so a stale asset URL never receives HTML.
 */
function mountWebApp(app: Hono<AppEnv>, root: string): void {
  const assets = join(root, "assets") + sep;
  // serveStatic builds its response before `onFound` runs, so a header set there is lost:
  // remember the file and set Cache-Control once the response exists.
  app.use("*", async (c, next) => {
    await next();
    const file = c.get("staticFile");
    if (file) c.header("Cache-Control", file.startsWith(assets) ? IMMUTABLE : REVALIDATE);
  });
  const remember = (path: string, c: Context<AppEnv>) => c.set("staticFile", path);
  app.use("*", serveStatic<AppEnv>({ root, onFound: remember }));
  const index = serveStatic<AppEnv>({ root, path: "index.html", onFound: remember });
  app.use("*", (c, next) => {
    const last = c.req.path.slice(c.req.path.lastIndexOf("/") + 1);
    return last.includes(".") ? next() : index(c, next);
  });
}
