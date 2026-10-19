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
#   * the app is not a superuser — app, worker and db-writer connect as the app
#                                  role, which is no superuser and is refused
#                                  COPY TO PROGRAM, COPY to a file, CREATE ROLE,
#                                  CREATE DATABASE and DDL, yet can use every
#                                  table, one created after the deploy included;
#                                  the migrations ran as the schema owner, whose
#                                  password reaches only .env-migrations
#   * backup and restore         — a dump taken the way the backups take it,
#                                  restored the way the docs say, leaves the
#                                  owner owning everything and the app working
#   * an existing host upgrades  — a host put back the way deploys left it
#                                  before the roles existed (superuser
#                                  DATABASE_URL, tables owned by postgres, no
#                                  roles) is refused until the vault has the two
#                                  new passwords, and then deploys cleanly onto
#                                  the roles with nothing done by hand
#   * the proxy is the stack's   — the running Caddy is this release's
#     own Caddy build              <slug>-caddy image, with the rate-limit
#                                  module in it, shipped like the others; its
#                                  limits are set from group_vars and reach
#                                  the running proxy, and left unset reach it
#                                  not at all, so the Caddyfile's defaults hold
#   * the proxy sees clients     — Caddy logs a client's own address, and the
#                                  app rate-limits by it from X-Forwarded-For
#   * the app is loopback-only   — bound on 127.0.0.1:3000 and unreachable on
#                                  the host's address
#   * probers are banned, and    — browsing, sign-in, checkout, bad OAuth
#     customers are not            callbacks and failing Stripe webhooks ban
#                                  nobody; scanner probes get the client's 80
#                                  and 443 dropped at the firewall, SSH still
#                                  answering it, until the ban expires
#   * a failure leaves the       — a deliberately broken release, carrying a
#     previous version serving     configuration change as well as an app that
#                                  cannot start, is deployed over a working one;
#                                  the working one has to still answer when it is
#                                  over, on its own images *and* its own
#                                  compose file
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
# The two roles' names, as group_vars derives them from the database's. Read
# rather than assumed, with the one Jinja expression they are written in
# substituted; anything else in them fails here rather than being compared
# wrongly below.
read_role() {
  local value
  value="$(read_var "$1")"
  value="${value//'{{ postgres_db }}'/$DB_NAME}"
  [[ -n $value && $value != *'{{'* ]] || fail "could not work out $1 from '$(read_var "$1")' in $VARS"
  printf '%s\n' "$value"
}
OWNER_ROLE="$(read_role postgres_owner_user)"
APP_ROLE="$(read_role postgres_app_user)"
NODE_TAG="$(sed -n 's/^FROM node:\(.*\) AS base$/\1/p' Dockerfile | head -1)"
[[ -n $NODE_TAG ]] || fail "could not read the node base image out of Dockerfile"

echo "==> Deploying '$SLUG' as '$DEPLOY_USER' into '$APP_DIR'"

# ── Secrets, and a sentinel to hunt for ──────────────────────────────────────
# The database passwords deliberately contain characters a URL reads as
# structure, so that each DATABASE_URL having them encoded is checked by
# Postgres accepting the connection rather than by reading the template. One per
# role, and all different, so that finding one somewhere says which it was.
RANDOM_TAG="$(openssl rand -hex 8)"
AUTH_SECRET="nextauth-sentinel-$RANDOM_TAG"
PG_PASSWORD="p@ss/word:$RANDOM_TAG"
OWNER_PASSWORD="own@er/pw:$RANDOM_TAG"
APP_PASSWORD="ap@p/pw:$RANDOM_TAG"
urlencode() { python3 -c 'import sys,urllib.parse; print(urllib.parse.quote(sys.argv[1], safe=""))' "$1"; }
PG_PASSWORD_ENCODED="$(urlencode "$PG_PASSWORD")"
OWNER_PASSWORD_ENCODED="$(urlencode "$OWNER_PASSWORD")"
APP_PASSWORD_ENCODED="$(urlencode "$APP_PASSWORD")"
DB_SECRETS=("$PG_PASSWORD" "$OWNER_PASSWORD" "$APP_PASSWORD")
# Not a real Stripe secret, and never used to talk to Stripe: it is there so the
# webhook route checks a signature (and answers 400) instead of answering 501
# for being unconfigured — the ban jail's check below needs webhook calls that
# fail the way a misconfigured Stripe endpoint's would.
WEBHOOK_SECRET="whsec_deploycheck$RANDOM_TAG"

cleanup() {
  # The Dockerfile and the compose file are both edited below, to build a
  # deliberately broken release that also carries a configuration change.
  if [[ -f Dockerfile.check-backup ]]; then
    mv Dockerfile.check-backup Dockerfile
  fi
  if [[ -f docker-compose.prod.yml.check-backup ]]; then
    mv docker-compose.prod.yml.check-backup docker-compose.prod.yml
  fi
  rm -f ansible/vault.yml
  docker rm -f "${CLIENT:-}" >/dev/null 2>&1 || true
  # Images this check built, so a check does not quietly fill the disk. The
  # layer cache survives, so a re-run is not a cold build.
  docker image ls --format '{{.Repository}}:{{.Tag}}' \
    | grep -E "^($SLUG-(app|worker|db-writer|migrator|ops|caddy)|deploy-check-drizzle):" \
    | xargs docker image rm -f >/dev/null 2>&1 || true
  throwaway_host_stop
}
trap cleanup EXIT

throwaway_host_start "deploy-check-$$" "$SSH_PORT" "$HTTP_PORT:80" "$HTTPS_PORT:443"
# A client with an address of its own, for the checks that need to know who the
# proxy thinks is asking. See below.
CLIENT="$TH_NAME-client"

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
python3 - "$AUTH_SECRET" "$PG_PASSWORD" "$OWNER_PASSWORD" "$APP_PASSWORD" "$WEBHOOK_SECRET" <<'PY'
import re, sys

path = "ansible/vault.yml"
text = open(path).read()
for name, value in (("vault_nextauth_secret", sys.argv[1]),
                    ("vault_postgres_password", sys.argv[2]),
                    ("vault_postgres_owner_password", sys.argv[3]),
                    ("vault_postgres_app_password", sys.argv[4])):
    text, n = re.subn('^%s: ""$' % name, '%s: "%s"' % (name, value), text, flags=re.M)
    assert n == 1, "%s is not in vault.yml.example with an empty value" % name
# Only in a build with billing; without it the example has no Stripe block.
text = re.sub('^vault_stripe_webhook_secret: ""$',
              'vault_stripe_webhook_secret: "%s"' % sys.argv[5], text, flags=re.M)
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

# Criterion: encrypted at rest. Not "the file looks encrypted" — the passwords
# themselves must not be anywhere in the tree that gets committed.
for secret in "${DB_SECRETS[@]}"; do
  if grep -rqF "$secret" .; then
    fail "a database password is in plaintext somewhere under $PWD: $(grep -rlF "$secret" . | head -3)"
  fi
