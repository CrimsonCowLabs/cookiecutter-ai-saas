#!/usr/bin/env bash
# Prove that a generated project's FULL stack — app, worker, db-writer,
# postgres, redis, all five as real containers wired together the way
# docker-compose.yml describes — comes up healthy and can actually carry a
# job from submission through to a persisted result. See
# .github/workflows/nightly-stack-health.yml for why this runs nightly
# rather than on every PR: bringing up real containers and running a real
# job through them is too slow for every PR, cheap once a night.
#
# Usage: scripts/check_stack_health.sh <generated-project-dir>
#
# Unlike scripts/check_auth.sh, the app itself runs IN Docker here — the
# point is the containers' own healthchecks and the queue/worker/db-writer
# pipeline wired together exactly as a deployment runs it, not the
# fastest way to reach a server process. Auth is already covered by
# check_auth.sh; this check bypasses the web app's authenticated
# `submitJob` server action on purpose and talks to Postgres/Redis directly,
# the way the queue/worker/db-writer pipeline does internally.
#
# This rewrites .env.docker.local, so — like check_auth.sh's .env.local —
# it refuses to run against a tree that already has one.
set -euo pipefail

PROJECT_DIR="${1:?usage: check_stack_health.sh <generated-project-dir>}"
cd "$PROJECT_DIR"

fail() { echo "FAIL: $*" >&2; exit 1; }
pass() { echo "ok: $*"; }

ENV_FILE=.env.docker.local
if [[ -e "$ENV_FILE" ]]; then
  fail "$PWD/$ENV_FILE exists; this check would overwrite it. Run it against a freshly generated project."
fi

# Read the database name out of the compose file rather than re-deriving it
# from the project directory name, which is only the same thing until somebody
# renames the directory. Mirrors scripts/check_auth.sh.
DB_NAME="$(sed -n 's/^ *POSTGRES_DB: *//p' docker-compose.yml | head -1)"
[[ -n "$DB_NAME" ]] || fail "could not read POSTGRES_DB out of docker-compose.yml"

# docker-compose.yml's postgres/redis services publish the ports answered at
# generation time (cookiecutter.json's postgres_port/redis_port). The CI job
# that calls this script does not override either, so the defaults apply —
# asserted below rather than assumed, so a future default change fails loudly
# here instead of silently talking to the wrong port. Mirrors check_auth.sh.
POSTGRES_PORT=5432
REDIS_PORT=6379
grep -qF "\"${POSTGRES_PORT}:5432\"" docker-compose.yml \
  || fail "expected postgres to publish ${POSTGRES_PORT} (cookiecutter.json's default postgres_port) — was it overridden at generation time?"
grep -qF "\"${REDIS_PORT}:6379\"" docker-compose.yml \
  || fail "expected redis to publish ${REDIS_PORT} (cookiecutter.json's default redis_port) — was it overridden at generation time?"

# A fixed, low-entropy placeholder, not a real credential — the same value
# scripts/check_auth.sh and scripts/check_tls_stack.sh use, kept identical so
# a secret value never needs agreeing on across scripts by accident.
NEXTAUTH_SECRET="0000000000000000000000000000000000000000000000000000000000000000"

# Per README's "Post-Generation Setup": .env.docker.local is the containers'
# env file, so it addresses postgres/redis by their compose service names
# rather than localhost. LLM/Stripe/OAuth vars are deliberately left unset —
# workers/app/runner.py's _step_process_with_ai treats "no LLM configured"
# (and an unreachable provider) as a normal, completed outcome with
# ai_enhanced: false, so nothing else is required for a real job to run
# through the pipeline end to end.
cat > "$ENV_FILE" <<ENV
DATABASE_URL=postgresql://postgres:postgres@postgres:5432/${DB_NAME}
REDIS_URL=redis://redis:6379
NEXTAUTH_URL=http://localhost:3000
NEXTAUTH_SECRET=${NEXTAUTH_SECRET}
HOSTNAME=0.0.0.0
ENV

# Scratch file for step 9's end-to-end check, written into the project so
# node's ESM resolver walks up from it and finds node_modules (a script under
# /tmp would not see this project's already-installed pg/bullmq/ioredis at
# all). Removed in cleanup alongside the env file.
CHECK_SCRIPT=.stack-health-check.mjs

cleanup() {
  echo "==> Tearing down"
  docker compose down -v --remove-orphans >/dev/null 2>&1 || true
  rm -f "$ENV_FILE" "$CHECK_SCRIPT"
}
trap cleanup EXIT

echo "==> Installing dependencies (frozen)"
npm ci --no-audit --no-fund

echo "==> Bringing up postgres and redis"
docker compose up -d --wait postgres redis

echo "==> Pushing the schema (no migrations ship with the template — see README)"
# --force: this is a brand new database on every run, so there is nothing
# destructive to confirm and nothing interactive to confirm it with. Targets
# the host-published port directly — drizzle-kit runs here, not in a container.
DATABASE_URL="postgresql://postgres:postgres@localhost:${POSTGRES_PORT}/${DB_NAME}" \
  npm run db:push -- --force

