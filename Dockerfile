# syntax=docker/dockerfile:1

# Poker Planning: one image serving the web app, the API and Socket.IO on port 3000.
# Build: docker build -t poker-planning --build-arg GIT_COMMIT=$(git rev-parse HEAD) .
# Run:   docker compose up (compose.yaml), or see the README, "Self-hosting".

# Base images, pinned by digest so a rebuild of the same commit gets the same bytes. The
# flip side: nothing updates them, so Debian security fixes arrive only when someone
# repeats the steps below (README, "Base image updates"; no Dependabot or Renovate, by
# choice). node:24-slim builds; the runtime is the Debian it is built on plus its node
# binary alone. Plain node:24-slim would pass the 250 MB budget with this app (247 MB, 3 MB
# to spare), but it also ships npm, corepack and yarn, which a runtime never uses; the
# binary-only image leaves headroom, fewer packages to patch and fewer CVEs. Measured with
# du: Debian 77 MB, node 127 MB, app 16 MB, 220 MB in all.
# To update (every month or after a Debian security advisory):
#  1. docker pull both tags;
#  2. check that `docker run --rm <node image> cat /etc/debian_version` matches the Debian
#     tag (bookworm = 12; when node:24-slim moves to trixie, move DEBIAN_IMAGE with it);
#  3. put the digests from `docker image inspect <tag> --format "{{index .RepoDigests 0}}"`
#     into the two ARGs below;
#  4. run scripts/docker-check.sh and open a pull request.
ARG NODE_IMAGE=node:24-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205
ARG DEBIAN_IMAGE=debian:bookworm-slim@sha256:7ff6ba31527b9e336162fa061746c366c4b2032f4d2cff2078bea43f78efe3f8

# ---- build: install, build the web app and the server, prune to the server's runtime deps
FROM ${NODE_IMAGE} AS build
ENV CI=true \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable pnpm
WORKDIR /src

# pnpm at the version pinned in package.json (`packageManager`), the only place with it.
# Then download every package of the lockfile into the cached store. Only these three
# files invalidate these layers, so a source change reuses them.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN corepack install
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm fetch --store-dir /pnpm/store

COPY . .
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --offline --store-dir /pnpm/store
RUN pnpm build

# /out becomes the runtime /app: the server's package.json and production dependencies
# (pnpm deploy; @pp/domain and @pp/protocol come along but are already inlined in the
# bundle), the bundle in dist/, the migrations in drizzle/ and the built web app in
# public/. Type declarations, sourcemaps and docs of the dependencies are dropped.
# Not --offline: pnpm 12 checks the deployed lockfile against its supply-chain policy,
# which needs registry metadata (cached in the second mount).
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    --mount=type=cache,id=pnpm-metadata,target=/root/.cache/pnpm \
    pnpm --filter @pp/server deploy --prod --prefer-offline --store-dir /pnpm/store /deploy \
 && mkdir /out \
 && mv /deploy/package.json /deploy/node_modules /out/ \
 && cp -r apps/server/dist apps/server/drizzle /out/ \
 && cp -r apps/web/dist /out/public \
 && rm -rf /out/node_modules/.pnpm/@types+* /out/node_modules/.pnpm/undici-types@* \
 && find /out/node_modules -type f \( -name "*.d.ts" -o -name "*.d.cts" -o -name "*.d.mts" \
      -o -name "*.map" -o -name "*.md" \) -delete

# ---- runtime: Debian slim, the node binary and the pruned app, nothing else
FROM ${NODE_IMAGE} AS node
FROM ${DEBIAN_IMAGE} AS runtime
COPY --from=node /usr/local/bin/node /usr/local/bin/node
RUN groupadd --gid 10001 app \
 && useradd --uid 10001 --gid app --no-create-home --shell /usr/sbin/nologin app \
 && node --version
WORKDIR /app
# Owned by root and read-only for the app user: the server writes nothing to disk.
COPY --from=build /out /app

ENV NODE_ENV=production \
    PORT=3000 \
    STATIC_DIR=/app/public \
    MIGRATIONS_DIR=/app/drizzle
USER 10001:10001
EXPOSE 3000

# The server answers 200 once migrated and listening, 503 when Postgres does not answer.
# The start period covers the 30 s wait for Postgres, up to 60 s for another instance's
# migration lock, and the migrations; no curl in the image, Node's fetch does it.
HEALTHCHECK --interval=30s --timeout=3s --start-period=120s --start-interval=2s --retries=3 \
  CMD ["node", "-e", "fetch(`http://127.0.0.1:${process.env.PORT||3000}/api/health`,{signal:AbortSignal.timeout(2500)}).then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]

# Node is PID 1 and handles SIGTERM/SIGINT itself (graceful shutdown within 10 s, exit 0).
CMD ["node", "--enable-source-maps", "dist/main.mjs"]

# Last, so a new commit only changes these metadata layers. These are the only build
# arguments, and none may carry a secret: an ARG in scope of a RUN is readable in
# `docker history`, and these come after the last RUN. Never add an ARG for a secret
# (DATABASE_URL, BETTER_AUTH_SECRET); the app gets them at runtime only. Coolify leaves
# SOURCE_COMMIT out of builds unless "Advanced > Build > Source commit availability" is
# "Available during build"; a non-empty GIT_COMMIT wins. Empty values make /api/health
# report "unknown" and "dev". In Coolify set "Build arguments" to "Managed manually in
# Dockerfile", or it injects an ARG for every variable (README, "Coolify").
ARG SOURCE_COMMIT=
ARG GIT_COMMIT=
ARG APP_VERSION=
ENV GIT_COMMIT=${GIT_COMMIT:-${SOURCE_COMMIT}} \
    APP_VERSION=${APP_VERSION}
LABEL org.opencontainers.image.title="Poker Planning" \
      org.opencontainers.image.description="Self-hosted planning poker" \
      org.opencontainers.image.source="https://github.com/sven-borden/self-host-poker-planning" \
      org.opencontainers.image.version="${APP_VERSION}" \
      org.opencontainers.image.revision="${GIT_COMMIT:-${SOURCE_COMMIT}}"
