# Poker Planning

Self-hosted planning poker for teams: rooms of up to 16 people around a table, no
account needed, one Docker image to run on Coolify, Azure or any Docker host. In
English, French and German.

> **Status:** design and architecture done; building wave W0. See
> [docs/STATUS.md](docs/STATUS.md).

## What it does

- Create a room, share the link, protect it with a password if you like.
- Vote with Fibonacci, T-shirt, powers of two or your own deck, plus `?` and `☕` cards.
- The product owner reveals, or the room reveals when everyone has voted or the timer
  ends. Results show who voted what, or stay anonymous.
- Average, median, agreement and spread after every round; history and exports.
- Later: Google and Microsoft sign-in, Jira and Azure DevOps import, animated avatars,
  and paid branding for companies.

## Docs

- [Product brief](docs/01-product-brief.md)
- [Architecture](docs/02-architecture.md)
- [Design brief](docs/03-design-brief.md)
- [Open questions](docs/04-open-questions.md)
- [Decisions (ADR)](docs/05-decisions.md)
- [Status](docs/STATUS.md)

## Self-hosting

One Docker image serves the web app, the API and the WebSocket on port 3000; it needs a
Postgres 17 database. `compose.yaml` runs both. You need Docker with Compose v2.

```sh
git clone https://github.com/sven-borden/self-host-poker-planning.git && cd self-host-poker-planning
cat > .env <<EOF
POSTGRES_PASSWORD=$(openssl rand -hex 24)
BETTER_AUTH_SECRET=$(openssl rand -base64 32)
BASE_URL=http://localhost:3000
EOF
docker compose up -d --build
```

Then open exactly the `BASE_URL`, http://localhost:3000: the server refuses a WebSocket
from any other address, so `127.0.0.1:3000` loads the page but cannot join a room. Do not
copy `.env.example` for this: it is the template for local development, and compose
refuses to start while `BETTER_AUTH_SECRET` is empty.

