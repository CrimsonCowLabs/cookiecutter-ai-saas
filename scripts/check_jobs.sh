#!/usr/bin/env bash
# Prove that job submission enforces the user's plan (issue #102): a job type
# with no input schema is refused, input that fails its type's schema is
# refused, a user at their plan's jobsPerMonth is refused until the month
# turns, and parallel submissions never get past concurrentJobs. See
# tests/jobs/*.test.mjs for what is asserted and why.
#
# Usage: scripts/check_jobs.sh <generated-project-dir>
#
# The tests load lib/job-submission.ts themselves, through tsx, and run it
# against a real Postgres, so only postgres is brought up (via
# docker-compose.yml, through the generated project's own
# scripts/lib/running_app.sh) and the app is never built or started.
#
# This rewrites .env.local, so it refuses to run against a tree that already
# has one.
set -euo pipefail

PROJECT_DIR="${1:?usage: check_jobs.sh <generated-project-dir>}"
cd "$PROJECT_DIR"

[[ -e scripts/lib/running_app.sh ]] \
  || { echo "FAIL: no scripts/lib/running_app.sh in $PWD; regenerate the project from this template" >&2; exit 1; }
# shellcheck source=/dev/null
source scripts/lib/running_app.sh
running_app_prepare

# drizzle-kit reads DATABASE_URL from here; nothing else is needed.
running_app_write_env </dev/null

running_app_database postgres

running_app_test "the job submission tests" \
  env DATABASE_URL="$DATABASE_URL" npm run test:jobs

echo "==> Job limits check passed"