echo "==> Bringing up the full stack and waiting for every service to report healthy"
# --wait blocks until every service with a healthcheck reports healthy (and
# every service without one is running) or the timeout below is hit. app,
# worker, db-writer, postgres and redis all have healthchecks now (see
# docker-compose.yml), so this is the acceptance criterion "waits for every
# service to report healthy" as an actual wait, not a fixed sleep.
docker compose up -d --wait --wait-timeout 180
pass "app, worker, db-writer, postgres and redis all report healthy"

echo "==> Exercising one job end to end through the queue and worker"
# Talks to Postgres/Redis on their host-published ports, the way a developer's
# own machine would — not from inside the compose network — and uses the
# generated project's own already-installed pg/bullmq/ioredis (reachable
# because this runs from the project directory, after npm ci, above).
cat > "$CHECK_SCRIPT" <<'NODE'
import crypto from "node:crypto";
import pg from "pg";
import IORedis from "ioredis";
import { Queue } from "bullmq";

const PG_PORT = process.env.STACK_HEALTH_PG_PORT;
const REDIS_PORT = process.env.STACK_HEALTH_REDIS_PORT;
const DB_NAME = process.env.STACK_HEALTH_DB_NAME;
if (!PG_PORT || !REDIS_PORT || !DB_NAME) {
  console.error("missing STACK_HEALTH_PG_PORT/REDIS_PORT/STACK_HEALTH_DB_NAME in the environment");
  process.exit(1);
}

const client = new pg.Client({
  connectionString: `postgresql://postgres:postgres@localhost:${PG_PORT}/${DB_NAME}`,
});
await client.connect();

// A throwaway user and a queued job row — same idiom as
// tests/auth/support.mjs's insertTestUser (random UUID id, *.example.invalid
// email), just done with a raw pg query rather than drizzle: this script
// needs no TypeScript build step or schema import.
const userId = crypto.randomUUID();
const jobId = crypto.randomUUID();
const email = `stack-health-${userId}@example.invalid`;
const jobInput = { url: "https://example.com/" };

await client.query(
  `insert into users (id, email, name) values ($1, $2, $3)`,
  [userId, email, "Stack Health Check User"]
);
await client.query(
  `insert into jobs (id, user_id, status, type, input) values ($1, $2, 'queued', 'url-report', $3::jsonb)`,
  [jobId, userId, JSON.stringify(jobInput)]
);

// Mirrors what lib/queue/jobs.ts's dispatchJob and app/actions/jobs.ts's
// submitJob do, just done directly instead of through the authenticated
// server action — this deliberately bypasses the web app's auth layer; auth
// itself is already covered by scripts/check_auth.sh.
const connection = new IORedis(`redis://localhost:${REDIS_PORT}`, {
  maxRetriesPerRequest: null, // required by BullMQ — matches lib/redis.ts
});
const queue = new Queue("jobs", { connection });
await queue.add(
  "process-job",
  { jobId, userId, type: "url-report", input: jobInput },
  { jobId }
);

const deadline = Date.now() + 90_000;
let row = null;
const terminal = new Set(["completed", "failed", "cancelled"]);
while (Date.now() < deadline) {
  const { rows } = await client.query(`select status, output from jobs where id = $1`, [jobId]);
  row = rows[0] || null;
  if (row && terminal.has(row.status)) break;
  await new Promise((resolve) => setTimeout(resolve, 2000));
}

function dumpAndExit(message) {
  console.error(`last known job row: ${JSON.stringify(row)}`);
  console.error(message);
  process.exit(1);
}

if (!row || !terminal.has(row.status)) {
  dumpAndExit(`timed out after 90s waiting for job ${jobId} to reach a terminal state`);
}
if (row.status !== "completed") {
  dumpAndExit(`job ${jobId} finished as '${row.status}', expected 'completed'`);
}
if (row.output === null || row.output === undefined) {
  dumpAndExit(`job ${jobId} completed with a null output`);
}

// Proves the db-writer actually persisted events along the way, not just the
// final result.
const { rows: eventRows } = await client.query(
  `select count(*)::int as count from job_events where job_id = $1`,
  [jobId]
);
if (!eventRows[0] || eventRows[0].count < 1) {
  dumpAndExit(`no job_events rows were persisted for job ${jobId} — the db-writer did not run`);
}

console.log(`ok: job ${jobId} completed with a non-null output and ${eventRows[0].count} job_events row(s)`);

await queue.close();
await connection.quit();
await client.end();
NODE

STACK_HEALTH_PG_PORT="$POSTGRES_PORT" STACK_HEALTH_REDIS_PORT="$REDIS_PORT" STACK_HEALTH_DB_NAME="$DB_NAME" \
  node "$CHECK_SCRIPT" || {
    echo "---- worker / db-writer logs (last 100 lines each) ----" >&2
    docker compose logs --tail=100 worker db-writer >&2 || true
    fail "a job submitted through the queue did not complete through the worker and db-writer"
  }
pass "a job submitted through the queue completed end to end, with a persisted job_events row"

echo "==> Stack health check passed"
