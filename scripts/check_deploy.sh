#!/usr/bin/env bash
# Deploy a generated project to a throwaway host and check what deploying means.
#
# Usage: scripts/check_deploy.sh <generated-project-dir>
#
# The host is scripts/lib/throwaway_host.sh's — a privileged systemd container
# with a real sshd — provisioned by ansible/provision.yml first, because
# deploying to an unprovisioned host is not a thing the playbook does. The
# stack then really runs inside it: real Postgres, real Caddy, real images
# shipped over the wire, reached from outside over HTTPS.
#
# Each acceptance criterion is checked as behaviour, not as configuration:
#
#   * one command deploys        — the run below is the whole procedure
#   * secrets encrypted at rest  — an unencrypted vault is refused; the
#                                  password never appears in the working tree;
#                                  .env-production exists only on the host, 0600
#   * the DNS pre-flight aborts  — against a name resolving elsewhere, and
#                                  proceeds against one resolving here
#   * migrations run             — asserted against the database afterwards
#   * a failure leaves the       — a deliberately broken release is deployed on
#     previous version serving     top of a working one, and the working one
#                                  has to still answer when it is over
#
# This rewrites ansible/vault.yml, generates migrations and edits the
# Dockerfile, so it refuses to run against a tree that already has a vault:
# point it at a freshly generated project.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/throwaway_host.sh
source "$SCRIPT_DIR/lib/throwaway_host.sh"

PROJECT_DIR="${1:?usage: check_deploy.sh <generated-project-dir>}"
cd "$PROJECT_DIR"
PROJECT_DIR="$PWD"

throwaway_host_require_tools
command -v ansible-vault >/dev/null || fail "ansible-vault is required"
command -v python3 >/dev/null || fail "python3 is required"

# An `x && fail` one-liner would be wrong here: under `set -e` an AND-list whose
# left side fails takes the whole script down.
if [[ -e ansible/vault.yml ]]; then
  fail "$PWD/ansible/vault.yml exists; this check would overwrite it. Run it against a freshly generated project."
fi

SSH_PORT=2222
# The stack's own ports, published high so this does not need 443 on the
# machine running the check. Caddy matches a site on the name, not the port.
HTTP_PORT=8080
HTTPS_PORT=8443

# What the playbooks decided at generation time. Read out of the generated tree
# rather than re-derived here, which is only the same thing until one of them
# changes.
VARS=ansible/group_vars/all.yml
[[ -f $VARS ]] || fail "no $VARS in $PROJECT_DIR — is this a generated project?"
read_var() { sed -n "s/^$1: *//p" "$VARS" | head -1 | tr -d '"'; }
DEPLOY_USER="$(read_var deploy_user)"
APP_DIR="$(read_var app_dir)"
SLUG="$(read_var project_slug)"
[[ -n $DEPLOY_USER && -n $APP_DIR && -n $SLUG ]] \
  || fail "could not read deploy_user/app_dir/project_slug out of $VARS"
DB_NAME="${SLUG//-/_}"
NODE_TAG="$(sed -n 's/^FROM node:\(.*\) AS base$/\1/p' Dockerfile | head -1)"
[[ -n $NODE_TAG ]] || fail "could not read the node base image out of Dockerfile"

echo "==> Deploying '$SLUG' as '$DEPLOY_USER' into '$APP_DIR'"

# ── Secrets, and a sentinel to hunt for ──────────────────────────────────────
# The database password deliberately contains characters a URL reads as
# structure, so that DATABASE_URL having them encoded is checked by Postgres
# accepting the connection rather than by reading the template.
RANDOM_TAG="$(openssl rand -hex 8)"
AUTH_SECRET="nextauth-sentinel-$RANDOM_TAG"
PG_PASSWORD="p@ss/word:$RANDOM_TAG"
PG_PASSWORD_ENCODED="$(python3 -c 'import sys,urllib.parse; print(urllib.parse.quote(sys.argv[1], safe=""))' "$PG_PASSWORD")"

