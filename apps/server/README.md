# @pp/server

The Node server: Hono for `/api/*` and the built web app, Socket.IO for the room channel,
both on one Node HTTP server, Postgres through Drizzle, and guest identity through
Better Auth (#10). It owns every round and, in production, serves the built web app. The database
driver is node-postgres (`pg`) through drizzle's `node-postgres` driver.

## Layout

- `src/main.ts`: the only start path. Calls
  `run(process.env, { ...processHooks(process), setup: setupServer })`.
- `src/setup.ts`: `setupServer(config, logger, signal, tuning)`, the `setup` hook (`tuning`
  is for tests only: `presenceGraceMs`): `setupDatabase`,
  then `createAuth` on its pool; returns `deps` with `checkDb`, `registerApi` (auth
  routes, then the room API), `socketMiddleware` (the session) and `handlers` (the room
  sync), plus `database` and `auth`. `dispose` clears the deadline and presence timers,
  then ends the pool.
- `src/auth.ts`: identity. `createAuth(config, db, logger)` builds Better Auth (Drizzle
  adapter, anonymous plugin, options in `authOptions`); `registerAuthApi` mounts
  `/api/auth/*` and `POST /api/me/name`; `sessionMiddleware(auth)` is the socket
  handshake; `sessionUser(auth, headers)` resolves a cookie into a `SocketUser`
  (`{ id, name, isAnonymous }`) or null, and rejects when the database fails.
- `src/rooms.ts`: the room API (#14). `registerRoomApi(app, { auth, rooms, config,
  limiter, random? })` mounts `POST /api/rooms` and `GET /api/rooms/:code`;
  `insertNewRoom(store, { ownerId, name, deck }, random?)` stores a new room and draws
  the code again on a clash (`CODE_ATTEMPTS`, 5). `src/room-code.ts`: `generateRoomCode`
  (base58, rejection sampling); the shape (`isRoomCode`, `ROOM_CODE_PATTERN`) comes from
  `@pp/domain`, which the web app's join field shares.
- `src/rate-limit.ts`: `memoryRateLimit()`, the bounded fixed-window limiter, and its
  `RateLimiter` interface (`consume(key, { window, max })`). `src/http.ts`: what the
  app's own routes share: `foreignOrigin`, `isJsonBody`, `requestIp`, `rateLimited`.
- `src/run.ts`: validates the config, installs the SIGTERM/SIGINT handler, runs the
  `setup` hook, listens and exits. A signal during `setup` aborts it through the
  `AbortSignal` it receives, logs one line and exits 0. A bad config, a failed `setup` or a failed listen logs
  one fatal line and exits 1; so does an uncaught exception or unhandled rejection
  (`processHooks(process)` wires them). `setup(config, logger, signal)` resolves with
  `{ deps, dispose? }`: `deps` reach `createServer` (#7 `checkDb`, #10 `registerApi` and
  `socketMiddleware`, W1 `handlers`); `dispose` (#7: end the pool) runs after the server
  has closed and before exit, inside the 10 s limit.
- `src/config.ts`: `loadConfig(env)`, zod-validated and frozen; `ConfigError` never
  carries a value.
- `src/logger.ts`: `createLogger(level, destination?)`, pino JSON on stdout.
- `src/app.ts`: `createApp(config, deps)`, the Hono app: request ids and logs,
  `/api/health`, the hooks for more API routes, the JSON `/api` 404, the web app.
- `src/realtime.ts`: `createRealtime(httpServer, options)`, Socket.IO typed with
  `@pp/protocol`'s event maps; takes a token from the sender's bucket, one per person
  for all their sockets (`sync/token-bucket.ts`, 10 a second, bursts of 20, else
  `rate_limited`), then parses every payload before a handler sees it. A person holds at
  most `MAX_SOCKETS_PER_USER` (8) sockets; the next handshake gets `rate_limited`.
  `SocketData` holds `user`, `sessionId` and `room` (`{ id, code }`). Handlers may have
  `attach(io)` and `disconnect(socket)`. `drainRealtime(io, ms)` stops taking messages and
  waits for the answers owed.
- `src/sync/`: the realtime path of a room (#15), see "Rooms over the socket" below.
- `src/server.ts`: `createServer(config, deps)` puts both on one HTTP server and returns
  `{ app, httpServer, io, listen(), close() }`. `close()` stops accepting connections,
  drains the socket messages already taken (`DRAIN_TIMEOUT_MS`, 5 s), then closes the
  engine, so no ack is lost to a redeploy.
- `src/client-ip.ts`: `clientIp(request, config.trustProxy)`, the client address for the
  rate limits (architecture section 8). Takes a Node request (`c.env.incoming` in Hono,
  `socket.request` in Socket.IO). Never logged. It answers a key: an IPv4-mapped IPv6
  address as IPv4, any other IPv6 address as its /64 network.
- `src/database.ts`: `setupDatabase(config, logger, signal)`, the `setup` hook: waits
  for Postgres (30 s in all), takes the migration lock with `pg_try_advisory_lock`
  (60 s at most, a log line every 5 s), migrates on that one session
  (`lock_timeout` 10 s), opens the `pg` pool and returns
  `{ deps: { checkDb }, dispose, database }`. `database` holds `db` (Drizzle), `store`
  and `runner` for the hooks that build on it. `openDatabase(url, logger, options)` and
  `migrateDatabase(...)` are the same steps for tests.
- `src/db/schema.ts`: the tables `room` and `round_history` (architecture section 6).
- `src/db/auth-schema.ts`: Better Auth's tables `user` (with `is_anonymous`), `session`,
  `account` and `verification`, in the shape its Drizzle adapter checks at start.
- `src/db/rooms.ts`: `createRoomStore(db)`: `insertRoom`, `loadRoom`, `commitRoom` (the
  compare-and-set, with the history row of a revealed round in the same transaction).
- `src/db/runner.ts`: `createCommandRunner(store)`: `run(code, step)`, the per-room
  queue, reload and retry on a lost commit (3 retries, then `conflict`), no write when
  the step returns the loaded state itself.
- `src/db/history.ts`: `historyRow(roomId, ended)`, pure: named rounds keep who, name
  and card; anonymous rounds the cards alone, in display order.
- `src/db/errors.ts`: `guard(step, call)` and `DatabaseError`: a database failure is
  reduced to its code, so no driver message, SQL parameter or connection detail reaches
  a log.
- `drizzle/`: the generated SQL migrations and drizzle-kit's snapshots; `drizzle.config.ts`
  points drizzle-kit at the schema.

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
  `.env.example`). It needs a Postgres at `DATABASE_URL` (see below); without one it
  retries for 30 s and exits 1.
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

## Rooms over the socket

`createRoomSync({ runner, store, logger, sessionAlive })` (`src/sync/room-sync.ts`) is the
`handlers` of `createRealtime`.

- `enter { code, protocol }`: checks the session again (`sessionChecker`: a socket outlives
  a sign-out), joins the Socket.IO room `room:<id>` (never the code) **before** loading
  when the id is known here, else loads, joins and loads again (so no commit is missed),
  records `socket.data.room` once every check passed and answers the viewer's
  `toSnapshot`. A socket's enters run one after the other; a failed one leaves the channel
  it joined; one whose socket disconnected mid-way stops. Logs name the room by its id. A stranger
  gets a snapshot with `you: null`. Refusals: `protocol_mismatch` (from `parseEnter`),
  `room_not_found`, `unauthenticated`; a database failure answers `internal`.
- `cmd { id, type, payload }`: `runner.run(code, state => apply(state, command, { actor:
  user.id, now }))`. The flow of every command, and what to keep when adding one:
  1. The person's bucket, then `toDomainCommand` (`bad_payload`). A command sent during
     an `enter` waits for it.
  2. No entered room: `room_not_found`. A session last checked over a minute ago is
     checked again; gone: `unauthenticated`, and the connection closes.
  3. `ackKey(roomId, id)` in the person's `RecentAcks` (100 per person, 1000 people): the
     same id gets the same answer (also while it runs) and runs once. `busy` and a thrown step are forgotten,
     so the same id may run again. Process memory only: a restart forgets it.
  4. Success: every socket of the room gets its own snapshot with the projected
     `causes`, **then** the ack `{ ok: true, version }`. A refusal acks the domain code;
     if the runner still stored something (a timer reveal resolved first), that is
     broadcast too. A `kicked` cause sends `kicked` to the person's sockets and closes them.
  5. Runner `conflict` (every retry lost the compare-and-set to another instance; nothing
     stored): `busy`, retryable with the same id. `DatabaseError` (a commit may have
     landed): reload the room, broadcast it, ack `internal`; never run it again.
- Each socket remembers the version it holds: nobody gets the same or an older version
  twice, and a reload that finds nothing new sends nothing. An unchanged run whose loaded
  version is newer than what a socket holds (another instance wrote it) is sent without
  causes, so a room on two instances catches up on the next command or deadline.
- Deadlines (`sync/deadlines.ts`): one timeout per room with a voting round's
  `deadlineAt` and at least one socket on this instance, re-armed after every broadcast and
  enter, cleared when the round changes or the last socket leaves. It runs `timeUp` (any
  actor, `SERVER_ACTOR`) through the runner: `apply` resolves the deadline, the
  compare-and-set makes two instances reveal once.
- Presence (#17, `sync/presence.ts` for the timers): connected while one of the person's
  sockets has entered the room here (`isHere`). The last one leaving starts a grace
  (`PRESENCE_GRACE_MS`, 15 s; `presenceGraceMs` in tests) for that person and room, unless
  the room's last socket left (then `forgetIfEmpty` drops every timer of the room) or the
  person is not a participant of the newest state seen (`members`). An entering socket
  of a participant cancels its person's grace and always runs the back step
  (`backStep`), which sends `presence { connected: true }` only when the stored state
  shows them away: the enter's own load may predate an away run that committed since,
  and for someone shown connected it stores nothing. The grace's end runs
  `presence { connected: false }`. Both steps decide inside the runner, at their turn in
  the room's queue, from the stored state and the sockets actually here (`runAsServer`
  hands the step the state; it may return null). An away run that fails (a database
  error, or every attempt lost the compare-and-set) starts the grace again, at most
  `MAX_AWAY_RETRIES` (3) times in a row (`awayFailures`); a return ends the series. The
  room's first socket on this instance (`watched`) starts a grace of
  `PRESENCE_RESTART_GRACE_MS` (60 s; `presenceRestartGraceMs` in tests) for everyone
  shown connected without a socket here: the restart case, where every client
  reconnects at once. `close()` drops every timer and starts no new one. Log lines:
  "presence: away", "presence: back" and "presence: away given up" with the room's id,
  never a name.
- A server-only command needs no new path: add it to the domain's `Command` (and to
  `ServerCommandType`, so the wire union leaves it out and `toDomainCommand` refuses it
  from a client) and to `OPEN` if non-participants may send it, then run it with
  `runAsServer` in `room-sync.ts`, as `timeUp` and `presence` are.
- Logs hold the room code, the command type, versions and codes: never a payload, a card
  or a snapshot.
- Tests: `room-sync.test.ts` on an in-memory store (`sync/test-support.ts`:
  `memoryRoomStore` with commit fates, `fakeIdentity`, a `testClient` that keeps raw
  frames); `room-sync.db.test.ts` with real guests on Postgres (join latency, the burst,
  secrecy on raw frames with `@pp/protocol/leak-scan`, two instances);
  `presence.db.test.ts` (the grace, a reload inside it, coming back, the round settled by
  someone going away, the restart case and its longer grace, presence frames through the
  leak scan, and no name or code in the logs); `presence-races.db.test.ts` (an enter
  whose load read the room before an away run committed, with a held load; failed away
  runs retried and the bound, with a runner that fails on demand); `presence.test.ts`
  (the timers, fake clock);
  `restart.db.test.ts` runs the built `dist/main.mjs` (build it first; CI does).

## Identity

- Who is behind a socket: `socket.data.user` (`SocketUser`: `id`, `name`, `isAnonymous`),
  set by `sessionMiddleware` before `connection` fires. A socket without a valid session
  never connects (`connect_error` `unauthenticated`). It is optional in `SocketData`
  only because tests run servers without identity: the room sync answers
  `unauthenticated` when it is missing. `socket.data.sessionId` is the session's id
  (never its token), checked again on every `enter`. Over HTTP, `sessionUser(auth, c.req.raw.headers)`.
- `user.name` is `""` until the person picks one; `POST /api/me/name` sets it through
  the domain's `cleanName`, rate limited per user and per address. Never write
  `user.name` another way.
- Only `AUTH_ROUTES` (get-session, sign-in/anonymous, sign-out) reach Better Auth; add
  an endpoint there only after checking what it returns (no tokens) and what it lets a
  client change. Cookie names come from `cookieNaming` (`__Host-pp.*` on https).
- Client address for a rate limit: `clientIp(request, config.trustProxy)`, where
  `trustProxy` counts the proxies (`TRUST_PROXY`). Better Auth gets the same address in
  `x-pp-client-ip` (`CLIENT_IP_HEADER`), set by `registerAuthApi` after dropping the
  client's copy; its own `X-Forwarded-For` reading is not used.
- `setupServer` creates one limiter (`memoryRateLimit`, bounded) for Better Auth,
  `/api/me/name` and room creation: Better Auth's own memory store is shared by the
  whole process. Keys start with their purpose (`rename|…`, `rooms|create|…`).
- A POST route of the app's own checks `foreignOrigin` (403 `not_allowed`) and
  `isJsonBody` (415 `bad_payload`) first, and counts its rate limit before reading the
  session, so a flood costs no query.
- Never log a cookie, a session token or `config.betterAuthSecret`, nor any error from
  Better Auth or the driver: their messages can hold a token. Better Auth's logger goes
  to pino with a fixed message and at most its error code, `onAPIError.throw` stops it
  and better-call from printing, and thrown errors are logged by `errorCode` only.
  `auth.db.test.ts` captures console, stdout and stderr and greps them and the logs for
  the fake secret and every token it saw.
- Better Auth's answers become the app's codes in `registerAuthApi` (`authErrorCode`),
  and `withoutTokens` drops every `token` field from its JSON.

## Rooms

- `POST /api/rooms` (session, this origin, JSON): body `{ name?, deck? }`, strict, `deck`
  one of `PRESET_DECK_IDS` (Fibonacci without one). `name` goes through the domain's
  `cleanRoomName` (1 to 60 characters). The state is `createRoom({ ownerId })` with the
  deck; the caller is the PO in `live` and in `owner_user_id`; `name` has its own column.
  Answers 201 `{ code }`, or `{ code }` with an `AckErrorCode`: 401 `unauthenticated`,
  403 `not_allowed`, 400, 413 or 415 `bad_payload`, 400 `bad_room_name`, 429 `rate_limited`
  (`Retry-After`), 500 `internal` (five codes in a row taken, or the database).
- `GET /api/rooms/:code` (no session): 200 `{ code, name }`, never the state; 404
  `room_not_found` for an unknown or a malformed code (no query then), with
  `retentionDays` (`ROOM_TTL_DAYS`) for the not-found page.
- `ROOM_CREATE_LIMIT`: 20 creations per client address in 10 minutes.
  `ROOM_HEADER_LIMIT`: 120 header reads per client address and minute, counted before the
  query.
- A room code is a bearer capability: it never reaches a log line, an error message,
  Sentry or Umami; logs name a room by its id. The request log writes the matched route,
  or for a path that matched only a wildcard the normalised path of `loggedPath` (the
  segment after `/r` or `/api/rooms` and any code-shaped segment become `:code`, case
  and `//` ignored); `app.test.ts` and `rooms.db.test.ts` grep the logs.

