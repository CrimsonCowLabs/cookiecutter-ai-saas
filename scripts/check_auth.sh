#!/usr/bin/env bash
# Prove the access rules in middleware.ts and the admin page actually hold,
# against a really running instance of a generated project — not mocks, and
# not the route handlers imported in-process. See tests/auth/auth.test.mjs
# for what is asserted and why. With magic link included, the same run also
# proves sign-in emails are rate-limited (issue #106), against this redis:
# see tests/auth/magic-link-limit.test.mjs.
#
# Usage: scripts/check_auth.sh <generated-project-dir>
#
# The plumbing that gets a real server and a real Postgres in front of the
# tests is the generated project's own scripts/lib/running_app.sh, shared with
# its scripts/check_compliance.sh and with check_billing.sh here. Unlike
# scripts/check_tls_stack.sh and friends, the app itself is NOT brought up
# through Docker: only postgres and redis are, and the app runs as a plain
# background `next start` process. That is enough to exercise the real
# middleware/auth.js stack end to end, and it sidesteps building an app image
# just to run three HTTP requests against it.
#
# This rewrites .env.local, so it refuses to run against a tree that already
# has one.
set -euo pipefail

PROJECT_DIR="${1:?usage: check_auth.sh <generated-project-dir>}"
cd "$PROJECT_DIR"

[[ -e scripts/lib/running_app.sh ]] \
  || { echo "FAIL: no scripts/lib/running_app.sh in $PWD; regenerate the project from this template" >&2; exit 1; }
# shellcheck source=/dev/null
source scripts/lib/running_app.sh
running_app_prepare

# OAuth provider credentials are left blank: nothing here ever exercises a
# real sign-in flow, only session cookies minted directly by
# tests/auth/support.mjs.
running_app_write_env <<ENV
REDIS_URL=${REDIS_URL}
ENV

running_app_start postgres redis

running_app_test "the auth integration tests" \
  env BASE_URL="$BASE_URL" NEXTAUTH_SECRET="$NEXTAUTH_SECRET" DATABASE_URL="$DATABASE_URL" \
  REDIS_URL="$REDIS_URL" npm run test:auth

echo "==> Auth check passed"