cleanup() {
  # The Dockerfile is edited below to build a deliberately broken release.
  if [[ -f Dockerfile.check-backup ]]; then
    mv Dockerfile.check-backup Dockerfile
  fi
  rm -f ansible/vault.yml
  # Images this check built, so a check does not quietly fill the disk. The
  # layer cache survives, so a re-run is not a cold build.
  docker image ls --format '{{.Repository}}:{{.Tag}}' \
    | grep -E "^($SLUG-(app|worker|db-writer|migrator|ops)|deploy-check-drizzle):" \
    | xargs docker image rm -f >/dev/null 2>&1 || true
  throwaway_host_stop
}
trap cleanup EXIT

throwaway_host_start "deploy-check-$$" "$SSH_PORT" "$HTTP_PORT:80" "$HTTPS_PORT:443"

# Images are built for the host's architecture, not the control machine's —
# which is the whole reason deploy_platform is a variable. A container on an
# arm64 laptop cannot run the linux/amd64 default.
HOST_ARCH="$(th_exec 'dpkg --print-architecture' | tr -d '\r')"
PLATFORM="linux/$HOST_ARCH"

deploy() {
  ansible-playbook -i "$TH_INVENTORY" ansible/deploy.yml \
    --vault-password-file "$TH_WORK/vault-pass" \
    -e "deploy_platform=$PLATFORM" "$@"
}

# ── Criterion: the vault has to be encrypted ─────────────────────────────────
# Filled in from the example the template ships, so that the example being
# wrong is a failure here rather than a surprise for whoever copies it.
cp ansible/vault.yml.example ansible/vault.yml
python3 - "$AUTH_SECRET" "$PG_PASSWORD" <<'PY'
import re, sys

path = "ansible/vault.yml"
text = open(path).read()
for name, value in (("vault_nextauth_secret", sys.argv[1]),
                    ("vault_postgres_password", sys.argv[2])):
    text, n = re.subn('^%s: ""$' % name, '%s: "%s"' % (name, value), text, flags=re.M)
    assert n == 1, "%s is not in vault.yml.example with an empty value" % name
open(path, "w").write(text)
PY
pass "ansible/vault.yml.example has the required names in it, with empty values"

openssl rand -hex 16 > "$TH_WORK/vault-pass"

echo "==> An unencrypted vault must be refused"
# site_address takes the DNS check out of it, so the vault is the only thing
# that can stop this run — otherwise a missing vault check would hide behind
# the DNS one aborting for its own reasons.
if deploy --tags preflight -e site_address=https://localhost \
     > "$TH_WORK/unencrypted.log" 2>&1; then
  fail "the playbook deployed with a plaintext ansible/vault.yml"
fi
grep -q "is not encrypted" "$TH_WORK/unencrypted.log" \
  || fail "the refusal did not say the vault is unencrypted: $(tail -5 "$TH_WORK/unencrypted.log")"
pass "a plaintext vault is refused, and the message says so"

ansible-vault encrypt --vault-password-file "$TH_WORK/vault-pass" ansible/vault.yml >/dev/null
head -c 14 ansible/vault.yml | grep -q '^\$ANSIBLE_VAULT' \
  || fail "ansible-vault encrypt did not produce a vault header"

# Criterion: encrypted at rest. Not "the file looks encrypted" — the password
# itself must not be anywhere in the tree that gets committed.
if grep -rqF "$PG_PASSWORD" .; then
  fail "the database password is in plaintext somewhere under $PWD: $(grep -rlF "$PG_PASSWORD" . | head -3)"
fi
pass "the vault is encrypted and no secret is in plaintext anywhere in the project"

# ── Criterion: the DNS pre-flight ────────────────────────────────────────────
# --tags preflight runs the checks and nothing else, so these cost a second
# each and never touch the host. one.one.one.one is the name resolved against:
# it is a stable public record, and what matters is only that it answers with
# an address that is not this host's.
preflight_must_fail() {
  local what="$1"
  shift
  if deploy --tags preflight "$@" > "$TH_WORK/preflight.log" 2>&1; then
    fail "the DNS pre-flight let $what through"
  fi
}
preflight_must_pass() {
  local what="$1"
  shift
  deploy --tags preflight "$@" > "$TH_WORK/preflight.log" 2>&1 \
    || fail "the DNS pre-flight refused $what: $(tail -20 "$TH_WORK/preflight.log")"
}
said() {
  grep -qF "$1" "$TH_WORK/preflight.log" \
    || fail "the pre-flight never said '$1': $(tail -25 "$TH_WORK/preflight.log")"
}

