#!/usr/bin/env bash
# Check one generated Caddyfile: that generation left nothing behind, and that
# Caddy itself accepts the result.
#
# Usage: scripts/check_caddyfile.sh <path-to-generated-Caddyfile>
#
# Only what holds for every set of answers belongs here. Assertions about a
# particular answer — which domain, whether an ACME address was emitted — belong
# with the caller that chose those answers.
set -euo pipefail

CADDYFILE="${1:?usage: check_caddyfile.sh <path-to-generated-Caddyfile>}"

fail() { echo "FAIL: $*" >&2; exit 1; }

[[ -f "$CADDYFILE" ]] || fail "no such file: $CADDYFILE"

# A surviving Jinja tag is a Caddy syntax error that would not surface until the
# first deploy.
! grep -qE '\{%|\{\{' "$CADDYFILE" \
  || fail "unrendered Jinja in $CADDYFILE: $(grep -nE '\{%|\{\{' "$CADDYFILE" | head -3)"

# Every request has to reach the app through the proxy.
grep -q '^[[:space:]]*reverse_proxy app:3000$' "$CADDYFILE" \
  || fail "$CADDYFILE does not reverse_proxy to app:3000"

# Caddy needs the file at a path inside the container, so mount it absolute.
ABS="$(cd "$(dirname "$CADDYFILE")" && pwd)/$(basename "$CADDYFILE")"
RUN=(docker run --rm -v "$ABS:/etc/caddy/Caddyfile:ro" caddy:2-alpine)

# Caddy logs "input is not formatted" on every boot otherwise. The warning is
# easy to reintroduce, because it is Jinja whitespace that decides it.
"${RUN[@]}" caddy fmt /etc/caddy/Caddyfile | diff -u "$CADDYFILE" - \
  || fail "$CADDYFILE is not what \`caddy fmt\` produces (diff above)"

"${RUN[@]}" caddy validate --config /etc/caddy/Caddyfile \
  || fail "Caddy rejected $CADDYFILE"

echo "ok: $CADDYFILE is fully rendered, formatted and valid"