done
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
# --ignore-scripts: package.json's own \`prepare\` script (tsc -p cli) fires on
# every npm ci, but cli/ isn't copied into this build context — same reason
# the Dockerfile's own builder/ops/migrator stages carry it.
RUN npm ci --include=dev --ignore-scripts
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
# The role bootstrap hands the roles' passwords to psql through its task's
# environment, which a failing or verbose task would print. It did neither.
for secret in "${DB_SECRETS[@]}" "$AUTH_SECRET"; do
  if grep -qF "$secret" "$TH_WORK/deploy1.log"; then
    fail "the deploy printed a secret (a no_log is missing)"
  fi
done

# ── Criterion: the env file, on the host and nowhere else ────────────────────
env_stat="$(th_ssh "$DEPLOY_USER" "stat -c '%U %a' $APP_DIR/.env-production")"
[[ "$env_stat" == "$DEPLOY_USER 600" ]] \
  || fail ".env-production is '$env_stat', expected '$DEPLOY_USER 600'"
env_body="$(th_ssh "$DEPLOY_USER" "cat $APP_DIR/.env-production")"
grep -qxF "NEXTAUTH_SECRET=$AUTH_SECRET" <<<"$env_body" \
  || fail "the vault's NEXTAUTH_SECRET did not reach .env-production"
grep -qxF "POSTGRES_PASSWORD=$PG_PASSWORD" <<<"$env_body" \
  || fail "the vault's POSTGRES_PASSWORD did not reach .env-production"
grep -qxF "DATABASE_URL=postgresql://$APP_ROLE:$APP_PASSWORD_ENCODED@postgres:5432/$DB_NAME" <<<"$env_body" \
  || fail "DATABASE_URL is not the app role's, built from the vault's app password, url-encoded: $(grep '^DATABASE_URL' <<<"$env_body" | sed 's/:[^:@]*@/:REDACTED@/')"
# The owner's password is the one thing that must not be in here: compose hands
# this file to every service, so anything in it is in the app's environment.
if grep -qF -e "$OWNER_PASSWORD" -e "$OWNER_PASSWORD_ENCODED" <<<"$env_body"; then
  fail "the schema owner's password is in .env-production, where the app can read it"
fi
pass ".env-production is on the host, 0600, owned by $DEPLOY_USER, rendered from the vault, with the app role's DATABASE_URL and not the owner's password"

# The owner's connection lives in a file of its own, for the migrator alone.
mig_stat="$(th_ssh "$DEPLOY_USER" "stat -c '%U %a' $APP_DIR/.env-migrations")"
[[ "$mig_stat" == "$DEPLOY_USER 600" ]] \
  || fail ".env-migrations is '$mig_stat', expected '$DEPLOY_USER 600'"
mig_body="$(th_ssh "$DEPLOY_USER" "cat $APP_DIR/.env-migrations")"
OWNER_URL="postgresql://$OWNER_ROLE:$OWNER_PASSWORD_ENCODED@postgres:5432/$DB_NAME"
[[ "$(grep -v -e '^#' -e '^$' <<<"$mig_body")" == "DATABASE_URL=$OWNER_URL" ]] \
  || fail ".env-migrations should hold the owner's DATABASE_URL and nothing else; it has: $(grep -v '^#' <<<"$mig_body" | sed 's/:[^:@]*@/:REDACTED@/')"
pass ".env-migrations is on the host, 0600, owned by $DEPLOY_USER, holding the owner's DATABASE_URL and nothing else"

# The playbook writes no plaintext secret back into the working tree.
for secret in "${DB_SECRETS[@]}"; do
  if grep -rqF "$secret" .; then
    fail "deploying left a database password in plaintext under $PWD"
  fi
done
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
th_ssh "$DEPLOY_USER" "rm -f $APP_DIR/.env-production $APP_DIR/.env-migrations"
deploy -e deploy_targets=none -e site_address=https://localhost --diff \
  > "$TH_WORK/deploy-env.log" 2>&1 \
  || fail "the env-only deploy failed: $(tail -20 "$TH_WORK/deploy-env.log")"
grep -q 'Render .env-production on the host' "$TH_WORK/deploy-env.log" \
  || fail "the env-only deploy did not render the env file at all"
grep -q 'Render .env-migrations on the host' "$TH_WORK/deploy-env.log" \
  || fail "the env-only deploy did not render the migrations env file at all"
for secret in "${DB_SECRETS[@]}" "$AUTH_SECRET"; do
  if grep -qF "$secret" "$TH_WORK/deploy-env.log"; then
    fail "the deploy printed a secret from .env-production (a no_log is missing)"
  fi
done
for file in .env-production .env-migrations; do
  env_stat="$(th_ssh "$DEPLOY_USER" "stat -c '%U %a' $APP_DIR/$file")"
  [[ "$env_stat" == "$DEPLOY_USER 600" ]] \
    || fail "the re-rendered $file is '$env_stat', expected '$DEPLOY_USER 600'"
done
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

# ── Criterion: the app connects as a role that is not a superuser ──────────
# SQL, on stdin, run by psql inside the stack's Postgres container: as the
# superuser over the container's own socket, or with a connection URL exactly as
# a container was given it. The URL is used as is — its host is the compose
# service name, which resolves on the stack's network, the database's own
# container included — so a connection that works here is the url-encoding of
# that password working, against Postgres's real password check, rather than
# being read off the template.
PG_CONTAINER="${SLUG}-postgres-1"
sql_super() {
  th_exec "docker exec -i $PG_CONTAINER psql -X -q -v ON_ERROR_STOP=1 -tA -U postgres -d $DB_NAME"
}
sql_url() {
  th_exec "docker exec -i $PG_CONTAINER psql -X -q -v ON_ERROR_STOP=1 -tA $(printf '%q' "$1")"
}
# The DATABASE_URL a running container was started with, and the user in it.
container_db_url() {
  th_exec "docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' ${SLUG}-$1-1" \
    | sed -n 's/^DATABASE_URL=//p'
}
url_user() { python3 -c 'import sys,urllib.parse; print(urllib.parse.urlsplit(sys.argv[1]).username or "")' "$1"; }

# One statement, as the app role, that has to be refused — and refused for want
# of privilege: an error for any other reason (a typo, a connection failure)
# would make the refusal prove nothing.
refused() {
  local when="$1" what="$2" sql="$3" out
  if out="$(sql_url "$APP_URL" <<<"$sql" 2>&1)"; then
    fail "$when: the app role could $what"
  fi
  grep -qi 'permission denied' <<<"$out" \
    || fail "$when: '$sql' failed as the app role, but not for want of privilege: $out"
}

