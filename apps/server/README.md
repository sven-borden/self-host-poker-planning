# @pp/server

The Node server: Hono for `/api/*` and the built web app, Socket.IO for the room channel,
both on one Node HTTP server; Better Auth (#10) and Drizzle (#7) plug in next. It owns
every round and, in production, serves the built web app.

## Layout

- `src/main.ts`: the only start path. Calls `run(process.env, …)` with the process hooks.
- `src/run.ts`: validates the config, logs, listens, installs the SIGTERM/SIGINT handler
  and exits. A bad config logs one line naming the variables and exits 1.
- `src/config.ts`: `loadConfig(env)`, zod-validated and frozen; `ConfigError` never
  carries a value.
- `src/logger.ts`: `createLogger(level, destination?)`, pino JSON on stdout.
- `src/app.ts`: `createApp(config, deps)`, the Hono app: request ids and logs,
  `/api/health`, the hooks for more API routes, the JSON `/api` 404, the web app.
- `src/realtime.ts`: `createRealtime(httpServer, options)`, Socket.IO typed with
  `@pp/protocol`'s event maps; parses every payload before a handler sees it.
- `src/server.ts`: `createServer(config, deps)` puts both on one HTTP server and returns
  `{ app, httpServer, io, listen(), close() }`.

## Rules

- Nothing opens a port, connects to the database or reads the environment at module
  load: modules export factories, `main.ts` calls `run()`.
- Never read, log or print a secret or a vote value. Log lines carry ids (request,
  connection, room code), never bodies, cookies, auth headers or query strings.
- The server answers with codes (`{ code: "not_found" }`, ack codes), never sentences.
- Socket payloads are `unknown` at runtime: `parseEnter` and `toDomainCommand` run on
  every message, junk answers `bad_payload`, a missing ack callback is fine, a throwing
  handler answers `internal`. Messages are capped at 16 KB.
- `pnpm dev` runs `tsx watch` with `--env-file-if-exists=../../.env` (copy the root
  `.env.example`). Without a database the server still starts until #7.
- `pnpm build` bundles `src/main.ts` with tsdown into `dist/main.mjs`. The `@pp/*`
  workspace packages are bundled in (they ship TypeScript source); npm dependencies stay
  external, so the Docker image installs production dependencies next to `dist/`.
  `pnpm start` runs the bundle with plain Node 24 and `--enable-source-maps`, so stack
  traces point at the TypeScript source. It reads no `.env`.
- The web app is served from `STATIC_DIR`, else `apps/web/dist` resolved from the
  server's own folder (`src/` or `dist/`). Files under `assets/` are cached for a year,
  everything else is `no-cache`; dot-folders (`.vite/`) are never served; a path whose
  last segment has no dot falls back to `index.html`.
- Shutdown: stop accepting, close Socket.IO, wait for open requests; open connections
  are cut 2 s before the 10 s limit. One log line per phase.
- Tests use port 0 and close every server and socket they open (Vitest must exit on its
  own). `src/test-support.ts` collects log lines in memory.
- Import siblings with their `.ts` extension.
