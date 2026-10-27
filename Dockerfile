# syntax=docker/dockerfile:1

# Poker Planning: one image serving the web app, the API and Socket.IO on port 3000.
# Build: docker build -t poker-planning --build-arg GIT_COMMIT=$(git rev-parse HEAD) .
# Run:   docker compose up (compose.yaml), or see the README, "Self-hosting".

# Base images, pinned by digest so a rebuild of the same commit gets the same bytes.
# node:24-slim builds; the runtime is the Debian it is built on plus its node binary
# alone, because node:24-slim itself is 235 MB unpacked (npm, corepack and C headers
# included) and the image must stay under 250 MB. To update: docker pull both tags, check
# that `docker run --rm <node image> cat /etc/debian_version` matches the Debian tag
# (bookworm = 12), and put the digests from
# docker image inspect <tag> --format "{{index .RepoDigests 0}}" here.
ARG NODE_IMAGE=node:24-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205
ARG DEBIAN_IMAGE=debian:bookworm-slim@sha256:7ff6ba31527b9e336162fa061746c366c4b2032f4d2cff2078bea43f78efe3f8

# ---- build: install, build the web app and the server, prune to the server's runtime deps
FROM ${NODE_IMAGE} AS build
ENV CI=true \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0
# pnpm through corepack, at the version pinned in package.json (`packageManager`).
RUN corepack enable pnpm && corepack prepare pnpm@12.15.0 --activate
WORKDIR /src

# Download every package of the lockfile into the cached store. Only these three files
# invalidate this layer, so a source change reuses it.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
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

# Last, so a new commit only changes these metadata layers. Coolify passes SOURCE_COMMIT
# when "Include source commit in build" is on; a non-empty GIT_COMMIT wins. Empty values
# make /api/health report "unknown" and "dev".
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
