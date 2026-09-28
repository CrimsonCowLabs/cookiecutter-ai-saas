#!/usr/bin/env bash
# Prove the production stack serves working TLS on its own.
#
# Usage: scripts/check_tls_stack.sh <generated-project-dir>
#
# docker-compose.prod.yml runs pre-built images, so the caller must have built
# the app image ("<slug>-app:latest") first.
#
# The site address is overridden to https://localhost. Caddy then issues from its
# own local CA instead of asking Let's Encrypt for a certificate for a name that
# does not resolve here, so the redirect, TLS termination and the proxy hop are
# all exercised against a certificate this script can verify. Only the issuer
# differs from a real deployment; the ACME path itself is not covered here.
#
# This rewrites .env-production and tears down volumes, so it refuses to run
# against a tree that already has one — point it at a freshly generated project.
set -euo pipefail

PROJECT_DIR="${1:?usage: check_tls_stack.sh <generated-project-dir>}"
cd "$PROJECT_DIR"

fail() { echo "FAIL: $*" >&2; exit 1; }
pass() { echo "ok: $*"; }

ENV_FILE=.env-production
ROOT_CA="$(mktemp)"
# --env-file is needed by every subcommand, not just `up`: the compose file
# interpolates POSTGRES_PASSWORD, and a bare `ps` would warn that it is unset.
# -p keeps the containers and volumes separate from anything already deployed
# out of this directory, so the teardown below cannot touch real data.
COMPOSE=(docker compose -f docker-compose.prod.yml -p tls-check --env-file "$ENV_FILE")
# What the TLS path needs. The worker and db-writer images are not on it.
SERVICES=(caddy app postgres redis)

# An `x && fail` one-liner would be wrong here: under `set -e` an AND-list whose
# left side fails takes the whole script down, so a *missing* env file would
# abort the check.
if [[ -e "$ENV_FILE" ]]; then
  fail "$PWD/$ENV_FILE exists; this check would overwrite it. Run it against a freshly generated project."
fi

# The database name is the project slug with dashes replaced. Read it out of the
# compose file rather than re-deriving it from the directory name, which is only
# the same thing until somebody renames the directory.
DB_NAME="$(sed -n 's/^ *POSTGRES_DB: *//p' docker-compose.prod.yml | head -1)"
[[ -n "$DB_NAME" ]] || fail "could not read POSTGRES_DB out of docker-compose.prod.yml"

cleanup() {
  echo "==> Tearing down"
  "${COMPOSE[@]}" down -v --remove-orphans >/dev/null 2>&1 || true
  rm -f "$ROOT_CA" "$ENV_FILE"
}

# The stack reads .env-production and mounts it into the app. Only what the app
# needs in order to boot is set; none of it is a real credential.
cat > "$ENV_FILE" <<ENV
NEXTAUTH_URL=https://localhost
NEXTAUTH_SECRET=0000000000000000000000000000000000000000000000000000000000000000
HOSTNAME=0.0.0.0
POSTGRES_USER=postgres
POSTGRES_PASSWORD=postgres
DATABASE_URL=postgresql://postgres:postgres@postgres:5432/${DB_NAME}
REDIS_URL=redis://redis:6379
ENV

# Only now that the env file exists can any compose command — including the
# teardown — run.
trap cleanup EXIT

echo "==> Bringing up the production stack (SITE_ADDRESS=https://localhost)"
export SITE_ADDRESS=https://localhost
"${COMPOSE[@]}" up -d --wait "${SERVICES[@]}"

# ── The proxy is the only thing on the host's ports ──────────────────────────
# `config` resolves the compose file to its normalised form, so this reads the
# bindings the stack actually asks the host for rather than scraping a `ps`
# table. Caddy publishes 80 and 443; nothing else publishes at all.
leaks="$("${COMPOSE[@]}" config --format json | python3 -c '
import json, sys

services = json.load(sys.stdin)["services"]


def published(name):
    return sorted(
        "%s/%s" % (p["published"], p.get("protocol", "tcp"))
        for p in services[name].get("ports") or []
    )


leaked = {n: published(n) for n in services if n != "caddy" and published(n)}
if leaked:
    print("these services publish host ports: %s" % leaked)

missing = {"80/tcp", "443/tcp"} - set(published("caddy"))
if missing:
    print("caddy does not publish %s (only %s)" % (sorted(missing), published("caddy")))
')"
[[ -z "$leaks" ]] || fail "$leaks"
pass "caddy publishes 80 and 443; no other service publishes a host port"

# Caddy provisions the certificate after the container starts, so poll rather
# than assume the first request lands after TLS is ready.
await() {
  local what="$1"
  shift
  for _ in $(seq 60); do
    if "$@" >/dev/null 2>&1; then return 0; fi
    sleep 1
  done
  fail "timed out waiting for $what"
}
await "Caddy to serve HTTPS" curl -sSk -o /dev/null --max-time 5 https://localhost/

# ── HTTP redirects to HTTPS ──────────────────────────────────────────────────
# Caddy answers on the name it was configured for, so the Host header matters.
redirect="$(curl -sS -o /dev/null -w '%{http_code} %{redirect_url}' -H 'Host: localhost' http://127.0.0.1/)" \
  || fail "no answer on plain HTTP"
redirect_status="${redirect%% *}"
redirect_target="${redirect#* }"
case "$redirect_status" in
  30[1278]) : ;;
  *) fail "expected a redirect from HTTP, got '$redirect'" ;;
esac
[[ "$redirect_target" == https://* ]] \
  || fail "HTTP redirect target is not HTTPS: '$redirect_target'"
pass "HTTP answers $redirect_status and redirects to $redirect_target"

# ── HTTPS serves the app with a certificate that verifies ────────────────────
# Caddy's local CA root — what `caddy trust` installs into a browser.
"${COMPOSE[@]}" exec -T caddy cat /data/caddy/pki/authorities/local/root.crt > "$ROOT_CA" \
  || fail "could not read Caddy's local CA root — did TLS provisioning run?"
[[ -s "$ROOT_CA" ]] || fail "Caddy's local CA root is empty"

# --cacert and no -k: a bad chain, a wrong name or an expired leaf exits non-zero.
https_status="$(curl -sS --cacert "$ROOT_CA" -o /dev/null -w '%{http_code}' https://localhost/)" \
  || fail "TLS verification failed against Caddy's own CA"
[[ "$https_status" == 200 ]] \
  || fail "expected 200 over HTTPS from the proxied app, got $https_status"
pass "HTTPS serves the proxied app (200) with a certificate that verifies"

echo "==> TLS stack check passed"
