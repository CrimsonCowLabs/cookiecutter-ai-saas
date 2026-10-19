#!/usr/bin/env bash
# A really running copy of this app for a test suite to talk to: Postgres
# (and Redis, if asked for) from docker-compose.yml, the app built and run as
# a plain background `next start`, all of it torn down again on exit.
#
# Sourced by scripts/check_compliance.sh, and by the template repository's own
# auth, billing and job-limit checks, which source it from inside the
# generated project they are pointed at. It lives here, not in any one of
# them, so that booting and stopping the app is written down once and an
# operator can still run check_compliance.sh from this project alone.
#
# Usage, from the project root:
#
#     source scripts/lib/running_app.sh
#     running_app_prepare
#     running_app_write_env <<ENV
#     REDIS_URL=${REDIS_URL}
#     ...anything else this suite's app needs...
#     ENV
#     running_app_start postgres redis
#     running_app_test "the auth tests" env BASE_URL="$BASE_URL" npm run test:auth
#
# A suite that needs only the database calls running_app_database (the same
# arguments) instead of running_app_start, and skips the build.
#
# After running_app_prepare:
#   DB_NAME          the database docker-compose.yml creates
#   POSTGRES_PORT    the port it publishes postgres on
#   REDIS_PORT       the port it publishes redis on
#   NEXTAUTH_SECRET  a placeholder the app is booted with
#   APP_PORT         the port the app answers on
#   BASE_URL         the app's address
#   DATABASE_URL     postgres, as reached from this machine
#   REDIS_URL        redis, as reached from this machine
#   SERVER_LOG       a temp file the app's output goes to
#
# Meant for a fresh checkout or CI, not a working copy: it writes .env.local,
# so it refuses to run when one exists, and it tears the compose stack down
# WITH its volumes when it finishes.

fail() { echo "FAIL: $*" >&2; exit 1; }
pass() { echo "ok: $*"; }

RUNNING_APP_ENV_FILE=.env.local
RUNNING_APP_PID=""

# Refuse a tree that has a .env.local, read what docker-compose.yml publishes,
# and set the variables listed above. Tears down on exit from here on.
running_app_prepare() {
  [[ -e docker-compose.yml ]] || fail "no docker-compose.yml in $PWD; run this from a generated project's root"
  if [[ -e "$RUNNING_APP_ENV_FILE" ]]; then
    fail "$PWD/$RUNNING_APP_ENV_FILE exists; this check would overwrite it and delete your local database. Run it against a fresh checkout."
  fi

  # Read out of the compose file rather than assumed, so a project generated
  # with other ports, or a renamed directory, is still talked to correctly.
  DB_NAME="$(sed -n 's/^ *POSTGRES_DB: *//p' docker-compose.yml | head -1)"
  [[ -n "$DB_NAME" ]] || fail "could not read POSTGRES_DB out of docker-compose.yml"
  POSTGRES_PORT="$(sed -n 's/^ *- "\([0-9]*\):5432"$/\1/p' docker-compose.yml | head -1)"
  REDIS_PORT="$(sed -n 's/^ *- "\([0-9]*\):6379"$/\1/p' docker-compose.yml | head -1)"
  [[ -n "$POSTGRES_PORT" && -n "$REDIS_PORT" ]] \
    || fail "could not read the published postgres/redis ports out of docker-compose.yml"

  # A fixed, low-entropy placeholder, not a real credential. It has to be the
  # value tests/auth/support.mjs defaults NEXTAUTH_SECRET to, since the session
  # cookies the tests mint are encrypted with it. Pass it to the tests
  # explicitly anyway, so the two can never silently disagree.
  NEXTAUTH_SECRET="0000000000000000000000000000000000000000000000000000000000000000"
  APP_PORT=3000
  BASE_URL="http://localhost:${APP_PORT}"
  DATABASE_URL="postgresql://postgres:postgres@localhost:${POSTGRES_PORT}/${DB_NAME}"
  REDIS_URL="redis://localhost:${REDIS_PORT}"
  # Outside the project, so a run leaves nothing behind in the tree.
  SERVER_LOG="$(mktemp)"

  trap running_app_stop EXIT
}

# Write .env.local: what every suite's app needs to boot, then whatever this
# suite adds, read from stdin. next build/start and drizzle-kit all load it.
running_app_write_env() {
  {
    echo "NEXTAUTH_URL=${BASE_URL}"
    echo "NEXTAUTH_SECRET=${NEXTAUTH_SECRET}"
    echo "HOSTNAME=0.0.0.0"
    echo "DATABASE_URL=${DATABASE_URL}"
    cat
  } >"$RUNNING_APP_ENV_FILE"
}

# Bring up the named compose services, install and push the schema: all a
# suite that talks only to the database needs.
running_app_database() {
  echo "==> Bringing up $*"
  docker compose up -d --wait "$@"

  echo "==> Installing dependencies (frozen)"
  npm ci --no-audit --no-fund

  echo "==> Pushing the schema"
  # --force: a brand new database every run, so nothing to confirm.
  npm run db:push -- --force
}

# Bring up the named compose services, install, push the schema, build, start
# the app and wait until it answers.
running_app_start() {
  running_app_database "$@"

  echo "==> Building"
  npm run build

  echo "==> Starting the app"
  # In a process group of its own (set -m), so that running_app_stop can stop
  # npm, the shell under it and the next-server under that, and nothing else.
  # Job control would otherwise leave it reading the terminal.
  set -m
  npm run start </dev/null >"$SERVER_LOG" 2>&1 &
  RUNNING_APP_PID=$!
  set +m

  local _
  for _ in $(seq 60); do
    if curl -sS -o /dev/null --max-time 5 "$BASE_URL/" >/dev/null 2>&1; then
      pass "app answers on $BASE_URL"
      return 0
    fi
    sleep 1
  done
  echo "---- server log ----" >&2
  cat "$SERVER_LOG" >&2 || true
  fail "timed out waiting for the app to answer on $BASE_URL"
}

# Run a test command against the app: running_app_test <what> <command...>.
# Shows the end of the server log when it fails.
running_app_test() {
  local what="$1"
  shift
  echo "==> Running $what"
  if ! "$@"; then
    echo "---- server log (last 50 lines) ----" >&2
    tail -n 50 "$SERVER_LOG" >&2 || true
    fail "$what failed"
  fi
  pass "$what passed"
}

running_app_stop() {
  echo "==> Tearing down"
  if [[ -n "$RUNNING_APP_PID" ]]; then
    kill -TERM -- "-$RUNNING_APP_PID" >/dev/null 2>&1 || true
    # Wait until the port is free, so a run straight after this one (CI runs
    # check_compliance.sh several times in a row) can start its own app.
    local _
    for _ in $(seq 20); do
      kill -0 -- "-$RUNNING_APP_PID" >/dev/null 2>&1 || break
      sleep 0.5
    done
    kill -KILL -- "-$RUNNING_APP_PID" >/dev/null 2>&1 || true
  fi
  docker compose down -v --remove-orphans >/dev/null 2>&1 || true
  rm -f "$RUNNING_APP_ENV_FILE" "$SERVER_LOG"
}