# Everything about the roles this deploy left behind that the criteria name, as
# one function, because the backup/restore and the upgrade below have to leave
# the database exactly as a fresh deploy does, and are held to the same thing.
assert_roles() {
  local when="$1" service url user flags out

  # app, worker and db-writer each run on the app role's URL, read from the
  # running container rather than the file it came from.
  for service in app worker db-writer; do
    url="$(container_db_url "$service")"
    [[ -n $url ]] || fail "$when: the running $service container has no DATABASE_URL"
    user="$(url_user "$url")"
    [[ $user == "$APP_ROLE" ]] \
      || fail "$when: the running $service container connects as '$user', not the app role $APP_ROLE"
  done
  APP_URL="$(container_db_url app)"
  [[ "$(sql_url "$APP_URL" <<<'select current_user')" == "$APP_ROLE" ]] \
    || fail "$when: the app's own DATABASE_URL does not log in as $APP_ROLE"

  # Neither new role is a superuser, and neither can create a role or a
  # database or get round row security.
  for user in "$APP_ROLE" "$OWNER_ROLE"; do
    flags="$(sql_super <<<"select rolsuper, rolcreaterole, rolcreatedb, rolbypassrls from pg_roles where rolname = '$user'")"
    [[ $flags == "f|f|f|f" ]] \
      || fail "$when: $user has rolsuper|rolcreaterole|rolcreatedb|rolbypassrls = '${flags:-no such role}', expected f|f|f|f"
  done

  # From the app's own connection, what the issue is about.
  refused "$when" "run a shell command through COPY ... TO PROGRAM" "COPY (SELECT 1) TO PROGRAM 'true'"
  refused "$when" "write a file on the database server" "COPY (SELECT 1) TO '/tmp/deploy-check-copy'"
  refused "$when" "create a role" "CREATE ROLE deploy_check_intruder"
  refused "$when" "create a database" "CREATE DATABASE deploy_check_intruder"
  refused "$when" "create a table" "CREATE TABLE public.deploy_check_intruder (id int)"

  # The migrations ran as the owner: everything in the schema is the owner's,
  # drizzle's own record of what it applied included.
  out="$(sql_super <<<"select schemaname || '.' || tablename || ' (' || tableowner || ')' from pg_tables
                       where schemaname in ('public', 'drizzle') and tableowner <> '$OWNER_ROLE'")"
  [[ -z $out ]] || fail "$when: these tables are not owned by $OWNER_ROLE: $(tr '\n' ' ' <<<"$out")"
  [[ "$(sql_super <<<"select tableowner from pg_tables where schemaname = 'drizzle' and tablename = '__drizzle_migrations'")" == "$OWNER_ROLE" ]] \
    || fail "$when: drizzle.__drizzle_migrations is not owned by $OWNER_ROLE — the migrations did not run as the owner"

  # And the app role can use all of it — read, write, and the sequences behind
  # serial ids — so least privilege has not become no privilege.
  out="$(sql_url "$APP_URL" <<<"
    select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and (
      -- One privilege per call: given a list, has_table_privilege is true if
      -- any one of them is held.
      (c.relkind in ('r', 'p') and not (has_table_privilege(c.oid, 'SELECT')
                                        and has_table_privilege(c.oid, 'INSERT')
                                        and has_table_privilege(c.oid, 'UPDATE')
                                        and has_table_privilege(c.oid, 'DELETE')))
      or (c.relkind = 'S' and not has_sequence_privilege(c.oid, 'USAGE')))")" \
    || fail "$when: the app role could not even list what it may use"
  [[ -z $out ]] || fail "$when: the app role cannot read and write: $(tr '\n' ' ' <<<"$out")"
}

assert_roles "after the first deploy"
pass "app, worker and db-writer connect as $APP_ROLE, which is no superuser and is refused COPY TO PROGRAM, COPY to a file, CREATE ROLE, CREATE DATABASE and CREATE TABLE, yet can read and write every table; the migrations ran as $OWNER_ROLE, which owns every table"

# Default privileges, which is what makes "usable by the app role" true of a
# table no deploy has granted anything on: one the owner creates now, as a
# later migration would, with a serial id so its sequence is covered too. The
# app role writes a row into it, which the backup and restore below then have to
# bring back. It is dropped once they have.
CANARY="deploy-check-canary-$RANDOM_TAG"
sql_url "$OWNER_URL" <<<'CREATE TABLE public.deploy_check_canary (id serial PRIMARY KEY, note text NOT NULL)' \
  || fail "the schema owner could not create a table"
sql_url "$APP_URL" <<<"INSERT INTO public.deploy_check_canary (note) VALUES ('$CANARY')" \
  || fail "the app role cannot write to a table the owner created after the deploy: default privileges are missing"
[[ "$(sql_url "$APP_URL" <<<'select note from public.deploy_check_canary')" == "$CANARY" ]] \
  || fail "the app role cannot read back a table the owner created after the deploy"
pass "a table the owner creates after the deploy is usable by the app role with no grant of its own (default privileges, sequence included)"