preflight_must_fail "the generation-time default domain"
said "RFC 2606 reserves for documentation"
pass "a deploy of the reserved default domain aborts, naming why it can never resolve"

preflight_must_fail "a domain resolving somewhere else" -e domain_name=one.one.one.one
said "one.one.one.one resolves to"
said "but the host this deploy targets (127.0.0.1)"
said "Nothing has been built or shipped."
said "-e dns_check=false"
pass "a domain resolving away from the target aborts, saying what resolved and what was expected"

preflight_must_fail "a domain that does not resolve at all" \
  -e domain_name=deploy-check.nxdomain-tld-that-does-not-exist
said "deploy-check.nxdomain-tld-that-does-not-exist"
pass "a domain that does not resolve aborts, naming it"

preflight_must_pass "a record pointing at the target" \
  -e domain_name=one.one.one.one -e ansible_host=1.1.1.1
said "which includes 1.1.1.1"
pass "a record that does point at the target is accepted"

preflight_must_pass "an opted-out check" -e domain_name=one.one.one.one -e dns_check=false
said "dns_check is off"
pass "-e dns_check=false skips the check and says it did"

preflight_must_pass "a loopback site address" -e site_address=https://localhost
said "which is not a public name"
pass "a SITE_ADDRESS pointing at localhost skips the check rather than failing it"

# ── A host to deploy to ──────────────────────────────────────────────────────
echo "==> Provisioning the host"
ansible-playbook -i "$TH_INVENTORY" ansible/provision.yml > "$TH_WORK/provision.log" 2>&1 \
  || fail "provisioning failed: $(tail -30 "$TH_WORK/provision.log")"
pass "the host is provisioned"

echo "==> Deploying before provisioning must be refused"
# The other half of "one command deploys to a provisioned host": to an
# unprovisioned one it says so, rather than half-deploying.
if deploy -e site_address=https://localhost -e app_dir=/app/not-provisioned \
     > "$TH_WORK/unprovisioned.log" 2>&1; then
  fail "the playbook deployed into a directory no provisioning had created"
fi
grep -q "has not been provisioned" "$TH_WORK/unprovisioned.log" \
  || fail "the refusal did not mention provisioning: $(tail -20 "$TH_WORK/unprovisioned.log")"
pass "deploying to an unprovisioned host is refused, pointing at provision.yml"

# ── Migrations to run ────────────────────────────────────────────────────────
# The template ships no migrations by design — `npm run db:generate` is step 5
# of its own README. Generate them the way the project would, in a container
# holding only its locked dependencies, so nothing is installed here and the
# image layers are the ones the migrator stage builds anyway.
echo "==> Generating migrations from the schema"
docker build -q -t deploy-check-drizzle --platform "$PLATFORM" -f - . >/dev/null <<DOCKERFILE
FROM node:$NODE_TAG
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --include=dev
DOCKERFILE
mkdir -p lib/db/migrations
docker run --rm --platform "$PLATFORM" \
  -v "$PROJECT_DIR/drizzle.config.ts:/app/drizzle.config.ts:ro" \
  -v "$PROJECT_DIR/lib/db:/app/lib/db" \
  deploy-check-drizzle npx drizzle-kit generate >/dev/null \
  || fail "drizzle-kit generate failed"
