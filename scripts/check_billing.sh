#!/usr/bin/env bash
# Prove the Stripe webhook fixes for issue #27, and the one-customer,
# one-live-subscription checkout rules of issue #72, actually hold, against a
# really running instance of a generated project — not mocks, and not the
# route handler imported in-process. See tests/billing/integration/*.test.mjs
# for what is asserted and why; this script is only the plumbing that gets a
# real server and a real Postgres in front of it. Mirrors scripts/check_auth.sh
# almost exactly — read that one first if this needs changing.
#
# Usage: scripts/check_billing.sh <generated-project-dir>
#
# The project must have been generated with include_stripe=yes: these routes
# and tables don't exist otherwise. Only postgres is brought up (via
# docker-compose.yml) — billing has nothing to do with redis — and the app
# runs as a plain background `next start` process, same as check_auth.sh.
#
# This rewrites .env.local, so — like check_auth.sh — it refuses to run
# against a tree that already has one.
set -euo pipefail

PROJECT_DIR="${1:?usage: check_billing.sh <generated-project-dir>}"
cd "$PROJECT_DIR"

fail() { echo "FAIL: $*" >&2; exit 1; }
pass() { echo "ok: $*"; }

if [[ ! -e app/api/webhook/stripe/route.ts ]]; then
  fail "no app/api/webhook/stripe/route.ts in $PWD; generate with include_stripe=yes"
fi

ENV_FILE=.env.local
if [[ -e "$ENV_FILE" ]]; then
  fail "$PWD/$ENV_FILE exists; this check would overwrite it. Run it against a freshly generated project."
fi

# Read the database name out of the compose file rather than re-deriving it
# from the project directory name, which is only the same thing until somebody
# renames the directory. Mirrors scripts/check_auth.sh.
DB_NAME="$(sed -n 's/^ *POSTGRES_DB: *//p' docker-compose.yml | head -1)"
[[ -n "$DB_NAME" ]] || fail "could not read POSTGRES_DB out of docker-compose.yml"

# docker-compose.yml's postgres service publishes the port answered at
# generation time (cookiecutter.json's postgres_port). The CI job that calls
# this script does not override it, so the default applies — asserted below
# rather than assumed, so a future default change fails loudly here instead
# of silently talking to the wrong port.
POSTGRES_PORT=5432
grep -qF "\"${POSTGRES_PORT}:5432\"" docker-compose.yml \
  || fail "expected postgres to publish ${POSTGRES_PORT} (cookiecutter.json's default postgres_port) — was it overridden at generation time?"

# Fixed, low-entropy placeholders, not real credentials — the same idea as
# check_auth.sh's dummy NEXTAUTH_SECRET. STRIPE_WEBHOOK_SECRET has to be the
# exact value tests/billing/integration/*.test.mjs sign fake events with, and
# is set explicitly on both sides below rather than relying on a shared
# default, so a future change to either file fails a test instead of silently
# passing against a secret nobody checked. STRIPE_SECRET_KEY never has to be
# a real key: STRIPE_API_BASE points the app's Stripe client at a stand-in
# API (tests/compliance/fake-stripe.mjs) on FAKE_STRIPE_PORT, which the
# checkout tests start; a call the webhook makes while nothing listens there
# is caught and tolerated (see lib/stripe.ts's findCheckoutSession). The key
# only has to be present, because getStripe() throws if it's unset at all
# (see lib/stripe.ts's own comment on that). NEXTAUTH_SECRET is the value
# tests/auth/support.mjs mints the checkout tests' session cookies with.
STRIPE_SECRET_KEY="sk_test_0000000000000000000000000000000000000000"
STRIPE_WEBHOOK_SECRET="whsec_0000000000000000000000000000000000000000"
FAKE_STRIPE_PORT=3998
NEXTAUTH_SECRET="0000000000000000000000000000000000000000000000000000000000000000"
APP_PORT=3000
BASE_URL="http://localhost:${APP_PORT}"
DATABASE_URL="postgresql://postgres:postgres@localhost:${POSTGRES_PORT}/${DB_NAME}"

# Only what next build/start and drizzle-kit need to boot — auto-loaded from
# .env.local by both (see drizzle.config.ts's own comment on this). OAuth
# provider credentials are left blank: nothing here ever exercises a real
# sign-in flow.
cat > "$ENV_FILE" <<ENV
NEXTAUTH_URL=${BASE_URL}
NEXTAUTH_SECRET=${NEXTAUTH_SECRET}
HOSTNAME=0.0.0.0
DATABASE_URL=${DATABASE_URL}
STRIPE_SECRET_KEY=${STRIPE_SECRET_KEY}
STRIPE_WEBHOOK_SECRET=${STRIPE_WEBHOOK_SECRET}
STRIPE_API_BASE=http://localhost:${FAKE_STRIPE_PORT}
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

echo "==> Bringing up postgres"
docker compose up -d --wait postgres

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

echo "==> Running the billing integration tests"
BASE_URL="$BASE_URL" STRIPE_WEBHOOK_SECRET="$STRIPE_WEBHOOK_SECRET" DATABASE_URL="$DATABASE_URL" \
  NEXTAUTH_SECRET="$NEXTAUTH_SECRET" FAKE_STRIPE_PORT="$FAKE_STRIPE_PORT" SERVER_LOG="$PWD/server.log" \
  npm run test:billing:integration
pass "billing integration tests passed"

echo "==> Billing check passed"
