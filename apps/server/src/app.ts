/**
 * The HTTP side: `/api/*` and the built web app. `createApp` opens nothing; `createServer`
 * (server.ts) mounts the app on a Node HTTP server next to Socket.IO.
 */
import { randomUUID } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { join, sep } from "node:path";
import { serveStatic } from "@hono/node-server/serve-static";
import { type Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
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
  /** How long `/api/health` waits for `checkDb` before it reports `"error"`. */
  dbCheckTimeoutMs?: number;
}

/** A hung pool must not hang the Docker HEALTHCHECK: the check gives up after this. */
export const DB_CHECK_TIMEOUT_MS = 2000;

/**
 * Body cap of every `/api/*` request: nothing the API takes comes close (identity routes
 * cap theirs lower). A bigger body is refused with `bad_payload` before anyone reads it.
 */
export const API_BODY_LIMIT_BYTES = 16 * 1024;

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
    // Path only, without a room code (a bearer capability, like a session token): the
    // query string may carry anything, and bodies, cookies and auth headers are never
    // logged.
    const line = {
      method: c.req.method,
      path: loggedPath(c.req.path, c.req.routePath),
      status: c.res.status,
      ms: Math.round(performance.now() - started),
    };
    if (c.res.status >= 500) log.error(line, "request failed");
    else if (c.req.path.startsWith("/api/") && c.req.path !== "/api/health")
      log.info(line, "request");
    else log.debug(line, "request");
  });

  // Error answers are never cached: a CDN must not keep a 404 for an asset that a deploy
  // in progress is about to serve.
  app.onError((error, c) => {
    c.var.log.error({ err: error }, "unhandled error");
    c.header("Cache-Control", "no-store");
    return c.json({ code: "internal" }, 500);
  });
  app.notFound((c) => {
    c.header("Cache-Control", "no-store");
    return c.json({ code: "not_found" }, 404);
  });

  const checkDb = deps.checkDb;
  const dbCheckTimeoutMs = deps.dbCheckTimeoutMs ?? DB_CHECK_TIMEOUT_MS;
  app.get("/api/health", async (c) => {
    const db = checkDb ? await withTimeout(checkDb, dbCheckTimeoutMs) : "unchecked";
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

  app.use(
    "/api/*",
    bodyLimit({
      maxSize: API_BODY_LIMIT_BYTES,
      onError: (c) => {
        c.header("Cache-Control", "no-store");
        return c.json({ code: "bad_payload" }, 413);
      },
    }),
  );
  deps.registerApi?.(app);

  // Anything else under /api is a JSON 404, never the web app.
  app.all("/api", (c) => c.notFound());
  app.all("/api/*", (c) => c.notFound());

  if (deps.staticDir && existsSync(join(deps.staticDir, "index.html"))) {
    mountWebApp(app, deps.staticDir);
  }
  return app;
}

/** A room code's shape in any case: 10 letters and digits, which no static route has. */
const CODE_SHAPED = /^[0-9a-z]{10}$/i;
/** The routes whose next segment is a room code, in lower case. */
const ROOM_ROUTES: readonly string[] = ["r", "api/rooms"];

/**
 * A request path as it is logged. A room code is a bearer capability: it never reaches a
 * log (a room is named by its id). Where a route matched, its pattern is logged
 * (`/r/:code`), never the raw path. The web app's history fallback and the 404 match
 * only a wildcard, so the raw path is normalised instead: percent-encoding decoded, `//`
 * collapsed, the trailing slash dropped, and the segment after `/r` or `/api/rooms` (any
 * case) and every code-shaped segment (anywhere, any case) becomes `:code`.
 */
export function loggedPath(path: string, route?: string): string {
  if (route && !route.includes("*")) return route;
  let decoded = path;
  // A few passes, so `%2550` cannot hide a code behind a double encoding.
  for (let pass = 0; pass < 3; pass++) {
    try {
      decoded = decodeURIComponent(decoded);
    } catch {
      break;
    }
  }
  const segments = decoded.split("/").filter((segment) => segment !== "");
  const logged = segments.map((segment, index) =>
    ROOM_ROUTES.includes(segments.slice(0, index).join("/").toLowerCase()) ||
    CODE_SHAPED.test(segment)
      ? ":code"
      : segment,
  );
  return `/${logged.join("/")}`;
}

/** Runs the database check; a rejection or no answer within `ms` counts as `"error"`. */
async function withTimeout(check: () => Promise<DbStatus>, ms: number): Promise<DbStatus> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<DbStatus>((resolve) => {
    timer = setTimeout(() => resolve("error"), ms);
  });
  try {
    return await Promise.race([check().catch((): DbStatus => "error"), timedOut]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Every plain file under `root`, as the URL path that serves it (`/assets/index-x.js`).
 * Entries whose name starts with a dot are skipped with everything below them (Vite
 * writes its manifest to `.vite/`); so are symbolic links.
 */
export function listStaticFiles(root: string): Set<string> {
  const files = new Set<string>();
  const walk = (dir: string, prefix: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue;
      const path = `${prefix}/${entry.name}`;
      if (entry.isDirectory()) walk(join(dir, entry.name), path);
      else if (entry.isFile()) files.add(path);
    }
  };
  walk(root, "");
  return files;
}

/**
 * Serves the built web app. The folder is listed once, here: a request is served from
 * disk only when its path is exactly one of the listed files. Any other spelling of a
 * file (another case, a Windows 8.3 short name such as `/VITE~1/manifest.json`, a
 * trailing dot, an alternate data stream) and any file added later is never served. The
 * folder is immutable in the image; in development, restart the server after rebuilding
 * `apps/web/dist`.
 *
 * Files under `assets/` carry a content hash in their name and are cached for a year;
 * everything else (`index.html`, `theme-init.js`, the favicon) is revalidated on every
 * load. A GET for a path whose last segment has no dot gets `index.html` (history
 * fallback, so `/r/:code` works on reload); a missing file with an extension is a 404,
 * so a stale asset URL never receives HTML.
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
  const allowed = listStaticFiles(root);
  const files = serveStatic<AppEnv>({ root, onFound: remember });
  app.use("*", (c, next) => (allowed.has(c.req.path) ? files(c, next) : next()));
  const index = serveStatic<AppEnv>({ root, path: "index.html", onFound: remember });
  app.use("*", (c, next) => {
    const last = c.req.path.slice(c.req.path.lastIndexOf("/") + 1);
    return last.includes(".") ? next() : index(c, next);
  });
}
