#!/usr/bin/env bash
# Prove the Stripe webhook fixes for issue #27, the one-customer,
# one-live-subscription checkout rules of issue #72, and that subscription
# entitlement converges on Stripe's state whatever order events arrive in
# (issue #71), and that a delayed (bank debit) payment grants access only once
# its money arrives (issue #73), and that unknown Stripe prices are refused at
# checkout and reported by the webhook (issue #74), and that a webhook handler
# that fails asks Stripe to retry and the retry grants it once (issue #75),
# and that refunds and disputes are recorded and revoke what the revocation
# policy says (issue #76),
# actually hold, against a really running instance of a generated project —
# not mocks, and not the route handler imported in-process. See
# tests/billing/integration/*.test.mjs for what is asserted and why. The
# plumbing that gets a real server and a real Postgres in front of them is the
# generated project's own scripts/lib/running_app.sh, as for check_auth.sh.
#
# Usage: scripts/check_billing.sh <generated-project-dir>
#
# The project must have been generated with include_stripe=yes: these routes
# and tables don't exist otherwise. Only postgres is brought up (via
# docker-compose.yml) — billing has nothing to do with redis — and the app
# runs as a plain background `next start` process, same as check_auth.sh.
#
# This rewrites .env.local, so it refuses to run against a tree that already
# has one.
set -euo pipefail

PROJECT_DIR="${1:?usage: check_billing.sh <generated-project-dir>}"
cd "$PROJECT_DIR"

[[ -e scripts/lib/running_app.sh ]] \
  || { echo "FAIL: no scripts/lib/running_app.sh in $PWD; regenerate the project from this template" >&2; exit 1; }
# shellcheck source=/dev/null
source scripts/lib/running_app.sh

if [[ ! -e app/api/webhook/stripe/route.ts ]]; then
  fail "no app/api/webhook/stripe/route.ts in $PWD; generate with include_stripe=yes"
fi

running_app_prepare

# Fixed, low-entropy placeholders, not real credentials — the same idea as
# running_app.sh's dummy NEXTAUTH_SECRET. STRIPE_WEBHOOK_SECRET has to be the
# exact value tests/billing/integration/*.test.mjs sign fake events with, and
# is set explicitly on both sides below rather than relying on a shared
# default, so a future change to either file fails a test instead of silently
# passing against a secret nobody checked. STRIPE_SECRET_KEY never has to be
# a real key: STRIPE_API_BASE points the app's Stripe client at a stand-in
# API (tests/compliance/fake-stripe.mjs) on FAKE_STRIPE_PORT, which each
# billing test file that needs it starts (one test file at a time, since they
# share the port). The key
# only has to be present, because getStripe() throws if it's unset at all
# (see lib/stripe.ts's own comment on that). The checkout tests mint their
# session cookies with running_app.sh's NEXTAUTH_SECRET.
STRIPE_SECRET_KEY="sk_test_0000000000000000000000000000000000000000"
STRIPE_WEBHOOK_SECRET="whsec_0000000000000000000000000000000000000000"
FAKE_STRIPE_PORT=3998

# OAuth provider credentials are left blank: nothing here ever exercises a
# real sign-in flow.
running_app_write_env <<ENV
STRIPE_SECRET_KEY=${STRIPE_SECRET_KEY}
STRIPE_WEBHOOK_SECRET=${STRIPE_WEBHOOK_SECRET}
STRIPE_API_BASE=http://localhost:${FAKE_STRIPE_PORT}
ENV

running_app_start postgres

running_app_test "the billing integration tests" \
  env BASE_URL="$BASE_URL" STRIPE_WEBHOOK_SECRET="$STRIPE_WEBHOOK_SECRET" DATABASE_URL="$DATABASE_URL" \
  NEXTAUTH_SECRET="$NEXTAUTH_SECRET" FAKE_STRIPE_PORT="$FAKE_STRIPE_PORT" SERVER_LOG="$SERVER_LOG" \
  npm run test:billing:integration

echo "==> Billing check passed"
