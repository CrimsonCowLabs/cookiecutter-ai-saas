#!/usr/bin/env bash
# Prove what docs/compliance.md says this app does, against a really running
# instance of it in a real headless Chrome — not mocks, and not components
# rendered in-process. See tests/compliance/*.test.mjs for what is asserted and
# why; this script is only the plumbing that gets a real server and a real
# Postgres in front of them.
#
# Usage: scripts/check_compliance.sh [test file ...]
#
# With no arguments it runs every tests/compliance/*.test.mjs; name files to
# run only those (CI reruns the age gate this way with the minimum age raised).
#
# Same setup as the auth check this template is tested with: postgres and
# redis come up via docker-compose.yml, the app runs as a plain background
# `next start`, signed-in pages are reached with a session cookie the tests
# mint themselves, and the tests talk to Postgres directly.
#
# Needs Docker, port 3000 free, and a Chrome or Chromium binary (set
# CHROME_PATH if it is not in a usual place; see tests/compliance/support.mjs).
#
# Meant for a fresh checkout or CI, not your working copy: it rewrites
# .env.local, so it refuses to run when one exists, and it tears the compose
# stack down WITH its volumes when it finishes.
set -euo pipefail

cd "$(dirname "$0")/.."

fail() { echo "FAIL: $*" >&2; exit 1; }
pass() { echo "ok: $*"; }

ENV_FILE=.env.local
if [[ -e "$ENV_FILE" ]]; then
  fail "$PWD/$ENV_FILE exists; this check would overwrite it and delete your local database. Run it against a fresh checkout."
fi

DB_NAME="$(sed -n 's/^ *POSTGRES_DB: *//p' docker-compose.yml | head -1)"
[[ -n "$DB_NAME" ]] || fail "could not read POSTGRES_DB out of docker-compose.yml"
POSTGRES_PORT="$(sed -n 's/^ *- "\([0-9]*\):5432"$/\1/p' docker-compose.yml | head -1)"
REDIS_PORT="$(sed -n 's/^ *- "\([0-9]*\):6379"$/\1/p' docker-compose.yml | head -1)"
[[ -n "$POSTGRES_PORT" && -n "$REDIS_PORT" ]] \
  || fail "could not read the published postgres/redis ports out of docker-compose.yml"

# A fixed, low-entropy placeholder, not a real credential. It has to be the
# value tests/auth/support.mjs defaults NEXTAUTH_SECRET to, since the session
# cookies the tests mint are encrypted with it; it is passed to both sides
# explicitly below anyway, so the two can never silently disagree.
NEXTAUTH_SECRET="0000000000000000000000000000000000000000000000000000000000000000"
APP_PORT=3000
BASE_URL="http://localhost:${APP_PORT}"
DATABASE_URL="postgresql://postgres:postgres@localhost:${POSTGRES_PORT}/${DB_NAME}"
REDIS_URL="redis://localhost:${REDIS_PORT}"
# The age-gate tests sign in through Google and Microsoft by way of a fake
# identity provider they run on this port (tests/compliance/fake-oidc.mjs);
# the issuer overrides point the app's providers at it instead of the real
# ones. Unused providers' settings are harmless.
FAKE_OIDC_PORT=3999
FAKE_OIDC="http://localhost:${FAKE_OIDC_PORT}"

cat > "$ENV_FILE" <<ENV
NEXTAUTH_URL=${BASE_URL}
NEXTAUTH_SECRET=${NEXTAUTH_SECRET}
HOSTNAME=0.0.0.0
DATABASE_URL=${DATABASE_URL}
REDIS_URL=${REDIS_URL}
GOOGLE_ID=compliance-test
GOOGLE_SECRET=compliance-test
AUTH_GOOGLE_ISSUER=${FAKE_OIDC}/google
MICROSOFT_ENTRA_ID_ID=compliance-test
MICROSOFT_ENTRA_ID_SECRET=compliance-test
AUTH_MICROSOFT_ENTRA_ID_ISSUER=${FAKE_OIDC}/microsoft
ENV

# Outside the project, so a run leaves nothing behind in the tree.
SERVER_LOG="$(mktemp)"
SERVER_PID=""
cleanup() {
  echo "==> Tearing down"
  if [[ -n "$SERVER_PID" ]]; then
    kill "$SERVER_PID" >/dev/null 2>&1 || true
  fi
  # `next start` runs the server as a child of the npm/next CLI process,
  # which $SERVER_PID does not reach. This stops every `next start` server on
  # the machine, not only this one: another reason to run it on a fresh
  # checkout or in CI rather than next to a running app.
  pkill -f "next-server \(v" >/dev/null 2>&1 || true
  docker compose down -v --remove-orphans >/dev/null 2>&1 || true
  rm -f "$ENV_FILE" "$SERVER_LOG"
}
trap cleanup EXIT

echo "==> Bringing up postgres and redis"
docker compose up -d --wait postgres redis

echo "==> Installing dependencies (frozen)"
npm ci --no-audit --no-fund

echo "==> Pushing the schema"
npm run db:push -- --force

echo "==> Building"
npm run build

echo "==> Starting the app"
npm run start >"$SERVER_LOG" 2>&1 &
SERVER_PID=$!

for _ in $(seq 60); do
  if curl -sS -o /dev/null --max-time 5 "$BASE_URL/" >/dev/null 2>&1; then break; fi
  sleep 1
done
curl -sS -o /dev/null --max-time 5 "$BASE_URL/" >/dev/null 2>&1 || {
  echo "---- server log ----" >&2
  cat "$SERVER_LOG" >&2 || true
  fail "timed out waiting for the app to answer on $BASE_URL"
}
pass "app answers on $BASE_URL"

echo "==> Running the compliance tests"
if [[ $# -gt 0 ]]; then TESTS=(node --test "$@"); else TESTS=(npm run test:compliance); fi
# SERVER_LOG lets the age-gate tests check no date of birth was logged.
if ! BASE_URL="$BASE_URL" NEXTAUTH_SECRET="$NEXTAUTH_SECRET" DATABASE_URL="$DATABASE_URL" \
  FAKE_OIDC_PORT="$FAKE_OIDC_PORT" SERVER_LOG="$SERVER_LOG" \
  "${TESTS[@]}"; then
  echo "---- server log (last 50 lines) ----" >&2
  tail -n 50 "$SERVER_LOG" >&2 || true
  fail "compliance tests failed"
fi
pass "compliance tests passed"

echo "==> Compliance check passed"
