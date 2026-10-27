#!/usr/bin/env bash
# Checks the Docker image and compose.yaml end to end; CI's `docker` job runs it, and so
# can you (Docker with compose v2, Node 24, bash; on Windows, Git Bash).
#
#   scripts/docker-check.sh              build with compose, then check
#   scripts/docker-check.sh --no-build   check an existing poker-planning:local (CI builds
#                                        it first)
#
# It runs as its own compose project, `pp-check`, on port 3000 with throwaway secrets, and
# removes its containers, network and volume at the end, whatever happens. Steps:
#  1. the image is under 250 MB unpacked;
#  2. compose starts db and app, and the app's HEALTHCHECK turns healthy;
#  3. smoke test (scripts/docker-smoke.mjs): health with db ok and the expected commit, the
#     web app, Socket.IO over WebSocket with the right Origin, a foreign Origin refused;
#  4. restart keeps rooms: a room row inserted with psql survives `restart app`, and no
#     migration runs twice; it also survives `down` (without -v) and `up`, the volume
#     keeps it;
#  5. restart applies new migrations: the image's migrations plus one extra, mounted as
#     MIGRATIONS_DIR, apply once and the room row is still there;
#  6. SIGTERM: the app exits 0 when stopped while serving, and when stopped while it waits
#     for a database that is down.
set -euo pipefail

cd "$(dirname "$0")/.."
build=true
[[ "${1:-}" == "--no-build" ]] && build=false

readonly MAX_BYTES=250000000
readonly IMAGE=poker-planning:local
readonly WORK=tmp/docker-check
readonly OVERRIDE="$WORK/override.yaml"

# Throwaway values for this run only; never printed.
random() { node -e "process.stdout.write(require('node:crypto').randomBytes(24).toString('hex'))"; }
POSTGRES_PASSWORD="$(random)"
BETTER_AUTH_SECRET="$(random)"
export POSTGRES_PASSWORD BETTER_AUTH_SECRET
export BASE_URL=http://localhost:3000
export GIT_COMMIT="${GIT_COMMIT:-$(git rev-parse HEAD)}"
# Compose also reads the developer's .env; the shell wins over it, so pin what the steps
# rely on (step 6 looks for an info-level log line).
export LOG_LEVEL=info TRUST_PROXY=false ROOM_TTL_DAYS=90 APP_VERSION=
export COMPOSE_PROJECT_NAME=pp-check
# Git Bash would rewrite container paths such as app:/app/drizzle into Windows paths.
export MSYS_NO_PATHCONV=1

compose() { docker compose -f compose.yaml "$@"; }
psql() { compose exec -T db psql -U poker -d poker -v ON_ERROR_STOP=1 -tAc "$1"; }
step() { printf '\n== %s\n' "$*"; }
fail() {
  echo "FAILED: $*" >&2
  compose logs --no-color --tail=60 app >&2 || true
  exit 1
}
up_app() { compose "$@" up -d --no-build --wait --wait-timeout 180 app || fail "app not healthy"; }
exit_code() { docker inspect -f '{{.State.ExitCode}}' "$(compose ps -aq app)"; }

cleanup() {
  step "cleanup"
  docker compose -f compose.yaml down -v --remove-orphans --timeout 15 || true
  rm -rf "$WORK"
}
trap cleanup EXIT
mkdir -p "$WORK"

if $build; then
  step "build $IMAGE at $GIT_COMMIT"
  compose build app
fi

step "1. image size"
bytes="$(docker run --rm --user 0 --entrypoint du "$IMAGE" -sxb / | cut -f1)"
echo "unpacked: $((bytes / 1000000)) MB (limit $((MAX_BYTES / 1000000)) MB)"
docker history "$IMAGE" --format '{{.Size}}\t{{.CreatedBy}}' | awk -F'\t' '$1 != "0B"' | cut -c1-100
((bytes < MAX_BYTES)) || fail "image is $bytes bytes, over $MAX_BYTES"

step "2. compose up"
compose up -d --no-build --wait --wait-timeout 180 || fail "compose up did not get healthy"
compose ps

step "3. smoke test"
node scripts/docker-smoke.mjs "$BASE_URL" "$GIT_COMMIT" || fail "smoke test"

step "4. restart and down/up keep rooms and run no migration twice"
psql "insert into room (code, owner_user_id, live, version) values ('dockercheck1', 'docker-check', '{}', 1)" >/dev/null
migrations="$(psql "select count(*) from drizzle.__drizzle_migrations")"
compose restart app
up_app
[[ "$(psql "select count(*) from room where code = 'dockercheck1'")" == 1 ]] || fail "room row lost on restart"
[[ "$(psql "select count(*) from drizzle.__drizzle_migrations")" == "$migrations" ]] ||
  fail "migrations ran again on restart"
echo "ok: room row kept, $migrations migration(s) recorded before and after"
compose down --timeout 15 # no -v: the pgdata volume stays
compose up -d --no-build --wait --wait-timeout 180 || fail "compose up after down did not get healthy"
[[ "$(psql "select count(*) from room where code = 'dockercheck1'")" == 1 ]] ||
  fail "room row lost when the containers were removed (volume not kept)"
[[ "$(psql "select count(*) from drizzle.__drizzle_migrations")" == "$migrations" ]] ||
  fail "migrations ran again after down and up"
echo "ok: room row kept after down (without -v) and up"

step "5. restart applies a new migration"
compose cp app:/app/drizzle "$WORK/drizzle"
printf 'CREATE TABLE "docker_check" ("id" integer);\n' >"$WORK/drizzle/9999_docker_check.sql"
node -e '
  const fs = require("node:fs");
  const file = process.argv[1];
  const journal = JSON.parse(fs.readFileSync(file, "utf8"));
  const last = journal.entries.at(-1);
  journal.entries.push({ idx: last.idx + 1, version: last.version, when: Date.now(),
    tag: "9999_docker_check", breakpoints: true });
  fs.writeFileSync(file, JSON.stringify(journal, null, 2));
' "$WORK/drizzle/meta/_journal.json"
cat >"$OVERRIDE" <<'YAML'
services:
  app:
    environment:
      MIGRATIONS_DIR: /migrations
    volumes:
      - ./tmp/docker-check/drizzle:/migrations:ro
YAML
up_app -f "$OVERRIDE"
[[ "$(psql "select count(*) from drizzle.__drizzle_migrations")" == "$((migrations + 1))" ]] ||
  fail "the new migration was not recorded exactly once"
[[ "$(psql "select to_regclass('public.docker_check') is not null")" == t ]] ||
  fail "the new migration's table is missing"
[[ "$(psql "select count(*) from room where code = 'dockercheck1'")" == 1 ]] ||
  fail "room row lost when migrating"
echo "ok: new migration applied once, room row kept"

step "6. SIGTERM exits 0, while serving and while starting"
compose stop app
[[ "$(exit_code)" == 0 ]] || fail "exit code $(exit_code) after SIGTERM while serving"
echo "ok: stopped while serving, exit 0"
compose stop db
compose up -d --no-build --no-deps app
sleep 3 # the app now waits for the database (up to 30 s)
compose stop app
[[ "$(exit_code)" == 0 ]] || fail "exit code $(exit_code) after SIGTERM while starting"
compose logs --no-color app | grep -q "stopped while starting" ||
  fail "no 'stopped while starting' line"
echo "ok: stopped while starting, exit 0"

step "all docker checks passed"