Variables compose reads from `.env` (the full list is in
[architecture, section 12](docs/02-architecture.md#12-deployment)):

| Variable | Required | Meaning |
|---|---|---|
| `POSTGRES_PASSWORD` | yes | password of the bundled Postgres; letters and digits only (`openssl rand -hex 24`) |
| `BETTER_AUTH_SECRET` | yes | signs session cookies; `openssl rand -base64 32`; changing it signs everybody out |
| `BASE_URL` | yes | the address people open, such as `http://localhost:3000` or `https://poker.example.com` |
| `TRUST_PROXY` | no (`false`) | number of reverse proxies in front that append `X-Forwarded-For` (`true` = 1, `false` = 0, up to 10); count only proxies no client can bypass, or clients can fake their address |
| `LOG_LEVEL`, `ROOM_TTL_DAYS` | no | logging (`info`) and days before an idle room is deleted (`90`) |
| `GIT_COMMIT`, `APP_VERSION` | no | build arguments shown by `/api/health` |
| `CSP_REPORT_ONLY` | no (`false`) | `true` reports Content Security Policy violations in the browser console instead of blocking them (see "Security") |
| `CSP_EXTRA_SOURCES` | no | origins your own additions load from, such as `script-src https://stats.example.com` (see "Security") |
| `SENTRY_DSN` | no | turns on error reports to Sentry (or GlitchTip) from the server and the page, such as `https://0123abcd@o0.ingest.sentry.io/0` (see "Privacy") |
| `UMAMI_URL`, `UMAMI_WEBSITE_ID` | no | turn on page views in Umami: its address, such as `https://stats.example.com` (or its tracker's URL if you renamed `script.js`), and the website's id; both or neither (see "Privacy") |

Compose refuses to start while a required variable is empty. `DATABASE_URL` is built
from the bundled database; to use your own Postgres, run the image alone with
`DATABASE_URL`, `BETTER_AUTH_SECRET` and `BASE_URL` set (`docker build -t poker-planning .`).

- **Behind a reverse proxy** (Traefik, nginx, Caddy): proxy everything to port 3000 and
  let WebSocket upgrades through (`Upgrade` and `Connection` headers on `/socket.io/`),
  set `BASE_URL` to the public `https://` origin and `TRUST_PROXY=true`, with port 3000
  reachable only through the proxy. With two proxies in a row, the first one must be a
  trusted peer of the second (Traefik: `forwardedHeaders.trustedIPs`), or the second
  deletes `X-Forwarded-For` and the app sees only the first proxy's address; once it
  trusts the first, set `TRUST_PROXY=2`. Count right: the rate limits are per client
  address, and with too low a count every visitor shares one, so ten wrong room passwords
  from anyone lock everyone out of that room for ten minutes.
- **Coolify** (build pack Dockerfile, port 3000): in the application's settings
  - turn on "Advanced > Build > Source commit availability: Available during build",
    otherwise `/api/health` reports `commit: unknown`;
  - set "Build arguments" to "Managed manually in Dockerfile" (no injected build
    arguments), and for `DATABASE_URL` and `BETTER_AUTH_SECRET` uncheck "Available at
    Buildtime": a build argument in scope of a `RUN` stays readable in `docker history`.
    The Dockerfile declares no `ARG` that could carry a secret, so keep secrets at runtime;
  - leave Coolify's own HTTP health check off: it runs curl or wget inside the container
    and the image has neither. The image's `HEALTHCHECK` is used;
  - add a Postgres 17 database resource (not public, with a daily backup) and set
    `DATABASE_URL` to its internal URL;
  - with Coolify's GitHub App as the source, every push to `main` deploys. Watch paths
    such as `!docs/**`, `!*.md`, `!**/*.md`, `!.github/**`, `!**/*.test.ts`,
    `!**/*.test.tsx` and `!apps/web/e2e/**` skip pushes that cannot change the image. A
    deploy takes about three minutes: Coolify waits out the image's 120 s start period
    before its first health check, then swaps the containers without downtime;
  - when another proxy ends TLS in front of Coolify (a NAS or a router), keep Coolify's
    domain on `http://`, set `BASE_URL` to the public `https://` origin, and give the
    front proxy's rule for the host the WebSocket headers and a certificate. See
    "Behind a reverse proxy" above for `TRUST_PROXY`.
- **Upgrading**: `git pull`, then `docker compose up -d --build`. The new container
  applies pending migrations before it listens; rooms, even rounds in progress, live in
  Postgres and survive, and browsers reconnect by themselves.
- **Backups**: everything lives in the database (volume `poker-planning_pgdata`). Back it
  up before upgrading and on a schedule, for example
  `docker compose exec -T db pg_dump -U poker -Fc poker > poker-$(date +%F).dump`, and
  restore with `pg_restore`. `docker compose down -v` deletes the volume. Before you
  start the server on a restored database, raise `ROOM_TTL_DAYS` or run
  `update room set last_active_at = now()` on it: the retention purge deletes every room
  idle past the period 3 to 5 minutes after the start (see "Privacy").
- **Base image updates**: the Dockerfile pins `node:24-slim` and `debian:bookworm-slim` by
  digest, so a rebuild never picks up Debian security fixes by itself. Every month or
  after a Debian security advisory, follow the steps in the Dockerfile header (pull both
  tags, compare Debian versions, replace both digests), then
  `scripts/docker-check.sh` and a pull request. Nothing automates it.
- **Health**: `GET /api/health` answers `{ status, version, commit, db, uptime }`; the
  image's `HEALTHCHECK` uses it. With `REDIS_URL` it adds `redis: "ok"` or `"down"`
  (never the URL); Redis down does not make an instance unhealthy.

### Running several instances

One instance is the default and serves many teams. To run more behind one address, give
every instance the same Postgres and one Redis (6.2 or newer) with `REDIS_URL`, such as
`redis://redis:6379` or `rediss://:password@cache.example.com:6380`. Without the variable
nothing about Redis is loaded or opened.

- **What it changes**: the instances tell each other about every change through Redis
  (by room id, version and causes: no room state, no card, no room code) and each sends
  its own sockets their own view, loaded from Postgres. A change whose message comes late
  (over 100 ms) still shows, but without its announcement ("X voted") there. A kick or a new room password
  closes the sockets concerned on every instance, someone with a tab on either instance
  stays shown as present, a timer reveals once, a command resent after a reconnect to
  the other instance runs once, and retention keeps a room in use on any instance.
- **Load balancer**: sockets use WebSocket only once `REDIS_URL` is set (the web app reads
  it from the page), so a connection stays on the instance it reached and plain round
  robin works; let WebSocket upgrades through as for one instance. Clients that cannot
  open a WebSocket (some corporate proxies) cannot connect then. The alternative, if you
  need long-polling, is sticky sessions (a cookie or client-IP affinity on the balancer)
  with the default transports; this build does not offer that mode, so it would take a
  code change (`transports` in `apps/server/src/setup.ts`).
- **Per instance, on purpose**: the rate limits (room creation, sign-ins, wrong passwords
  per person and address, socket messages) and the 8 sockets per person count on each
  instance, so with two instances a client can get twice as much; the 50 wrong passwords
  per room in 10 minutes are counted in Postgres for all of them
  ([architecture, section 8](docs/02-architecture.md#8-rooms-access-and-security)).
- **Redis must be trusted**: whoever can talk to it can read every connection's
  headers, session cookies included, and room codes from the instances (the Socket.IO
  adapter answers such questions from any Redis client), and can send any client a
  message or close its connection. Make it reachable by the instances only (a private
  network, as in the example compose file), with a password, and with TLS (`rediss://`)
  whenever the network between them is not private. "No room code crosses Redis" is
  true of the app's own messages, not of what Redis lets a stranger ask.
- **Redis down**: each instance keeps serving its own sockets, and people on the other
  instances see the changes once Redis is back (with the next change, or when they
  reconnect), without the announcements of what they missed; meanwhile nobody is marked
  away, a command id is remembered per instance only, and the retention purge waits for
  its next run. A running instance never stops because of Redis; the start fails if
  Redis cannot be reached within 30 s. Redis keeps nothing that matters across a restart
  (no persistence needed). Give each deployment its own Redis: pub/sub ignores the
  database number.
- **Turning it on**: browser tabs opened before `REDIS_URL` was set keep long-polling
  and are refused (400) until they reload the page.
- **Example**: [`compose.scale-out.yaml`](compose.scale-out.yaml) runs two replicas behind
  nginx with a Redis, laid over `compose.yaml`:
  `docker compose -f compose.yaml -f compose.scale-out.yaml up -d --build`.
- **Checking the image**: `scripts/docker-check.sh` builds it and runs the checks CI runs
  (size, health, WebSocket, restarts, migrations, signals) as a separate compose project.

## Privacy

- **Stored**: rooms (name, settings, the people in them and the round on the table, the
  password as an argon2id hash); the round history of each room (every revealed round's
  subject, deck, votes with the voter's display name in a named round or the cards alone
  in an anonymous one, results and final estimate); the password grants (which guest may
  enter a room with a password without typing it); and guests (a random id, the display
  name, sessions without client address or user agent). No email, no password of a
  person, no analytics.
- **For how long**: a room idle for `ROOM_TTL_DAYS` days (default 90) is deleted with
  its history and its password grants. Activity is any change in the room, and opening
  it (counted at most once a day, or once a 24th of a shorter period). A guest's session
  ends after the same number of days without a visit; a guest with no session left and
  no room is deleted too. Rooms of signed-in users (planned) stay until deleted.
- **The purge** runs inside the server 3 to 5 minutes after each start and then daily;
  with several instances only one runs it. It logs counts only, never a room code, a
  name or a vote. Set `ROOM_TTL_DAYS` (1 to 3650) to keep rooms shorter or longer.
- **Rooms it deletes at once**: the first run after a start deletes every room idle past
  the period. After a restore from a backup, after lowering `ROOM_TTL_DAYS`, or after a
  downtime longer than the period, that can be all of them. Before you start the server,
  raise `ROOM_TTL_DAYS`, or set `last_active_at = now()` on the rooms you restored
  (`update room set last_active_at = now()`).
- **Backups** keep purged rooms until the backups themselves expire: a deleted room
  stays in every dump taken before its deletion.
- **Nothing is tracked by default.** Error reports (Sentry) and page views (Umami) are
  off unless you set their variables; until then the page loads nothing from anywhere
  else and the server sends nothing out. The policy allows their origins only once they
  are on.
- **Umami** (`UMAMI_URL`, `UMAMI_WEBSITE_ID`) counts page views by route: a room is
  `/r/:code`, never its code (anyone with the code can enter a room without a password),
  and never a query string. The referrer is the other site's origin on the first view.
  It honours the browser's Do Not Track and sets no cookie.
- **Sentry** (`SENTRY_DSN`) gets the server's lines logged at `error` or `fatal`,
  exactly as logged (the log never holds a room code, a secret, a vote or an address),
  and the page's uncaught errors with the route and the browser. No user, IP address,
  cookies, headers, breadcrumbs, sessions, tracing or replay. Use a DSN with its public
  key only: the page receives it. A self-hosted Sentry or GlitchTip works the same way.

## Security

- **Headers**: every answer carries a strict Content Security Policy (scripts, styles,
  fonts and connections from the app's own origin only; no inline script; no framing),
  `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy:
  same-origin` (a room link is a key to the room and never leaves in a `Referer`), a
  `Permissions-Policy` that turns off camera, microphone, location, payment and the like,
  and the cross-origin opener and resource policies. With an `https://` `BASE_URL` it
  adds HSTS for a year (`includeSubDomains`, no `preload`: submit your domain to the
  preload list yourself if you want it) and `upgrade-insecure-requests`.
  - `includeSubDomains` reaches every subdomain of the host in `BASE_URL`. On a
    subdomain such as `poker.example.com` that is only its own children; on an apex
    domain (`https://example.com`) it is every `*.example.com`, for a year, in every
    browser that opened the app: serve them all over https first, or install the app on a
    subdomain.
  - `upgrade-insecure-requests` makes the browser load everything over https. Opened
    over plain http (a LAN address such as `http://192.168.1.20:3000` while `BASE_URL`
    says https), the page stays blank: its scripts are asked for over https, which that
    address does not answer. Open the app at `BASE_URL`, or run a second instance whose
    `BASE_URL` is the http address.
- **Your own additions**: if you inject a script or load something from another origin
  (a status widget, your own analytics), the policy blocks it. Run with
  `CSP_REPORT_ONLY=true` first and read the browser console: it lists what the policy
  would block, and blocks nothing. Then allow the origins with `CSP_EXTRA_SOURCES`,
  directives separated by `;`, such as
  `CSP_EXTRA_SOURCES="script-src https://stats.example.com; connect-src https://stats.example.com"`
  (`script-src`, `style-src`, `img-src`, `font-src`, `connect-src`, `frame-src`,
  `media-src`; plain origins only, no `'unsafe-inline'`; a wildcard such as
  `https://*.example.com` only over your own domain, never `*.github.io` or `*.co.uk`),
  and turn report-only off.
- **Your proxy**: let the app's headers through unchanged. A proxy that adds headers of
  its own (Synology's "HSTS" checkbox, a Traefik `headers` middleware, nginx
  `add_header`) duplicates them: two policies both apply, so the stricter one wins and
  can break the page, and some graders count a duplicated header as missing. Check with
  `curl -sI https://your-host/` that each header appears once.
- **Limits**: room creation, sign-in, header reads and password checks are limited per
  client address, wrong passwords also per person and room, and socket messages per
  person (the full table is in
  [architecture, section 8](docs/02-architecture.md#8-rooms-access-and-security)). Set
  `TRUST_PROXY` to the number of proxies in front: too low, and every visitor shares one
  address, so the per-address limits apply to everyone at once.
- **Inputs**: names, room names, subjects, decks, passwords and every payload (16 KB)
  are bounded on the server; a fuzz test sends malformed messages to a real server on
  every pull request.
- **Dependencies**: CI fails on a high or critical advisory in a production dependency.

## Run locally

Prerequisites: Node 24 (see `.nvmrc`; any other major is refused) and pnpm. The exact
pnpm version is pinned in `packageManager` (pnpm 12): an installed pnpm 9.7 or later
downloads and runs that version by itself, otherwise use corepack (`corepack enable`).

```sh
pnpm install   # install the workspace
pnpm dev       # server on http://localhost:3000, web app on http://localhost:5173
pnpm gate      # Node check, lint, typecheck, unit tests and build: run before every PR
```

Other scripts: `pnpm test` (unit tests), `pnpm test:db` (integration tests against
Postgres, one file at a time because they share one database), `pnpm lint`, `pnpm format`, `pnpm typecheck`, `pnpm build`. The layout and
the rules of each package are in `apps/*/README.md` and `packages/*/README.md`.

CI (`.github/workflows/ci.yml`) runs on pull requests only: job `check` runs `pnpm gate`,
job `db-tests` runs `pnpm test:db` against a Postgres 17 service, job `docker` builds
the image and runs `scripts/docker-check.sh`; docs-only changes run no job.

Workspace conventions:

- TypeScript strict from `tsconfig.base.json`; `pnpm typecheck` runs `tsc --build` over
  the project references in `tsconfig.json` (declarations go to gitignored `.tsbuild/`).
- `moduleResolution: "bundler"`: Vite, tsx, Vitest and the server bundle resolve our
  imports, never bare Node. Relative imports carry their `.ts` extension (Biome checks).
- `@pp/domain` and `@pp/protocol` export TypeScript source; nothing to build first.
- Tests sit next to the code: `*.test.ts` are unit tests (`pnpm test`), `*.db.test.ts`
  need Postgres (`pnpm test:db`). Each package is a Vitest project in `vitest.config.ts`.
- Biome formats and lints everything except Markdown formatting; `pnpm format` fixes.
- pnpm settings live in `pnpm-workspace.yaml`. Dependency build scripts are blocked
  unless listed under `allowBuilds` there.
- Scripts must run on Windows and Linux: no `rm -rf`, no `VAR=value cmd`.
- On Windows, keep the clone path short (under about 130 characters). pnpm 12 writes
  `pnpm -r run` state to `node_modules/.pnpm-task-run-state-v1/<hash>.<run>.jsonl`, and
  past 260 characters in total `pnpm build` fails with "The system cannot find the path
  specified".

## License

[MIT](LICENSE)