## Database

- Change the schema in `src/db/schema.ts`, then generate a migration with a name that
  says what it does: `pnpm --filter @pp/server db:generate --name add_room_brand`. Commit
  the SQL and the `meta/` files together; never edit an applied migration. Run
  `pnpm format` afterwards if Biome reflows the JSON. Migrations are additive and safe on
  a live database mid-deploy: a new column is nullable or has a default; nothing is
  renamed or dropped while an older instance may still run.
- The server applies pending migrations at every start, before it listens. The folder is
  `apps/server/drizzle`, found from `src/` (tsx) and from `dist/` (bundle); the Docker
  image copies it next to `dist/` or sets `MIGRATIONS_DIR`.
- `live` is the room's whole state and changes only through `apply` and
  `runner.run(code, step)` (or `store.commitRoom` with the version it loaded). Never
  write `live` directly, never put the password hash in it.
- Only `guard`ed calls touch the database: log `DatabaseError`s, never a driver error.
- Every `pg` client needs an `error` listener, including one checked out of the pool for
  a transaction: `pg` emits `error` when its backend dies, and an unhandled one crashes
  the process. The pool in `openDatabase` adds one to every client it opens; a client
  made elsewhere (a test, a script) adds its own. `db/connection-loss.db.test.ts` checks
  it.
