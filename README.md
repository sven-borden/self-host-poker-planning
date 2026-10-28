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
  restore with `pg_restore`. `docker compose down -v` deletes the volume.
- **Base image updates**: the Dockerfile pins `node:24-slim` and `debian:bookworm-slim` by
  digest, so a rebuild never picks up Debian security fixes by itself. Every month or
  after a Debian security advisory, follow the steps in the Dockerfile header (pull both
  tags, compare Debian versions, replace both digests), then
  `scripts/docker-check.sh` and a pull request. Nothing automates it.
- **Health**: `GET /api/health` answers `{ status, version, commit, db, uptime }`; the
  image's `HEALTHCHECK` uses it.
- **Checking the image**: `scripts/docker-check.sh` builds it and runs the checks CI runs
  (size, health, WebSocket, restarts, migrations, signals) as a separate compose project.

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