ls lib/db/migrations/*.sql >/dev/null 2>&1 || fail "drizzle-kit generated no migration"
pass "there is a migration for the deploy to run"

# ── Criterion: one command deploys ───────────────────────────────────────────
# SITE_ADDRESS is https://localhost for the same reason check_tls_stack.sh uses
# it: Caddy then issues from its own local CA instead of asking Let's Encrypt
# for a name that does not resolve here. Everything else is the production path.
echo "==> Deploying"
deploy -e site_address=https://localhost 2>&1 | tee "$TH_WORK/deploy1.log"
pass "one command built, shipped, migrated and started the stack"

# ── Criterion: the env file, on the host and nowhere else ────────────────────
env_stat="$(th_ssh "$DEPLOY_USER" "stat -c '%U %a' $APP_DIR/.env-production")"
[[ "$env_stat" == "$DEPLOY_USER 600" ]] \
  || fail ".env-production is '$env_stat', expected '$DEPLOY_USER 600'"
env_body="$(th_ssh "$DEPLOY_USER" "cat $APP_DIR/.env-production")"
grep -qxF "NEXTAUTH_SECRET=$AUTH_SECRET" <<<"$env_body" \
  || fail "the vault's NEXTAUTH_SECRET did not reach .env-production"
grep -qxF "POSTGRES_PASSWORD=$PG_PASSWORD" <<<"$env_body" \
  || fail "the vault's POSTGRES_PASSWORD did not reach .env-production"
grep -qF "postgresql://postgres:$PG_PASSWORD_ENCODED@postgres:5432/$DB_NAME" <<<"$env_body" \
  || fail "DATABASE_URL is not built from the vault password, url-encoded: $(grep '^DATABASE_URL' <<<"$env_body" | sed 's/:[^:@]*@/:REDACTED@/')"
pass ".env-production is on the host, 0600, owned by $DEPLOY_USER, rendered from the vault"

# The playbook writes no plaintext secret back into the working tree.
if grep -rqF "$PG_PASSWORD" .; then
  fail "deploying left the database password in plaintext under $PWD"
fi
pass "deploying left no plaintext secret in the project"

# ── Criterion: secrets are not printed either ────────────────────────────────
# A deploy's output is the thing most likely to be pasted into an issue or kept
# by CI. `template` reports its diff under --diff, and the diff of this file is
# every secret in the project, so the task has to be marked no_log — which is
# what this proves, by asking for the diff of a file that has to be written
# from scratch. Removing the env file first is what makes the diff maximal;
# without --diff nothing is printed either way and the check would be vacuous.
#
# The same run exercises the other half of what the old shell script's `env`
# mode did: deploy_targets=none re-renders .env-production and restarts,
# shipping no image at all.
echo "==> Re-rendering the env file on its own, asking for the diff"
th_ssh "$DEPLOY_USER" "rm -f $APP_DIR/.env-production"
deploy -e deploy_targets=none -e site_address=https://localhost --diff \
  > "$TH_WORK/deploy-env.log" 2>&1 \
  || fail "the env-only deploy failed: $(tail -20 "$TH_WORK/deploy-env.log")"
grep -q 'Render .env-production on the host' "$TH_WORK/deploy-env.log" \
  || fail "the env-only deploy did not render the env file at all"
for secret in "$PG_PASSWORD" "$AUTH_SECRET"; do
  if grep -qF "$secret" "$TH_WORK/deploy-env.log"; then
    fail "the deploy printed a secret from .env-production (a no_log is missing)"
  fi
done
env_stat="$(th_ssh "$DEPLOY_USER" "stat -c '%U %a' $APP_DIR/.env-production")"
[[ "$env_stat" == "$DEPLOY_USER 600" ]] \
  || fail "the re-rendered .env-production is '$env_stat', expected '$DEPLOY_USER 600'"
pass "an env-only deploy re-renders the file, ships no image, and prints no secret even under --diff"

# ── Criterion: migrations ran, against a real database ───────────────────────
# `|| true` so that a query which fails — because the table the migrations
# create is not there — answers with nothing and lets the assertion below say
# what is wrong, rather than taking the script down with psql's own error.
psql_q() { th_exec "docker exec ${SLUG}-postgres-1 psql -U postgres -d $DB_NAME -tAc \"$1\"" 2>/dev/null | tr -d '[:space:]' || true; }
applied="$(psql_q 'select count(*) from drizzle.__drizzle_migrations')"
[[ "${applied:-0}" -ge 1 ]] \
  || fail "drizzle recorded no applied migration; the migrator did not run"
tables="$(psql_q "select count(*) from information_schema.tables where table_schema='public'")"
[[ "${tables:-0}" -ge 1 ]] || fail "the schema is empty after a deploy that ran migrations"
pass "the migrations ran against the stack's Postgres ($applied applied, $tables tables)"

# Postgres accepted a password with URL-structural characters in it, which is
# the url-encoding in DATABASE_URL working rather than being written down.
th_exec "docker exec ${SLUG}-postgres-1 psql -U postgres -d $DB_NAME -c 'select 1'" >/dev/null \
  || fail "the database is not reachable with the password from the vault"

# ── Criterion: the stack serves ──────────────────────────────────────────────
# From outside the host, over HTTPS, through the proxy the stack runs itself —
# the same path a user takes, minus the certificate authority. Caddy provisions
# its local certificate after the container starts, so this polls.
serving() {
  [[ "$(curl -sk --max-time 5 -o /dev/null -w '%{http_code}' "https://localhost:$HTTPS_PORT/")" == 200 ]]
}
await "the stack to serve HTTPS" serving
pass "the deployed stack answers 200 over HTTPS from outside the host"

GOOD_APP_IMAGE="$(th_exec "docker images --no-trunc -q $SLUG-app:latest" | tr -d '\r')"
GOOD_RELEASE="$(th_ssh "$DEPLOY_USER" "sed -n 's/^release: //p' $APP_DIR/RELEASE")"
[[ -n "$GOOD_RELEASE" ]] || fail "no release was recorded in $APP_DIR/RELEASE"
pass "the host records release $GOOD_RELEASE"

# ── Criterion-adjacent: re-running an unchanged deploy changes nothing ───────
echo "==> Run 2: re-deploying unchanged code"
deploy -e site_address=https://localhost 2>&1 | tee "$TH_WORK/deploy2.log"
recap="$(grep -E 'ok=[0-9]+ +changed=' "$TH_WORK/deploy2.log" | tail -1)"
[[ -n "$recap" ]] || fail "no play recap in run 2's output"
if ! grep -qE 'changed=0 +unreachable=0 +failed=0' <<<"$recap"; then
  echo "--- tasks that reported a change on the second run ---" >&2
  grep -B3 '^changed:' "$TH_WORK/deploy2.log" >&2 || true
  fail "re-deploying unchanged code changed something: $recap"
fi
pass "re-deploying unchanged code transfers nothing and changes nothing ($recap)"

# ── Criterion: a failed deployment leaves the previous version serving ───────
# A release that builds and ships and migrates cleanly and then cannot serve —
# which is the case every other ordering gets wrong, because by the time it is
# known the previous containers are already gone.
echo "==> Deploying a deliberately broken release"
cp Dockerfile Dockerfile.check-backup
python3 - <<'PY'
path = "Dockerfile"
text = open(path).read()
old, new = 'CMD ["node", "server.js"]', 'CMD ["node", "there-is-no-such-file.js"]'
assert text.count(old) == 1, "the runner stage's CMD is not what this expects"
open(path, "w").write(text.replace(old, new))
PY
# Cut the health gate's patience: the criterion is what happens after it gives
# up, not how long it waits, and the default is sized for a real Next.js boot.
if deploy -e site_address=https://localhost \
     -e deploy_health_retries=4 -e deploy_health_delay=3 \
     > "$TH_WORK/deploy-broken.log" 2>&1; then
  fail "a release whose app cannot start was deployed successfully"
fi
mv Dockerfile.check-backup Dockerfile
grep -q "Rolled back:" "$TH_WORK/deploy-broken.log" \
  || fail "the failed deploy did not report a rollback: $(tail -30 "$TH_WORK/deploy-broken.log")"
pass "the broken release failed the deploy and said it rolled back"

now_app_image="$(th_exec "docker images --no-trunc -q $SLUG-app:latest" | tr -d '\r')"
[[ "$now_app_image" == "$GOOD_APP_IMAGE" ]] \
  || fail "$SLUG-app:latest is $now_app_image, not the previous release's $GOOD_APP_IMAGE"
running_image="$(th_exec "docker inspect -f '{{.Image}}' ${SLUG}-app-1" | tr -d '\r')"
[[ "$running_image" == "$GOOD_APP_IMAGE" ]] \
  || fail "the running app container is $running_image, not the previous release's image"
await "the previous release to be serving again" serving
still="$(th_ssh "$DEPLOY_USER" "sed -n 's/^release: //p' $APP_DIR/RELEASE")"
[[ "$still" == "$GOOD_RELEASE" ]] \
  || fail "the host records release $still after a failed deploy, not $GOOD_RELEASE"
pass "the previous release is serving again, from its own images, and is what the host records"

echo "==> Deploy check passed"