# ── Criterion: the stack serves ──────────────────────────────────────────────
# From outside the host, over HTTPS, through the proxy the stack runs itself —
# the same path a user takes, minus the certificate authority. Caddy provisions
# its local certificate after the container starts, so this polls.
serving() {
  [[ "$(curl -sk --max-time 5 -o /dev/null -w '%{http_code}' "https://localhost:$HTTPS_PORT/")" == 200 ]]
}
await "the stack to serve HTTPS" serving
pass "the deployed stack answers 200 over HTTPS from outside the host"

GOOD_RELEASE="$(th_ssh "$DEPLOY_USER" "sed -n 's/^release: //p' $APP_DIR/RELEASE")"
[[ -n "$GOOD_RELEASE" ]] || fail "no release was recorded in $APP_DIR/RELEASE"
pass "the host records release $GOOD_RELEASE"

# ── Criterion: the proxy is the stack's own Caddy build ──────────────────────
# The stock caddy image has no rate limiter, so the stack builds its own, and
# that image has to be the one serving — not merely one that was built. Three
# things, each of which could be true without the others: the running container
# is this release's <slug>-caddy image (shipped and tagged like every other, so
# it rolls back like every other), that image carries the rate-limit module,
# and with no caddy_*rate_limit_* set nothing of the sort reaches its
# environment, so the Caddyfile's own defaults are what it runs with.
#
# "Reaches" means NAME=..., an empty value included. An empty one is the
# failure that matters: Caddy falls back to {$NAME:default} only for a name
# that is unset, and `events` with an empty argument is a Caddyfile Caddy
# refuses to load — so group_vars' empty defaults must never be written out as
# NAME=. A bare NAME is what compose's pass-through records for a variable it
# did not have, and is not set inside the container; the stack answering above,
# on group_vars' empty defaults, is Caddy having loaded on its own defaults.
#
# The environment is read into a variable and refused when empty, before
# anything is looked for in it: an inspect that failed prints nothing, and
# nothing has no NAME= in it either, so grepping it straight would pass without
# having looked. A running container's environment is never empty (the image
# sets PATH, at least).
caddy_env() {
  th_exec "docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' ${SLUG}-caddy-1" | tr -d '\r'
}
GOOD_CADDY_IMAGE="$(th_exec "docker images --no-trunc -q $SLUG-caddy:$GOOD_RELEASE" | tr -d '\r')"
[[ -n $GOOD_CADDY_IMAGE ]] \
  || fail "the host has no $SLUG-caddy:$GOOD_RELEASE: the deploy did not ship the Caddy image under the release tag"
running_caddy="$(th_exec "docker inspect -f '{{.Image}}' ${SLUG}-caddy-1" | tr -d '\r')"
[[ "$running_caddy" == "$GOOD_CADDY_IMAGE" ]] \
  || fail "the running Caddy is $running_caddy ($(th_exec "docker inspect -f '{{.Config.Image}}' ${SLUG}-caddy-1" | tr -d '\r')), not release $GOOD_RELEASE's $SLUG-caddy image $GOOD_CADDY_IMAGE"
th_exec "docker exec ${SLUG}-caddy-1 caddy list-modules" | tr -d '\r' | grep -qxF http.handlers.rate_limit \
  || fail "the running Caddy has no http.handlers.rate_limit module: $(th_exec "docker exec ${SLUG}-caddy-1 caddy list-modules --skip-standard" | tr -d '\r' | tr '\n' ' ')"
env_now="$(caddy_env)" || fail "could not read the running Caddy's environment"
[[ -n $env_now ]] || fail "the running Caddy's environment came back empty"
if grep -E '^CADDY_([A-Z]+_)?RATE_LIMIT_[A-Z]+=' <<<"$env_now"; then
  fail "with no caddy_*rate_limit_* set, the above still reached Caddy's environment, overriding the Caddyfile's defaults"
fi
pass "the running Caddy is release $GOOD_RELEASE's $SLUG-caddy image, with the rate-limit module, booted on the Caddyfile's default limits with every caddy_*rate_limit_* left empty"

# ── Criterion: the proxy sees who is asking ──────────────────────────────────
# Caddy runs on the host's network rather than behind a published port, because
# a published port now goes through docker-proxy, which would make every client
# arrive from the same Docker gateway address — one shared bucket for the
# contact form's per-IP rate limit, and nothing worth banning.
#
# The request above arrives through this machine's own published port, so its
# source is a gateway either way. A client with an address of its own is
# needed: a container next to the host on the outer network, whose IP is known
# and is nobody's gateway. The host's image doubles as it, for its curl.
container_ip() {
  docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "$1"
}
docker run -d --name "$CLIENT" --entrypoint sleep "$TH_NAME" infinity >/dev/null
CLIENT_IP="$(container_ip "$CLIENT")"
HOST_IP="$(container_ip "$TH_NAME")"
[[ -n $CLIENT_IP && -n $HOST_IP ]] || fail "could not read the client's and the host's addresses"
client_curl() {
  docker exec "$CLIENT" curl -sk --max-time 10 --resolve "localhost:443:$HOST_IP" "$@"
}
[[ "$(client_curl -o /dev/null -w '%{http_code}' https://localhost/)" == 200 ]] \
  || fail "the stack does not answer a client at $CLIENT_IP"

# Caddy's access log, as the proxy recorded the request. It is a file on the
# host (the compose file bind-mounts logs/caddy), not container output, and
# Caddy writes it 0640 as root — th_exec runs as root, so it can read it.
await "Caddy to log the request from $CLIENT_IP" \
  th_exec "grep -qF '\"remote_ip\":\"$CLIENT_IP\"' $APP_DIR/logs/caddy/access.log"
pass "Caddy's access log records the client's own address ($CLIENT_IP), not a gateway's"

# And X-Forwarded-For as it reached the app, read back from the one place the
# app acts on it: the contact form's rate-limit key in Redis. The request need
# not be a valid submission — the limit is counted before anything else.
# The client also sends an X-Forwarded-For of its own: Caddy trusts no proxy in
# front of it, so it must replace that header rather than append to it, or any
# client could pick the bucket it is counted in.
if [[ -f app/api/contact/route.ts ]]; then
  client_curl -o /dev/null -X POST -H 'content-type: application/json' \
    -H 'X-Forwarded-For: 203.0.113.7' -d '{}' https://localhost/api/contact
  keys="$(th_exec "docker exec ${SLUG}-redis-1 redis-cli --scan --pattern 'rl:contact:*'" | tr -d '\r')"
  grep -qxF "rl:contact:$CLIENT_IP" <<<"$keys" \
    || fail "the contact form rate-limited by '${keys:-nothing}', not by the client's address $CLIENT_IP (a forged X-Forwarded-For must not survive)"
  pass "X-Forwarded-For reaches the app carrying the client's address, so the contact form limits per client"
fi

# ── Criterion: the app's port is on loopback only ────────────────────────────
# Caddy reaches the app on 127.0.0.1, so that is the only address it may listen
# on. Both halves: what the host binds, and what a client can actually reach.
listeners="$(th_exec "ss -Hltn 'sport = :3000'" | awk '{print $4}' | sort -u | paste -sd, -)"
[[ "$listeners" == "127.0.0.1:3000" ]] \
  || fail "the app's port is bound on '$listeners', expected only 127.0.0.1:3000"
if docker exec "$CLIENT" curl -sS --max-time 5 -o /dev/null "http://$HOST_IP:3000/" 2>/dev/null; then
  fail "the app answers on $HOST_IP:3000 from outside the host"
fi
th_exec "curl -sS --max-time 5 -o /dev/null http://127.0.0.1:3000/" \
  || fail "the app does not answer on the host's loopback, where Caddy reaches it"
pass "the app listens on 127.0.0.1:3000 only, and is unreachable from outside the host"

GOOD_APP_IMAGE="$(th_exec "docker images --no-trunc -q $SLUG-app:latest" | tr -d '\r')"

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

# ── Criterion: clients that keep probing are banned at the firewall ──────────
# provision.yml installs two fail2ban jails reading Caddy's access log on the
# host: caddy-scanner, counting the requests Caddy itself refused as scanner
# probes, and caddy-errors, counting 4xx responses of any kind. Both are only
# worth having if they can tell an attacker from a customer, so this checks the
# customer half first — a ban of an honest client is an outage for that client —
# and then that a prober really is cut off, and then that the ban ends.
#
# It comes after everything else that uses $CLIENT, and the ban it provokes has
# expired again before it ends, so nothing after it is talking to a banned
# address. What follows only uses the published port, which arrives from a
# Docker gateway — and the first thing asserted here is that that address was
# never banned either.
echo "==> Checking the Caddy ban jails"

# The configured values, as provisioning was told them. A trailing comment is
# allowed in group_vars, so strip one; read_var already drops quotes.
read_tunable() {
  local value
  value="$(read_var "$1" | sed 's/[[:space:]]*#.*//; s/[[:space:]]*$//')"
  [[ -n $value ]] || fail "could not read $1 out of $VARS"
  printf '%s\n' "$value"
}
SCANNER_MAXRETRY="$(read_tunable fail2ban_caddy_scanner_maxretry)"
ERRORS_MAXRETRY="$(read_tunable fail2ban_caddy_errors_maxretry)"
CADDY_FINDTIME="$(fail2ban_seconds "$(read_tunable fail2ban_caddy_findtime)")"
CADDY_BANTIME="$(fail2ban_seconds "$(read_tunable fail2ban_caddy_bantime)")"

jail_get() { th_exec "fail2ban-client get $1 $2" | tr -d '[:space:]'; }

# The tunables reach the running jails, not just the file they are written to.
for jail in caddy-scanner caddy-errors; do
  th_exec "fail2ban-client status $jail" >/dev/null \
    || fail "fail2ban has no $jail jail running"
  [[ "$(jail_get "$jail" findtime)" == "$CADDY_FINDTIME" ]] \
    || fail "$jail's findtime is $(jail_get "$jail" findtime)s, not fail2ban_caddy_findtime's ${CADDY_FINDTIME}s"
  [[ "$(jail_get "$jail" bantime)" == "$CADDY_BANTIME" ]] \
    || fail "$jail's bantime is $(jail_get "$jail" bantime)s, not fail2ban_caddy_bantime's ${CADDY_BANTIME}s"
done
[[ "$(jail_get caddy-scanner maxretry)" == "$SCANNER_MAXRETRY" ]] \
  || fail "caddy-scanner bans after $(jail_get caddy-scanner maxretry), not fail2ban_caddy_scanner_maxretry's $SCANNER_MAXRETRY"
[[ "$(jail_get caddy-errors maxretry)" == "$ERRORS_MAXRETRY" ]] \
  || fail "caddy-errors bans after $(jail_get caddy-errors maxretry), not fail2ban_caddy_errors_maxretry's $ERRORS_MAXRETRY"
pass "both Caddy jails run with the group_vars thresholds ($SCANNER_MAXRETRY and $ERRORS_MAXRETRY in ${CADDY_FINDTIME}s, banning for ${CADDY_BANTIME}s)"

# ── Ordinary traffic never trips them ──
# What a visitor's browser does on the way to paying, and what the services the
# app talks to do: pages, NextAuth's JSON endpoints, a real sign-in POST with a
# CSRF token, an unauthenticated go at the billing page and its server action,
# and an honest 404 or two. Whatever each answers is fine — some of it is a
# redirect, some is a 4xx on a host with no OAuth credentials — because none of
# it adds up to the errors jail's threshold, which is the point of the
# threshold. Twice over, as a visitor clicking around does.
codes=()
# curl prints 000 for a request that got no answer, so `|| true` loses nothing.
browse() { codes+=("$(client_curl -o /dev/null -w '%{http_code}' "$@" || true)"); }
for _ in 1 2; do
  for page in / /sign-in /sign-up /blog /contact /tos /privacy-policy \
              /api/auth/session /api/auth/providers /dashboard; do
    browse "https://localhost$page"
  done
  browse https://localhost/no-such-page
done
# A sign-in as the form submits it: the CSRF cookie and token first, then a POST
# to the first provider that is not the email one (which would send mail).
client_curl -o /dev/null -c /tmp/jar -b /tmp/jar https://localhost/api/auth/csrf
csrf="$(client_curl -c /tmp/jar -b /tmp/jar https://localhost/api/auth/csrf \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["csrfToken"])' || true)"
provider="$(client_curl https://localhost/api/auth/providers \
  | python3 -c 'import json,sys; print(next(p["id"] for p in json.load(sys.stdin).values() if p["type"] != "email"))' || true)"
[[ -n $csrf && -n $provider ]] || fail "could not read a CSRF token and a sign-in provider from NextAuth"
browse -c /tmp/jar -b /tmp/jar -X POST \
  --data-urlencode "csrfToken=$csrf" --data-urlencode "callbackUrl=https://localhost/dashboard" \
  "https://localhost/api/auth/signin/$provider"
# Checkout is a server action on the settings page. Signed out, the page
# redirects and the action is refused, which is what a visitor whose session
# expired mid-purchase sends.
browse https://localhost/dashboard/settings
browse -X POST -H 'Next-Action: 0000000000000000000000000000000000000000' \
  -H 'content-type: text/plain;charset=UTF-8' -d '["pro"]' https://localhost/dashboard/settings

# Then the two paths the errors jail must never count, sent more times than its
# threshold, so that counting them would ban: OAuth callbacks (a provider
# redirect gone wrong lands the user on one with bad parameters, and they will
# retry) and Stripe's webhook (which retries a failing delivery for days, from
# Stripe's own addresses — ban those and billing stops). The webhook's answers
# are asserted to be 4xx: this half proves nothing about the exclusion if they
# were not. The callbacks' are whatever NextAuth makes of them.
excluded=$((ERRORS_MAXRETRY + 10))
callback_codes=()
for _ in $(seq "$excluded"); do
  callback_codes+=("$(client_curl -o /dev/null -w '%{http_code}' \
    "https://localhost/api/auth/callback/$provider?code=bogus&state=bogus" || true)")
done
webhook_note=""
if [[ -d app/api/webhook/stripe ]]; then
  rejected=0
  for _ in $(seq "$excluded"); do
    code="$(client_curl -o /dev/null -w '%{http_code}' -X POST \
      -H 'stripe-signature: t=1,v1=bogus' -H 'content-type: application/json' \
      -d '{"id":"evt_check","type":"checkout.session.completed"}' \
      https://localhost/api/webhook/stripe || true)"
    if [[ $code == 4* ]]; then rejected=$((rejected + 1)); fi
  done
  [[ $rejected -eq $excluded ]] \
    || fail "only $rejected of $excluded badly signed Stripe webhooks were answered 4xx, so the errors jail's exclusion of them went untested"
  webhook_note=", $excluded badly signed Stripe webhooks answered 4xx"
fi

# fail2ban reads the log as it grows, so give it the time a ban would take to
# land before calling the absence of one a result: by the time Caddy has logged
# the last request, and a few polls after, a jail that was going to ban has.
await "Caddy to log the last of the client's requests" \
  th_exec "tail -n 5 $APP_DIR/logs/caddy/access.log | grep -qF '\"remote_ip\":\"$CLIENT_IP\"'"
sleep 5
for jail in caddy-scanner caddy-errors; do
  banned="$(jail_banned "$jail")"
  [[ -z $banned ]] \
    || fail "ordinary browsing, sign-in and checkout traffic got '$banned' banned by $jail (pages answered: ${codes[*]}; callbacks: ${callback_codes[*]})"
done
[[ "$(client_curl -o /dev/null -w '%{http_code}' https://localhost/)" == 200 ]] \
  || fail "the stack stopped answering $CLIENT_IP after ordinary traffic"
serving || fail "the stack stopped answering through the published port after ordinary traffic"
pass "browsing, sign-in, an unauthenticated checkout, $excluded bad OAuth callbacks$webhook_note: nothing in either Caddy jail is banned, this check's own gateway address included"

# ── A prober is dropped at the firewall ──
# The ban time is shortened on the live jail so its expiry can be watched in
# seconds rather than an hour. That still tests expiry: the configured value
# was asserted above to be what the jail runs with, and what is under test here
# is the mechanism — fail2ban noticing the ban has run its course and taking
# its firewall rule away again — which is the same for 20 seconds as for 3600.
SHORT_BANTIME=20
th_exec "fail2ban-client set caddy-scanner bantime $SHORT_BANTIME" >/dev/null

# The attempt that trips the ban can be the one that hangs, as with SSH in
# check_provisioning.sh: the rule may land while the next request is mid-flight.
# --max-time bounds each one.
echo "==> Probing scanner paths from $CLIENT_IP until fail2ban bans it"
probes=(/.env /wp-login.php /.git/config /xmlrpc.php /phpmyadmin/ /admin.php)
attempts=0
banned=""
for i in $(seq $((SCANNER_MAXRETRY + 15))); do
  attempts=$i
  docker exec "$CLIENT" curl -sk --connect-timeout 3 --max-time 5 -o /dev/null \
    --resolve "localhost:443:$HOST_IP" "https://localhost${probes[i % ${#probes[@]}]}" || true
  if grep -qwF "$CLIENT_IP" <<<"$(jail_banned caddy-scanner)"; then
    banned=yes
    break
  fi
  sleep 1
done
[[ -n $banned ]] \
  || fail "caddy-scanner banned nobody after $attempts scanner probes from $CLIENT_IP: $(th_exec 'fail2ban-client status caddy-scanner')"
# fail2ban can notice late, never early: a ban before the threshold means the
# jail counts something other than what it is configured to.
[[ $attempts -ge $SCANNER_MAXRETRY ]] \
  || fail "caddy-scanner banned $CLIENT_IP after $attempts probes, before its threshold of $SCANNER_MAXRETRY"
pass "caddy-scanner banned $CLIENT_IP after $attempts scanner probes (threshold $SCANNER_MAXRETRY)"

# Dropped, not refused: curl's 28 is a connection that timed out, 7 one that
# was actively refused. A DROP tells a scanner nothing and costs it a timeout
# per try. Both web ports; HTTP/3 on 443/udp is in the same rule but curl here
# speaks no QUIC.
client_rc() {
  local rc=0
  docker exec "$CLIENT" curl -sk --connect-timeout 5 --max-time 8 -o /dev/null "$@" || rc=$?
  echo "$rc"
}
for target in "https://localhost/ --resolve localhost:443:$HOST_IP" \
              "http://localhost/ --resolve localhost:80:$HOST_IP"; do
  # shellcheck disable=SC2086 # the URL and its --resolve, split on purpose
  rc="$(client_rc $target)"
  [[ $rc == 28 ]] \
    || fail "a banned client's request to ${target%% *} ended with curl exit $rc, not 28 (timed out — dropped at the firewall)"
done
# The ban is on the web ports only. SSH from the banned address still answers,
# so an operator who tripped the jail from their own connection can still log in
# and lift it. One TCP connection that reads the banner and leaves.
docker exec "$CLIENT" timeout 5 bash -c "exec 3<>/dev/tcp/$HOST_IP/$SSH_PORT && head -c 4 <&3" \
  | grep -q '^SSH-' || fail "a client banned by caddy-scanner cannot reach SSH on $HOST_IP:$SSH_PORT"
serving || fail "the stack stopped serving everyone else while $CLIENT_IP was banned"
pass "the banned client's requests to 443 and 80 are dropped while SSH still answers it, and everyone else is still served"

# ── And the ban ends ──
# Polled, bounded at a few times the shortened ban: fail2ban checks for expired
# bans on its own schedule, so the exact second is not part of the contract.
# Both jails: the probes were 4xx too, and an errors-jail ban on top (it should
# be nowhere near its threshold) would keep the client out for the full hour.
expired() {
  [[ -z "$(jail_banned caddy-scanner)$(jail_banned caddy-errors)" ]] \
    && [[ "$(client_curl --connect-timeout 3 -o /dev/null -w '%{http_code}' https://localhost/)" == 200 ]] \
    && docker exec "$CLIENT" curl -sS --connect-timeout 3 --max-time 10 -o /dev/null "http://$HOST_IP/"
}
TH_AWAIT_TRIES=$((SHORT_BANTIME * 4)) await "the ban on $CLIENT_IP to expire" expired
pass "after its ban time neither jail lists anybody and $CLIENT_IP reaches 443 and 80 again"

th_exec "fail2ban-client set caddy-scanner bantime $CADDY_BANTIME" >/dev/null
[[ "$(jail_get caddy-scanner bantime)" == "$CADDY_BANTIME" ]] \
  || fail "could not put caddy-scanner's bantime back to ${CADDY_BANTIME}s"

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
# The release also carries a configuration change, because the images are only
# half of what a rollback has to put back. Without this the good and the broken
# release ship a byte-identical compose file, so a rollback that restored images
# and left configuration alone would pass unnoticed — the check would be
# structurally unable to see the bug. A comment is enough: it cannot break
# compose's parsing, so what fails is still the app, and it is unambiguously
# observable on the host.
cp docker-compose.prod.yml docker-compose.prod.yml.check-backup
COMPOSE_SENTINEL="# check_deploy sentinel $RANDOM_TAG"
printf '%s\n' "$COMPOSE_SENTINEL" >> docker-compose.prod.yml
# Cut the health gate's patience: the criterion is what happens after it gives
# up, not how long it waits, and the default is sized for a real Next.js boot.
if deploy -e site_address=https://localhost \
     -e deploy_health_retries=4 -e deploy_health_delay=3 \
     > "$TH_WORK/deploy-broken.log" 2>&1; then
  fail "a release whose app cannot start was deployed successfully"
fi
mv Dockerfile.check-backup Dockerfile
mv docker-compose.prod.yml.check-backup docker-compose.prod.yml
grep -q "Rolled back:" "$TH_WORK/deploy-broken.log" \
  || fail "the failed deploy did not report a rollback: $(tail -30 "$TH_WORK/deploy-broken.log")"
pass "the broken release failed the deploy and said it rolled back"

# Two assertions, because either alone could pass for the wrong reason. The
# sentinel being gone proves the host is back on the previous release's compose
# file; the restore task having reported a change proves the sentinel reached
# the host at all — without which the first assertion would be true of a check
# that tested nothing.
grep -qE "changed: .*item=$APP_DIR/docker-compose.prod.yml" "$TH_WORK/deploy-broken.log" \
  || fail "the rollback never restored $APP_DIR/docker-compose.prod.yml: no task reported changing it, so the rescue put the images back and left this release's configuration in place. Tail of the failed deploy: $(tail -20 "$TH_WORK/deploy-broken.log")"
if th_ssh "$DEPLOY_USER" "grep -qF '$COMPOSE_SENTINEL' $APP_DIR/docker-compose.prod.yml"; then
  fail "the broken release's compose file is still on the host after the rollback"
fi
pass "the rollback put back the previous release's compose file, not only its images"

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
# The broken release changed only the app, so its Caddy image is the good
# release's, and Caddy sits through both the switch and the rollback. It still
# has to be on that image afterwards, not on anything else tagged :latest.
[[ "$(th_exec "docker inspect -f '{{.Image}}' ${SLUG}-caddy-1" | tr -d '\r')" == "$GOOD_CADDY_IMAGE" ]] \
  || fail "after the rollback the running Caddy is not release $GOOD_RELEASE's $SLUG-caddy image"
pass "Caddy is serving from release $GOOD_RELEASE's image after the rollback too"

# ── Criterion: the rate limits are tunable without editing the Caddyfile ─────
# Last, because it changes how hard the proxy pushes back and everything above
# wants the defaults. An env-only deploy, as an operator changing a limit would
# run one, with all six set: each has to reach the running Caddy's environment
# through .env-production (as site_address does), and the general one is then
# made small enough to watch working — a burst from one client to a page the
# app itself never rate-limits, so a 429 can only be Caddy's.
echo "==> Tuning Caddy's rate limits from group_vars"
TUNED=(-e caddy_rate_limit_events=5 -e caddy_rate_limit_window=1m
       -e caddy_strict_rate_limit_events=3 -e caddy_strict_rate_limit_window=2m
       -e caddy_ingest_rate_limit_events=7 -e caddy_ingest_rate_limit_window=3m)
deploy -e deploy_targets=none -e site_address=https://localhost "${TUNED[@]}" \
  > "$TH_WORK/deploy-tuned.log" 2>&1 \
  || fail "the env-only deploy with Caddy's limits set failed: $(tail -20 "$TH_WORK/deploy-tuned.log")"
env_now="$(caddy_env)" || fail "could not read the running Caddy's environment"
[[ -n $env_now ]] || fail "the running Caddy's environment came back empty"
for pair in CADDY_RATE_LIMIT_EVENTS=5 CADDY_RATE_LIMIT_WINDOW=1m \
            CADDY_STRICT_RATE_LIMIT_EVENTS=3 CADDY_STRICT_RATE_LIMIT_WINDOW=2m \
            CADDY_INGEST_RATE_LIMIT_EVENTS=7 CADDY_INGEST_RATE_LIMIT_WINDOW=3m; do
  grep -qxF "$pair" <<<"$env_now" \
    || fail "$pair did not reach the running Caddy's environment (it has: $(grep -E '^CADDY_' <<<"$env_now" | tr '\n' ' '))"
done
# Recreated on the new environment, so it is waited for — on one request,
# which spends one of the five.
client_served() { [[ "$(client_curl -o /dev/null -w '%{http_code}' https://localhost/)" == 200 ]]; }
await "Caddy to serve on its tuned limits" client_served
limited=0
retry_after=""
for _ in $(seq 15); do
  headers="$(client_curl -o /dev/null -D - https://localhost/ || true)"
  if grep -qE '^HTTP/[0-9.]+ 429' <<<"$headers"; then
    limited=$((limited + 1))
    retry_after="$(sed -n 's/^[Rr]etry-[Aa]fter: *//p' <<<"$headers" | tr -d '\r' | head -1)"
  fi
done
[[ $limited -ge 1 ]] \
  || fail "15 requests from $CLIENT_IP in well under a minute drew no 429, with caddy_rate_limit_events=5 per 1m: the tunable reached the environment but not the Caddyfile"
[[ -n $retry_after ]] || fail "Caddy's 429s carry no Retry-After"
# On the host, in the file the caddy-errors jail reads, against the client.
await "Caddy to log a 429 for $CLIENT_IP" \
  th_exec "grep -F '\"remote_ip\":\"$CLIENT_IP\"' $APP_DIR/logs/caddy/access.log | grep -qF '\"status\":429'"
pass "caddy_*rate_limit_* reach the running Caddy through .env-production, and 5/1m turns $limited of 15 requests into 429s (Retry-After: $retry_after), logged where the ban jail reads"

# And back: unset again, they leave Caddy's environment again, rather than
# lingering in .env-production from the run that set them.
deploy -e deploy_targets=none -e site_address=https://localhost \
  > "$TH_WORK/deploy-untuned.log" 2>&1 \
  || fail "the env-only deploy putting Caddy's limits back failed: $(tail -20 "$TH_WORK/deploy-untuned.log")"
env_now="$(caddy_env)" || fail "could not read the running Caddy's environment"
[[ -n $env_now ]] || fail "the running Caddy's environment came back empty"
if grep -E '^CADDY_([A-Z]+_)?RATE_LIMIT_[A-Z]+=' <<<"$env_now"; then
  fail "caddy_*rate_limit_* were unset again, but the above stayed in the running Caddy's environment"
fi
pass "unsetting caddy_*rate_limit_* takes them out of Caddy's environment, back to the Caddyfile's defaults"

# ── Criterion: backup and restore still work ─────────────────────────────────
# A dump taken exactly the way ansible/templates/db-backup.sh.j2 takes one — as
# the superuser, inside the container, from the container's own environment —
# and put back exactly the way docs/deployment.md says: pg_restore as the
# superuser, keeping owners, then a deploy. What has to survive is both halves
# of the role split: the data (the canary row, deleted in between) and the
# ownership and grants (the owner owning everything, the app role able to use
# it), with the app serving on top.
echo "==> Backing up and restoring the database"
DUMP=/tmp/deploy-check.dump
th_exec "docker exec -i $PG_CONTAINER sh -c '
  PGPASSWORD=\"\$POSTGRES_PASSWORD\" exec pg_dump --format=custom \
    --username \"\${POSTGRES_USER:-postgres}\" --dbname \"\$POSTGRES_DB\"' > $DUMP" \
  || fail "pg_dump as the superuser failed"
th_exec "head -c 5 $DUMP | grep -q PGDMP" || fail "the dump is not a Postgres custom-format archive"
sql_url "$APP_URL" <<<'DELETE FROM public.deploy_check_canary' \
  || fail "the app role could not delete the canary row"

compose_on_host() {
  th_exec "cd $APP_DIR && docker compose -p $SLUG -f docker-compose.prod.yml --env-file .env-production $1"
}
compose_on_host "stop app worker db-writer" >/dev/null 2>&1 \
  || fail "could not stop what writes before restoring"
th_exec "docker exec -i $PG_CONTAINER pg_restore --clean --if-exists -U postgres -d $DB_NAME < $DUMP" \
  > "$TH_WORK/restore.log" 2>&1 \
  || fail "the documented pg_restore did not restore cleanly: $(tail -20 "$TH_WORK/restore.log")"
deploy -e deploy_targets=none -e site_address=https://localhost \
  > "$TH_WORK/deploy-restore.log" 2>&1 \
  || fail "the deploy after the restore failed: $(tail -20 "$TH_WORK/deploy-restore.log")"
await "the stack to serve after the restore" serving
[[ "$(sql_url "$APP_URL" <<<'select note from public.deploy_check_canary')" == "$CANARY" ]] \
  || fail "the restore did not bring back the canary row, or the app role cannot read it"
assert_roles "after a restore"
pass "a dump taken as the backups take it, restored as the docs say, brings the data back with $OWNER_ROLE owning it and $APP_ROLE using it, and the app serving"
sql_url "$OWNER_URL" <<<'DROP TABLE public.deploy_check_canary' || fail "the owner could not drop the canary table"
th_exec "rm -f $DUMP"

# ── Criterion: a host deployed before the roles existed upgrades cleanly ─────
# Last, because it takes the database apart. The host is put back the way every
# deploy left it before the app had a role of its own: the app, worker and
# db-writer on the superuser's DATABASE_URL, no .env-migrations, the database
# and every table in it owned by postgres, and neither role there. Serving, as
# such a host was. Then the operator's whole upgrade, as docs/deployment.md
# gives it: a deploy with the old vault is refused, naming the two passwords to
# add; with them added it deploys, and nothing is done in the database by hand.
echo "==> Putting the host back the way deploys left it before the roles existed"
th_exec "sed -i 's|^DATABASE_URL=.*|DATABASE_URL=postgresql://postgres:$PG_PASSWORD_ENCODED@postgres:5432/$DB_NAME|' $APP_DIR/.env-production
  rm -f $APP_DIR/.env-migrations" \
  || fail "could not put the superuser's DATABASE_URL back in .env-production"
compose_on_host "up -d app worker db-writer" > "$TH_WORK/downgrade.log" 2>&1 \
  || fail "could not restart the stack on the superuser's DATABASE_URL: $(tail -20 "$TH_WORK/downgrade.log")"
# REASSIGN OWNED moves the database, the schemas and every table and sequence
# back to the superuser; DROP OWNED then takes away every grant and default
# privilege the roles were given, which is what lets them be dropped. The
# public schema goes back to its stock owner. One role per statement: the
# default privileges are one catalog row that both roles depend on, and
# `DROP OWNED BY owner, app` tries to delete it once for each, failing on the
# second with "could not find tuple for default ACL".
sql_super <<SQL || fail "could not take the roles back out of the database"
REASSIGN OWNED BY "$OWNER_ROLE" TO postgres;
REASSIGN OWNED BY "$APP_ROLE" TO postgres;
DROP OWNED BY "$OWNER_ROLE";
DROP OWNED BY "$APP_ROLE";
DROP ROLE "$OWNER_ROLE";
DROP ROLE "$APP_ROLE";
ALTER SCHEMA public OWNER TO pg_database_owner;
SQL
[[ "$(sql_super <<<"select count(*) from pg_roles where rolname in ('$OWNER_ROLE', '$APP_ROLE')")" == 0 ]] \
  || fail "the roles are still there after dropping them"
[[ "$(sql_super <<<"select count(*) from pg_tables where schemaname in ('public', 'drizzle') and tableowner <> 'postgres'")" == 0 ]] \
  || fail "some table is not the superuser's after handing everything back to it"
[[ "$(sql_super <<<"select pg_get_userbyid(datdba) from pg_database where datname = current_database()")" == postgres ]] \
  || fail "the database is not the superuser's after handing everything back to it"
[[ "$(url_user "$(container_db_url app)")" == postgres ]] \
  || fail "the app is not running on the superuser's DATABASE_URL"
await "the stack to serve as the superuser" serving
applied_before="$(psql_q 'select count(*) from drizzle.__drizzle_migrations')"
pass "the host is as deploys left it before the roles: superuser DATABASE_URL, everything owned by postgres, no roles, serving"

echo "==> Deploying with a vault that predates the roles"
cp ansible/vault.yml "$TH_WORK/vault.yml.current"
ansible-vault view --vault-password-file "$TH_WORK/vault-pass" ansible/vault.yml \
  | grep -v -e '^vault_postgres_owner_password:' -e '^vault_postgres_app_password:' \
  > "$TH_WORK/vault-old.yml"
ansible-vault encrypt --vault-password-file "$TH_WORK/vault-pass" \
  --output ansible/vault.yml "$TH_WORK/vault-old.yml" >/dev/null
rm -f "$TH_WORK/vault-old.yml"
if deploy -e site_address=https://localhost > "$TH_WORK/deploy-oldvault.log" 2>&1; then
  fail "a deploy went ahead with no owner or app role password in the vault"
fi
for said in vault_postgres_owner_password vault_postgres_app_password "deploy again"; do
  grep -qF "$said" "$TH_WORK/deploy-oldvault.log" \
    || fail "refusing the old vault, the deploy never said '$said': $(tail -20 "$TH_WORK/deploy-oldvault.log")"
done
[[ "$(url_user "$(container_db_url app)")" == postgres ]] \
  || fail "the refused deploy touched the running app anyway"
serving || fail "the refused deploy stopped the stack serving"
cp "$TH_WORK/vault.yml.current" ansible/vault.yml
pass "a vault without the two role passwords is refused before anything is touched, naming both and saying a deploy is the rest of the upgrade"

echo "==> Upgrading: the same deploy, with the two passwords in the vault"
deploy -e site_address=https://localhost > "$TH_WORK/deploy-upgrade.log" 2>&1 \
  || fail "the upgrade deploy failed: $(tail -30 "$TH_WORK/deploy-upgrade.log")"
await "the stack to serve after the upgrade" serving
assert_roles "after upgrading a host deployed before the roles"
[[ "$(sql_super <<<"select pg_get_userbyid(datdba) from pg_database where datname = current_database()")" == "$OWNER_ROLE" ]] \
  || fail "the upgrade left the database itself owned by someone other than $OWNER_ROLE"
[[ "$(psql_q 'select count(*) from drizzle.__drizzle_migrations')" == "$applied_before" ]] \
  || fail "the upgrade changed what drizzle records as applied ($applied_before before)"
th_ssh "$DEPLOY_USER" "test -f $APP_DIR/.env-migrations" || fail "the upgrade did not render .env-migrations"
for secret in "${DB_SECRETS[@]}"; do
  if grep -qF "$secret" "$TH_WORK/deploy-upgrade.log"; then
    fail "the upgrade deploy printed a database password (a no_log is missing)"
  fi
done
pass "one deploy upgraded the host: both roles created, everything handed to $OWNER_ROLE, the app on $APP_ROLE and serving, with nothing done in the database by hand"

echo "==> Deploy check passed"