- drizzle orders migrations by the journal's `when`, not by hash: it applies an entry
  only when its `when` is newer than the newest applied one. After merging main into a
  branch that adds a migration, delete your migration (the SQL file, its snapshot and
  its journal entry) and generate it again, so it comes last with the newest `when`.
  Never merge `_journal.json` by hand. `db/journal.test.ts` fails on a `when` that does
  not increase with `idx`, or on an entry without its SQL file.

### Local Postgres for `pnpm test:db`

The `*.db.test.ts` files run against a real Postgres 17 (CI has a service). Each test
file creates its own database and drops it at the end, so the user needs `CREATEDB`, and
`connection-loss.db.test.ts` creates a role, so `CREATEROLE` too (the image's superuser
has both). `auth.db.test.ts` covers identity: the cookie, same and different users, the
name rules, the rate limit, refused and accepted sockets, a backend terminated mid
sign-in, and logs free of secrets. With Docker (Git Bash needs `MSYS_NO_PATHCONV=1` in front):

```sh
docker run --rm -d --name pp-postgres -p 55432:5432   -e POSTGRES_USER=pp -e POSTGRES_PASSWORD=pp -e POSTGRES_DB=pp_test postgres:17
DATABASE_URL=postgres://pp:pp@localhost:55432/pp_test pnpm test:db
docker stop pp-postgres
```

The same container serves `pnpm dev` with that `DATABASE_URL` in `.env`.
