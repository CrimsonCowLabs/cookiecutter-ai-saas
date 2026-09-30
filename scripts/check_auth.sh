#!/usr/bin/env bash
# Prove the access rules in middleware.ts and the admin page actually hold,
# against a really running instance of a generated project — not mocks, and
# not the route handlers imported in-process. See tests/auth/auth.test.mjs
# for what is asserted and why; this script is only the plumbing that gets a
# real server and a real Postgres in front of it.
#
# Usage: scripts/check_auth.sh <generated-project-dir>
#
# Unlike scripts/check_tls_stack.sh and friends, the app itself is NOT brought
# up through Docker here: only postgres and redis are (via docker-compose.yml),
# and the app runs as a plain background `next start` process. That is enough
# to exercise the real middleware/auth.js stack end to end, and it sidesteps
# building an app image just to run three HTTP requests against it.
#
# This rewrites .env.local, so — like check_tls_stack.sh's .env-production —
# it refuses to run against a tree that already has one.
set -euo pipefail

PROJECT_DIR="${1:?usage: check_auth.sh <generated-project-dir>}"
cd "$PROJECT_DIR"

fail() { echo "FAIL: $*" >&2; exit 1; }
pass() { echo "ok: $*"; }

ENV_FILE=.env.local
if [[ -e "$ENV_FILE" ]]; then
  fail "$PWD/$ENV_FILE exists; this check would overwrite it. Run it against a freshly generated project."
fi

# Read the database name out of the compose file rather than re-deriving it
# from the project directory name, which is only the same thing until somebody
# renames the directory. Mirrors scripts/check_tls_stack.sh.
DB_NAME="$(sed -n 's/^ *POSTGRES_DB: *//p' docker-compose.yml | head -1)"
[[ -n "$DB_NAME" ]] || fail "could not read POSTGRES_DB out of docker-compose.yml"

# docker-compose.yml's postgres/redis services publish the ports answered at
# generation time (cookiecutter.json's postgres_port/redis_port). The CI job
# that calls this script does not override either, so the defaults apply —
# asserted below rather than assumed, so a future default change fails loudly
# here instead of silently talking to the wrong port.
POSTGRES_PORT=5432
REDIS_PORT=6379
grep -qF "\"${POSTGRES_PORT}:5432\"" docker-compose.yml \
  || fail "expected postgres to publish ${POSTGRES_PORT} (cookiecutter.json's default postgres_port) — was it overridden at generation time?"
grep -qF "\"${REDIS_PORT}:6379\"" docker-compose.yml \
  || fail "expected redis to publish ${REDIS_PORT} (cookiecutter.json's default redis_port) — was it overridden at generation time?"

# A fixed, low-entropy placeholder, not a real credential — the same idea as
# scripts/check_tls_stack.sh's dummy NEXTAUTH_SECRET. It has to be the exact
# value tests/auth/support.mjs defaults NEXTAUTH_SECRET to, since both this
# script and that file need to agree on the secret a session cookie is
# encrypted with; it is set explicitly on both sides below rather than relying
# on that default, so a future change to either file fails a test instead of
# silently passing against a secret nobody checked.
NEXTAUTH_SECRET="0000000000000000000000000000000000000000000000000000000000000000"
APP_PORT=3000
BASE_URL="http://localhost:${APP_PORT}"
DATABASE_URL="postgresql://postgres:postgres@localhost:${POSTGRES_PORT}/${DB_NAME}"
REDIS_URL="redis://localhost:${REDIS_PORT}"

# Only what next build/start and drizzle-kit need to boot — auto-loaded from
# .env.local by both (see drizzle.config.ts's own comment on this). OAuth
# provider credentials are left blank: nothing here ever exercises a real
# sign-in flow, only session cookies minted directly by tests/auth/support.mjs.
cat > "$ENV_FILE" <<ENV
NEXTAUTH_URL=${BASE_URL}
NEXTAUTH_SECRET=${NEXTAUTH_SECRET}
HOSTNAME=0.0.0.0
DATABASE_URL=${DATABASE_URL}
REDIS_URL=${REDIS_URL}
ENV

SERVER_PID=""
cleanup() {
  echo "==> Tearing down"
  if [[ -n "$SERVER_PID" ]]; then
    kill "$SERVER_PID" >/dev/null 2>&1 || true
  fi
  # `next start` runs the actual server as a child of the npm/next CLI
  # process, which $SERVER_PID above does not reach — make sure nothing this
  # script started is left listening before it exits.
  pkill -f "next-server \(v" >/dev/null 2>&1 || true
  docker compose down -v --remove-orphans >/dev/null 2>&1 || true
  rm -f "$ENV_FILE"
}
trap cleanup EXIT

echo "==> Bringing up postgres and redis"
docker compose up -d --wait postgres redis

echo "==> Installing dependencies (frozen)"
npm ci --no-audit --no-fund

echo "==> Pushing the schema (no migrations ship with the template — see README)"
# --force: this is a brand new database on every run, so there is nothing
# destructive to confirm and nothing interactive to confirm it with.
npm run db:push -- --force

echo "==> Building"
npm run build

echo "==> Starting the app"
npm run start >server.log 2>&1 &
SERVER_PID=$!

await() {
  local what="$1"
  shift
  for _ in $(seq 60); do
    if "$@" >/dev/null 2>&1; then return 0; fi
    sleep 1
  done
  echo "---- server.log ----" >&2
  cat server.log >&2 || true
  fail "timed out waiting for $what"
}
await "the app to answer" curl -sS -o /dev/null --max-time 5 "$BASE_URL/"
pass "app answers on $BASE_URL"

echo "==> Running the auth integration tests"
BASE_URL="$BASE_URL" NEXTAUTH_SECRET="$NEXTAUTH_SECRET" DATABASE_URL="$DATABASE_URL" \
  npm run test:auth
pass "auth integration tests passed"

echo "==> Auth check passed"
