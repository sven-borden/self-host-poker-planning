# @pp/server

The Node server: Hono for `/api/*` and the built web app, Socket.IO for the room channel,
both on one Node HTTP server; Better Auth (#10) and Drizzle (#7) plug in next. It owns
every round and, in production, serves the built web app.

## Layout

- `src/main.ts`: the only start path. Calls `run(process.env, processHooks(process))`.
- `src/run.ts`: validates the config, runs the `setup` hook, listens, installs the
  SIGTERM/SIGINT handler and exits. A bad config, a failed `setup` or a failed listen logs
  one fatal line and exits 1; so does an uncaught exception or unhandled rejection
  (`processHooks(process)` wires them). `setup(config, logger)` resolves with
  `{ deps, dispose? }`: `deps` reach `createServer` (#7 `checkDb`, #10 `registerApi` and
  `socketMiddleware`, W1 `handlers`); `dispose` (#7: end the pool) runs after the server
  has closed and before exit, inside the 10 s limit.
- `src/config.ts`: `loadConfig(env)`, zod-validated and frozen; `ConfigError` never
  carries a value.
- `src/logger.ts`: `createLogger(level, destination?)`, pino JSON on stdout.
- `src/app.ts`: `createApp(config, deps)`, the Hono app: request ids and logs,
  `/api/health`, the hooks for more API routes, the JSON `/api` 404, the web app.
- `src/realtime.ts`: `createRealtime(httpServer, options)`, Socket.IO typed with
  `@pp/protocol`'s event maps; parses every payload before a handler sees it.
- `src/server.ts`: `createServer(config, deps)` puts both on one HTTP server and returns
  `{ app, httpServer, io, listen(), close() }`.
- `src/client-ip.ts`: `clientIp(request, config.trustProxy)`, the client address for the
  rate limits (architecture section 8). Takes a Node request (`c.env.incoming` in Hono,
  `socket.request` in Socket.IO). Never logged.

## Rules

- Nothing opens a port, connects to the database or reads the environment at module
  load: modules export factories, `main.ts` calls `run()`.
- Never read, log or print a secret or a vote value. Log lines carry ids (request,
  connection, room code), never bodies, cookies, auth headers, query strings or client
  addresses. The logger also redacts cookies, auth headers and `auth` payloads of an
  object logged whole (a handshake), as a second line of defence.
- The server answers with codes (`{ code: "not_found" }`, ack codes), never sentences.
- Socket payloads are `unknown` at runtime: `parseEnter` and `toDomainCommand` run on
  every message, junk answers `bad_payload`, a missing ack callback is fine, a throwing
  handler answers `internal`. Messages are capped at 16 KB. A handshake middleware may be
  async; a throw or a rejection refuses the socket with `internal` and logs one line.
- Socket.IO accepts a handshake only without an `Origin` header (a non-browser client) or
  with `Origin` equal to `BASE_URL`'s origin, on both transports (`allowRequest`). So
  `pnpm dev` needs `BASE_URL=http://localhost:5173` (Vite forwards the Origin unchanged);
  the built server on its own needs `BASE_URL=http://localhost:3000`.
- `pnpm dev` runs `tsx watch` with `--env-file-if-exists=../../.env` (copy the root
  `.env.example`). Without a database the server still starts until #7.
- `pnpm build` bundles `src/main.ts` with tsdown into `dist/main.mjs`. The `@pp/*`
  workspace packages are bundled in (they ship TypeScript source); npm dependencies stay
  external, so the Docker image installs production dependencies next to `dist/`.
  `pnpm start` runs the bundle with plain Node 24 and `--enable-source-maps`, so stack
  traces point at the TypeScript source. It reads no `.env`.
- The web app is served from `STATIC_DIR`, else `apps/web/dist` resolved from the
  server's own folder (`src/` or `dist/`). The folder is listed once at start, skipping
  dot entries (`.vite/`) and symbolic links, and only a request for exactly a listed path
  reaches the disk: no other case, Windows short name or trailing dot. After rebuilding
  `apps/web/dist` while the server runs, restart it (`tsx watch` does not watch `dist`):
  new hashed assets answer 404 until then. Files under `assets/` are cached for a year,
  everything else is `no-cache`; a path whose last segment has no dot falls back to
  `index.html`. JSON 404 and 500 answers carry `Cache-Control: no-store`.
- `/api/health` waits at most 2 s for `checkDb`, then reports `db: "error"` with a 503.
- Shutdown: stop accepting, drop every socket (clients see `transport close` and
  reconnect), wait for open requests, then the `dispose` of `setup`; open connections are
  cut 2 s before the 10 s limit. One log line per phase, written when it has happened.
- `pnpm --filter @pp/server test` runs the `server` project of the root Vitest config;
  every package has the same `test` script.
- Tests use port 0 and close every server and socket they open (Vitest must exit on its
  own). `src/test-support.ts` collects log lines in memory.
- Import siblings with their `.ts` extension.
